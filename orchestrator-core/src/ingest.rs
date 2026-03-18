//! Background JSONL → SQLite ingest for conversation messages.
//!
//! Watches for JSONL file changes and incrementally parses new lines into
//! structured `conversation_messages` rows in the database.

use rusqlite::{params, Connection};
use serde_json::Value;
use std::io::{BufRead, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::commands::jsonl_path_for;
use crate::db::{
    db_delete_conversation_messages, db_get_ingest_tracking, db_set_ingest_tracking,
};

// ── Message parsing ───────────────────────────────────────────────────────

const MAX_TEXT: usize = 20_000;
const IMAGE_PATH_RE: &str = r"^(/[^\n]*(?:claude-orchestrator[^/]*images|\.claude-orchestrator/images)/[a-f0-9-]+\.[a-z]+)$";

struct IngestedMessage {
    message_id: String,
    message_type: String,
    content_json: String,
    api_message_id: Option<String>,
    cost_usd: Option<f64>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

/// Normalize content field: string → [{type: "text", text: ...}], array → as-is.
fn normalize_content(raw: &Value) -> Option<Vec<Value>> {
    match raw {
        Value::Array(arr) => Some(arr.clone()),
        Value::String(s) => Some(vec![serde_json::json!({"type": "text", "text": s})]),
        _ => None,
    }
}

/// Truncate text blocks longer than MAX_TEXT.
fn truncate_text_blocks(blocks: &mut Vec<Value>) {
    for block in blocks.iter_mut() {
        if let Some(Value::String(text)) = block.get_mut("text") {
            if text.len() > MAX_TEXT {
                let end = text
                    .char_indices()
                    .nth(MAX_TEXT)
                    .map(|(i, _)| i)
                    .unwrap_or(text.len());
                text.truncate(end);
                text.push_str("\n…[truncated]");
            }
        }
    }
}

fn looks_like_background_task_notification(text: &str) -> bool {
    // Pattern: "someid\ntoolu_..." with "completed" somewhere
    if !text.contains("completed") {
        return false;
    }
    let re = regex::Regex::new(r"^[a-z0-9]+\ntoolu_").unwrap();
    re.is_match(text)
}

fn looks_like_task_prompt(text: &str) -> bool {
    if text.len() < 50 {
        return false;
    }
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() < 3 {
        return false;
    }
    let has_instructional = text.contains("Focus on")
        || text.contains("I need to understand")
        || text.contains("Return file paths")
        || text.contains("Return the")
        || text.contains("Do not")
        || text.contains("Make sure to")
        || regex::Regex::new(r"(?i)thoroughly|comprehensive|investigate|explore|search")
            .unwrap()
            .is_match(text);

    let has_numbered_list = regex::Regex::new(r"(?m)^\s*\d+\.\s").unwrap().is_match(text)
        && regex::Regex::new(r"(?m)^\s*[2-9]\.\s").unwrap().is_match(text);

    has_instructional && (has_numbered_list || lines.len() >= 5)
}

/// Parse image paths from text lines, producing ContentBlock-style values.
fn parse_content_with_images(raw: &str) -> Vec<Value> {
    let re = regex::Regex::new(IMAGE_PATH_RE).unwrap();
    let mut blocks = Vec::new();
    let mut text_lines: Vec<&str> = Vec::new();

    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(caps) = re.captures(trimmed) {
            let text = text_lines.join("\n");
            let text = text.trim();
            if !text.is_empty() {
                blocks.push(serde_json::json!({"type": "text", "text": text}));
            }
            text_lines.clear();
            blocks.push(serde_json::json!({
                "type": "image",
                "source": {"type": "local-file", "path": caps.get(1).unwrap().as_str()}
            }));
        } else {
            text_lines.push(line);
        }
    }

    let trailing = text_lines.join("\n");
    let trailing = trailing.trim();
    if !trailing.is_empty() {
        blocks.push(serde_json::json!({"type": "text", "text": trailing}));
    }

    if blocks.is_empty() {
        vec![serde_json::json!({"type": "text", "text": raw})]
    } else {
        blocks
    }
}

fn parse_user_message(raw: &Value, seq: i64) -> Option<IngestedMessage> {
    let message = raw.get("message")?;
    let raw_content = message.get("content")?;

    let blocks = if let Value::String(s) = raw_content {
        parse_content_with_images(s)
    } else if let Value::Array(arr) = raw_content {
        arr.clone()
    } else {
        return None;
    };

    // Skip messages that are only tool_results
    let has_tool_results = blocks
        .iter()
        .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"));
    if has_tool_results {
        return None;
    }

    // Filter out system-reminder blocks
    let visible_blocks: Vec<Value> = blocks
        .into_iter()
        .filter(|b| {
            if let Some(text) = b.get("text").and_then(|t| t.as_str()) {
                !text.trim_start().starts_with("<system-reminder>")
            } else {
                true
            }
        })
        .collect();

    if visible_blocks.is_empty() {
        return None;
    }

    // Extract combined text for heuristic checks
    let combined_text: String = visible_blocks
        .iter()
        .filter_map(|b| {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                b.get("text").and_then(|t| t.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    if looks_like_background_task_notification(&combined_text) {
        return None;
    }

    if looks_like_task_prompt(&combined_text) {
        return None;
    }

    let mut content = visible_blocks;
    truncate_text_blocks(&mut content);

    Some(IngestedMessage {
        message_id: format!("user-{}", seq),
        message_type: "user".to_string(),
        content_json: serde_json::to_string(&content).unwrap_or_default(),
        api_message_id: None,
        cost_usd: None,
        input_tokens: None,
        output_tokens: None,
    })
}

fn parse_assistant_message(raw: &Value, seq: i64) -> Option<IngestedMessage> {
    let message_obj = raw.get("message")?;
    let raw_content = message_obj.get("content")?;
    let mut content = normalize_content(raw_content)?;

    if content.is_empty() {
        return None;
    }

    let api_message_id = message_obj
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("anon-{}", seq));

    truncate_text_blocks(&mut content);

    Some(IngestedMessage {
        message_id: api_message_id.clone(),
        message_type: "assistant".to_string(),
        content_json: serde_json::to_string(&content).unwrap_or_default(),
        api_message_id: Some(api_message_id),
        cost_usd: None,
        input_tokens: None,
        output_tokens: None,
    })
}

fn parse_result_message(raw: &Value, seq: i64) -> Option<IngestedMessage> {
    let result_text = raw
        .get("result")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let cost_usd = raw.get("cost_usd").and_then(|v| v.as_f64());
    let usage = raw.get("usage");
    let input_tokens = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(|v| v.as_i64());
    let output_tokens = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(|v| v.as_i64());

    Some(IngestedMessage {
        message_id: format!("result-{}", seq),
        message_type: "result".to_string(),
        content_json: serde_json::to_string(&vec![serde_json::json!({"type": "text", "text": result_text})])
            .unwrap_or_default(),
        api_message_id: None,
        cost_usd,
        input_tokens,
        output_tokens,
    })
}

fn parse_error_message(raw: &Value, seq: i64) -> Option<IngestedMessage> {
    let error_text = raw
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown error");

    Some(IngestedMessage {
        message_id: format!("error-{}", seq),
        message_type: "error".to_string(),
        content_json: serde_json::to_string(&vec![serde_json::json!({"type": "text", "text": error_text})])
            .unwrap_or_default(),
        api_message_id: None,
        cost_usd: None,
        input_tokens: None,
        output_tokens: None,
    })
}

// ── Assistant message merging ─────────────────────────────────────────────

/// Merge new content blocks into existing ones for the same assistant message.
/// Replicates the logic from parseHistoryLines in constants.ts:
/// - tool_use blocks: dedup by block.id, replace if same ID exists
/// - text blocks: replace trailing text (if after last tool_use), else append
fn merge_assistant_content(existing: &mut Vec<Value>, new_blocks: &[Value]) {
    for block in new_blocks {
        let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");

        if block_type == "tool_use" {
            let block_id = block.get("id").and_then(|v| v.as_str());
            if let Some(bid) = block_id {
                if let Some(idx) = existing.iter().position(|b| {
                    b.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                        && b.get("id").and_then(|v| v.as_str()) == Some(bid)
                }) {
                    existing[idx] = block.clone();
                    continue;
                }
            }
            existing.push(block.clone());
        } else if block_type == "text" {
            // Find last text and last tool_use indices
            let mut last_text_idx: Option<usize> = None;
            let mut last_tool_use_idx: Option<usize> = None;
            for (k, b) in existing.iter().enumerate().rev() {
                let bt = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if last_text_idx.is_none() && bt == "text" {
                    last_text_idx = Some(k);
                }
                if last_tool_use_idx.is_none() && bt == "tool_use" {
                    last_tool_use_idx = Some(k);
                }
                if last_text_idx.is_some() && last_tool_use_idx.is_some() {
                    break;
                }
            }

            // Replace trailing text block only if it comes after the last tool_use
            let should_replace = match (last_text_idx, last_tool_use_idx) {
                (Some(ti), Some(tui)) => ti > tui,
                (Some(_), None) => true, // text exists but no tool_use — it's trailing
                _ => false,
            };

            if should_replace {
                if let Some(idx) = last_text_idx {
                    existing[idx] = block.clone();
                    continue;
                }
            }
            existing.push(block.clone());
        } else {
            existing.push(block.clone());
        }
    }
}

// ── Core ingest function ──────────────────────────────────────────────────

/// Incrementally ingest new JSONL lines into the database.
/// Returns the number of new/updated messages.
pub fn ingest_jsonl_to_db(
    conn: &Connection,
    claude_session_id: &str,
    directory: &str,
) -> Result<usize, String> {
    let jsonl_path = jsonl_path_for(claude_session_id, directory)?;
    if !jsonl_path.exists() {
        return Ok(0);
    }

    let file_meta = std::fs::metadata(&jsonl_path)
        .map_err(|e| format!("Failed to get metadata: {}", e))?;
    let file_len = file_meta.len();
    let file_mtime = file_meta
        .modified()
        .map_err(|e| format!("Failed to get mtime: {}", e))?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Load tracking state
    let tracking = db_get_ingest_tracking(conn, claude_session_id)
        .map_err(|e| format!("Failed to get ingest tracking: {}", e))?;

    let (byte_offset, mut next_seq) = match &tracking {
        Some(t) => {
            // If file was truncated (shrunk), reset
            if file_len < t.byte_offset {
                db_delete_conversation_messages(conn, claude_session_id)
                    .map_err(|e| format!("Failed to delete messages: {}", e))?;
                (0u64, 0i64)
            } else if t.jsonl_mtime == file_mtime && t.byte_offset >= file_len {
                // File unchanged
                return Ok(0);
            } else {
                // If byte_offset is 0 but next_seq > 0 it means finalize()
                // failed to read file metadata (race / missing file) and fell
                // back to (0, 0).  Reset next_seq to 0 so we re-ingest from
                // the beginning with seq 0, producing message_ids user-0,
                // user-1, … which conflict on the UNIQUE(session_id, message_id)
                // constraint and are safely replaced — no duplicate rows.
                let seq = if t.byte_offset == 0 && t.next_seq > 0 {
                    0
                } else {
                    t.next_seq
                };
                (t.byte_offset, seq)
            }
        }
        None => (0u64, 0i64),
    };

    // Nothing new to read
    if byte_offset >= file_len {
        return Ok(0);
    }

    // Read new lines
    let mut file = std::fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open JSONL: {}", e))?;
    file.seek(SeekFrom::Start(byte_offset))
        .map_err(|e| format!("Failed to seek: {}", e))?;

    let reader = std::io::BufReader::new(file);

    const WANTED: &[&str] = &[
        "\"type\":\"user\"",
        "\"type\": \"user\"",
        "\"type\":\"assistant\"",
        "\"type\": \"assistant\"",
        "\"type\":\"result\"",
        "\"type\": \"result\"",
        "\"type\":\"error\"",
        "\"type\": \"error\"",
    ];

    let mut new_offset = byte_offset;
    let mut count = 0usize;

    // Collect messages to insert, then batch in a transaction
    struct PendingInsert {
        msg: IngestedMessage,
        seq: i64,
    }
    let mut pending: Vec<PendingInsert> = Vec::new();
    // Track assistant messages we've already seen (for merging)
    // Key: api_message_id, Value: index in pending vec (or None if already in DB)
    let mut assistant_pending_idx: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| format!("Read error: {}", e))?;
        new_offset += line.len() as u64 + 1;

        if line.is_empty() || !WANTED.iter().any(|w| line.contains(w)) {
            continue;
        }

        let raw: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let msg_type = raw.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match msg_type {
            "user" => {
                if let Some(msg) = parse_user_message(&raw, next_seq) {
                    pending.push(PendingInsert { msg, seq: next_seq });
                    next_seq += 1;
                    count += 1;
                }
            }
            "assistant" => {
                if let Some(msg) = parse_assistant_message(&raw, next_seq) {
                    let api_id = msg.api_message_id.clone().unwrap_or_default();

                    // Check if we have a pending insert for this api_message_id
                    if let Some(&idx) = assistant_pending_idx.get(&api_id) {
                        // Merge into existing pending message
                        let existing_msg = &mut pending[idx].msg;
                        let mut existing_content: Vec<Value> =
                            serde_json::from_str(&existing_msg.content_json).unwrap_or_default();
                        let new_content: Vec<Value> =
                            serde_json::from_str(&msg.content_json).unwrap_or_default();
                        merge_assistant_content(&mut existing_content, &new_content);
                        existing_msg.content_json =
                            serde_json::to_string(&existing_content).unwrap_or_default();
                        count += 1;
                    } else {
                        // Check if already in DB (from previous ingest)
                        let existing_in_db: Option<(i64, String)> = conn
                            .query_row(
                                "SELECT id, content_json FROM conversation_messages
                                 WHERE claude_session_id = ?1 AND api_message_id = ?2",
                                params![claude_session_id, api_id],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            )
                            .ok();

                        if let Some((db_id, existing_json)) = existing_in_db {
                            // Merge with existing DB row
                            let mut existing_content: Vec<Value> =
                                serde_json::from_str(&existing_json).unwrap_or_default();
                            let new_content: Vec<Value> =
                                serde_json::from_str(&msg.content_json).unwrap_or_default();
                            merge_assistant_content(&mut existing_content, &new_content);
                            let merged_json =
                                serde_json::to_string(&existing_content).unwrap_or_default();

                            // We'll update this in the transaction
                            // For now, store a special marker
                            pending.push(PendingInsert {
                                msg: IngestedMessage {
                                    message_id: format!("__update_db_id_{}", db_id),
                                    content_json: merged_json,
                                    ..msg
                                },
                                seq: -1, // marker: this is an update, not insert
                            });
                            count += 1;
                        } else {
                            // New assistant message
                            let idx = pending.len();
                            assistant_pending_idx.insert(api_id, idx);
                            pending.push(PendingInsert { msg, seq: next_seq });
                            next_seq += 1;
                            count += 1;
                        }
                    }
                }
            }
            "result" => {
                if let Some(msg) = parse_result_message(&raw, next_seq) {
                    pending.push(PendingInsert { msg, seq: next_seq });
                    next_seq += 1;
                    count += 1;
                }
            }
            "error" => {
                if let Some(msg) = parse_error_message(&raw, next_seq) {
                    pending.push(PendingInsert { msg, seq: next_seq });
                    next_seq += 1;
                    count += 1;
                }
            }
            _ => {}
        }
    }

    if pending.is_empty() && new_offset == byte_offset {
        return Ok(0);
    }

    // Batch insert/update in a transaction
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("Transaction error: {}", e))?;

    for p in &pending {
        if p.seq == -1 {
            // This is an update to an existing DB row
            if let Some(db_id_str) = p.msg.message_id.strip_prefix("__update_db_id_") {
                if let Ok(db_id) = db_id_str.parse::<i64>() {
                    tx.execute(
                        "UPDATE conversation_messages SET content_json = ?1 WHERE id = ?2",
                        params![p.msg.content_json, db_id],
                    )
                    .map_err(|e| format!("Update error: {}", e))?;
                }
            }
        } else {
            tx.execute(
                "INSERT OR REPLACE INTO conversation_messages (
                     claude_session_id, message_id, message_type, content_json, seq,
                     cost_usd, input_tokens, output_tokens, api_message_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    claude_session_id,
                    p.msg.message_id,
                    p.msg.message_type,
                    p.msg.content_json,
                    p.seq,
                    p.msg.cost_usd,
                    p.msg.input_tokens,
                    p.msg.output_tokens,
                    p.msg.api_message_id,
                ],
            )
            .map_err(|e| format!("Insert error: {}", e))?;
        }
    }

    // Update tracking
    db_set_ingest_tracking(&tx, claude_session_id, directory, new_offset, file_mtime, next_seq)
        .map_err(|e| format!("Failed to update tracking: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Commit error: {}", e))?;

    Ok(count)
}

// ── Live ingestor (for bridge stdout → DB) ────────────────────────────────

/// Ingests bridge output lines directly into the DB without going through
/// JSONL file watching.  Created once per agent session and fed lines from
/// the stdout reader thread.
pub struct LiveIngestor {
    db: Arc<Mutex<Connection>>,
    claude_session_id: String,
    directory: String,
    next_seq: i64,
    /// Track assistant messages we've seen, for merging streaming chunks.
    /// Key: api_message_id → (db_row_id or pending content, accumulated content).
    assistant_content: std::collections::HashMap<String, Vec<Value>>,
}

impl LiveIngestor {
    pub fn new(
        db: Arc<Mutex<Connection>>,
        claude_session_id: String,
        directory: String,
    ) -> Self {
        // Load existing seq from ingest_tracking so we don't collide with
        // messages ingested from the JSONL file watcher on startup.
        let next_seq = {
            if let Ok(conn) = db.lock() {
                db_get_ingest_tracking(&conn, &claude_session_id)
                    .ok()
                    .flatten()
                    .map(|t| t.next_seq)
                    .unwrap_or(0)
            } else {
                0
            }
        };

        Self {
            db,
            claude_session_id,
            directory,
            next_seq,
            assistant_content: std::collections::HashMap::new(),
        }
    }

    /// Ingest a single bridge output line.  Returns `true` if a message was
    /// inserted/updated (caller should emit `MessagesIngested`).
    pub fn ingest_line(&mut self, line: &str) -> bool {
        const WANTED: &[&str] = &[
            "\"type\":\"user\"",
            "\"type\": \"user\"",
            "\"type\":\"assistant\"",
            "\"type\": \"assistant\"",
            "\"type\":\"result\"",
            "\"type\": \"result\"",
            "\"type\":\"error\"",
            "\"type\": \"error\"",
        ];

        if line.is_empty() || !WANTED.iter().any(|w| line.contains(w)) {
            return false;
        }

        let raw: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return false,
        };

        let msg_type = raw.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match msg_type {
            "user" => self.ingest_user(&raw),
            "assistant" => self.ingest_assistant(&raw),
            "result" => self.ingest_simple(&raw, "result"),
            "error" => self.ingest_simple(&raw, "error"),
            _ => false,
        }
    }

    fn ingest_user(&mut self, raw: &Value) -> bool {
        let msg = match parse_user_message(raw, self.next_seq) {
            Some(m) => m,
            None => return false,
        };
        if self.insert_message(&msg) {
            self.next_seq += 1;
            true
        } else {
            false
        }
    }

    fn ingest_assistant(&mut self, raw: &Value) -> bool {
        let msg = match parse_assistant_message(raw, self.next_seq) {
            Some(m) => m,
            None => return false,
        };
        let api_id = msg.api_message_id.clone().unwrap_or_default();
        let new_content: Vec<Value> =
            serde_json::from_str(&msg.content_json).unwrap_or_default();

        if let Some(existing) = self.assistant_content.get_mut(&api_id) {
            // Merge into accumulated content
            merge_assistant_content(existing, &new_content);
            let merged_json = serde_json::to_string(existing).unwrap_or_default();

            // Update DB row in place
            if let Ok(conn) = self.db.lock() {
                let _ = conn.execute(
                    "UPDATE conversation_messages SET content_json = ?1
                     WHERE claude_session_id = ?2 AND api_message_id = ?3",
                    params![merged_json, self.claude_session_id, api_id],
                );
            }
            true
        } else {
            // New assistant message — insert and start tracking
            self.assistant_content
                .insert(api_id, new_content);
            if self.insert_message(&msg) {
                self.next_seq += 1;
                true
            } else {
                false
            }
        }
    }

    fn ingest_simple(&mut self, raw: &Value, kind: &str) -> bool {
        let msg = match kind {
            "result" => parse_result_message(raw, self.next_seq),
            "error" => parse_error_message(raw, self.next_seq),
            _ => None,
        };
        let msg = match msg {
            Some(m) => m,
            None => return false,
        };
        if self.insert_message(&msg) {
            self.next_seq += 1;
            true
        } else {
            false
        }
    }

    fn insert_message(&self, msg: &IngestedMessage) -> bool {
        let conn = match self.db.lock() {
            Ok(c) => c,
            Err(_) => return false,
        };
        conn.execute(
            "INSERT OR REPLACE INTO conversation_messages (
                 claude_session_id, message_id, message_type, content_json, seq,
                 cost_usd, input_tokens, output_tokens, api_message_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                self.claude_session_id,
                msg.message_id,
                msg.message_type,
                msg.content_json,
                self.next_seq,
                msg.cost_usd,
                msg.input_tokens,
                msg.output_tokens,
                msg.api_message_id,
            ],
        )
        .is_ok()
    }

    /// Update ingest tracking so the JSONL file watcher doesn't re-parse
    /// lines we've already ingested.  Call this when the session ends.
    pub fn finalize(&self) {
        if let Ok(conn) = self.db.lock() {
            // Read the actual JSONL file size and mtime so the file watcher
            // knows we've already processed everything up to this point.
            let jsonl_path = match jsonl_path_for(&self.claude_session_id, &self.directory) {
                Ok(p) => p,
                Err(_) => return,
            };
            let (byte_offset, mtime) = match std::fs::metadata(&jsonl_path) {
                Ok(meta) => {
                    let len = meta.len();
                    let mtime = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    (len, mtime)
                }
                // Can't stat the file (e.g. not yet flushed to disk, or
                // never created because no messages were written).  Don't
                // write a (0, 0) offset into tracking — that would cause
                // ingest_jsonl_to_db to re-scan from the beginning on the
                // next startup with a stale next_seq, generating duplicate
                // message IDs.  Leave whatever tracking entry exists intact;
                // the next startup will handle it safely via the seq-reset
                // guard in ingest_jsonl_to_db.
                Err(_) => return,
            };
            let _ = db_set_ingest_tracking(
                &conn,
                &self.claude_session_id,
                &self.directory,
                byte_offset,
                mtime,
                self.next_seq,
            );
        }
    }
}

// ── Background ingest listener ────────────────────────────────────────────

/// Spawn a background task that listens for `JsonlChanged` events and ingests.
pub fn spawn_ingest_listener(
    db: Arc<Mutex<Connection>>,
    event_tx: crate::EventSender,
    mut event_rx: tokio::sync::broadcast::Receiver<crate::ServerEvent>,
) {
    tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(crate::ServerEvent::JsonlChanged { path }) => {
                    // Extract claude_session_id from filename
                    let p = Path::new(&path);
                    let claude_session_id = match p.file_stem().and_then(|s| s.to_str()) {
                        Some(id) => id.to_string(),
                        None => continue,
                    };

                    // Look up directory from sessions table
                    let directory = {
                        let conn = match db.lock() {
                            Ok(c) => c,
                            Err(_) => continue,
                        };
                        conn.query_row(
                            "SELECT directory FROM sessions WHERE claude_session_id = ?1 LIMIT 1",
                            params![claude_session_id],
                            |row| row.get::<_, String>(0),
                        )
                        .ok()
                    };

                    let Some(directory) = directory else {
                        continue;
                    };

                    // Perform ingest
                    let ingested = {
                        let conn = match db.lock() {
                            Ok(c) => c,
                            Err(_) => continue,
                        };
                        ingest_jsonl_to_db(&conn, &claude_session_id, &directory)
                    };

                    match ingested {
                        Ok(n) if n > 0 => {
                            event_tx.emit(crate::ServerEvent::MessagesIngested {
                                claude_session_id,
                            });
                        }
                        Err(e) => {
                            eprintln!("[ingest] Error for {}: {}", claude_session_id, e);
                        }
                        _ => {}
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[ingest] Lagged by {} events", n);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
                _ => {}
            }
        }
    });
}

/// Ingest all known sessions on startup (for those that have JSONL files but no DB rows).
pub fn ingest_all_sessions(db: &Arc<Mutex<Connection>>) {
    let sessions: Vec<(String, String)> = {
        let conn = match db.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut stmt = match conn.prepare(
            "SELECT claude_session_id, directory FROM sessions
             WHERE claude_session_id IS NOT NULL AND claude_session_id != ''",
        ) {
            Ok(s) => s,
            Err(_) => return,
        };
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    };

    for (claude_session_id, directory) in sessions {
        let conn = match db.lock() {
            Ok(c) => c,
            Err(_) => continue,
        };
        match ingest_jsonl_to_db(&conn, &claude_session_id, &directory) {
            Ok(n) if n > 0 => {
                eprintln!(
                    "[ingest] Startup: ingested {} messages for {}",
                    n, claude_session_id
                );
            }
            Err(e) => {
                eprintln!("[ingest] Startup error for {}: {}", claude_session_id, e);
            }
            _ => {}
        }
    }
}
