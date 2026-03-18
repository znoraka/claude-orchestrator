//! Persistent SQLite store for session metadata, usage cache, and conversation messages.

use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;
use std::path::Path;

use crate::{SessionMeta, SessionUsage};

/// Open (or create) the orchestrator database at `data_dir/orchestrator.db`.
pub fn open_db(data_dir: &Path) -> Result<Connection> {
    let path = data_dir.join("orchestrator.db");
    let conn = Connection::open(&path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA foreign_keys=ON;

         CREATE TABLE IF NOT EXISTS sessions (
             id                          TEXT    PRIMARY KEY,
             name                        TEXT    NOT NULL DEFAULT '',
             created_at                  REAL    NOT NULL DEFAULT 0,
             last_active_at              REAL    NOT NULL DEFAULT 0,
             last_message_at             REAL    NOT NULL DEFAULT 0,
             directory                   TEXT    NOT NULL DEFAULT '',
             home_directory              TEXT,
             claude_session_id           TEXT,
             dangerously_skip_permissions INTEGER NOT NULL DEFAULT 0,
             permission_mode             TEXT,
             active_time                 REAL    NOT NULL DEFAULT 0,
             has_title_been_generated    INTEGER NOT NULL DEFAULT 0,
             provider                    TEXT,
             model                       TEXT,
             plan_content                TEXT,
             parent_session_id           TEXT,
             archived                    INTEGER,
             archived_at                 REAL
         );

         CREATE INDEX IF NOT EXISTS sessions_directory
             ON sessions(directory);
         CREATE INDEX IF NOT EXISTS sessions_last_active
             ON sessions(last_active_at DESC);

         CREATE TABLE IF NOT EXISTS conversation_messages (
             id                INTEGER PRIMARY KEY AUTOINCREMENT,
             claude_session_id TEXT    NOT NULL,
             message_id        TEXT    NOT NULL,
             message_type      TEXT    NOT NULL,
             content_json      TEXT    NOT NULL,
             seq               INTEGER NOT NULL,
             cost_usd          REAL,
             input_tokens      INTEGER,
             output_tokens     INTEGER,
             api_message_id    TEXT,
             UNIQUE(claude_session_id, message_id)
         );

         CREATE INDEX IF NOT EXISTS idx_conv_msgs_session
             ON conversation_messages(claude_session_id, seq);

         CREATE TABLE IF NOT EXISTS ingest_tracking (
             claude_session_id TEXT PRIMARY KEY,
             directory         TEXT    NOT NULL,
             byte_offset       INTEGER NOT NULL DEFAULT 0,
             jsonl_mtime       INTEGER NOT NULL DEFAULT 0,
             next_seq          INTEGER NOT NULL DEFAULT 0
         );

         CREATE TABLE IF NOT EXISTS usage_cache (
             jsonl_path                  TEXT    PRIMARY KEY,
             byte_offset                 INTEGER NOT NULL DEFAULT 0,
             jsonl_mtime                 INTEGER NOT NULL DEFAULT 0,
             input_tokens                INTEGER NOT NULL DEFAULT 0,
             output_tokens               INTEGER NOT NULL DEFAULT 0,
             cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
             cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
             cost_usd                    REAL    NOT NULL DEFAULT 0,
             context_tokens              INTEGER NOT NULL DEFAULT 0
         );",
    )?;
    Ok(conn)
}

fn map_session_row(row: &rusqlite::Row) -> rusqlite::Result<SessionMeta> {
    Ok(SessionMeta {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        last_active_at: row.get(3)?,
        last_message_at: row.get(4)?,
        directory: row.get(5)?,
        home_directory: row.get(6)?,
        claude_session_id: row.get(7)?,
        dangerously_skip_permissions: row.get::<_, bool>(8)?,
        permission_mode: row.get(9)?,
        active_time: row.get(10)?,
        has_title_been_generated: row.get::<_, bool>(11)?,
        provider: row.get(12)?,
        model: row.get(13)?,
        plan_content: row.get(14)?,
        parent_session_id: row.get(15)?,
        archived: row.get::<_, Option<bool>>(16)?,
        archived_at: row.get(17)?,
    })
}

pub fn db_load_sessions(conn: &Connection) -> Result<Vec<SessionMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, created_at, last_active_at, last_message_at, directory,
                home_directory, claude_session_id, dangerously_skip_permissions,
                permission_mode, active_time, has_title_been_generated,
                provider, model, plan_content, parent_session_id, archived, archived_at
         FROM sessions
         ORDER BY last_active_at DESC",
    )?;
    let rows = stmt.query_map([], map_session_row)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn db_load_sessions_paged(conn: &Connection, limit: usize, offset: usize) -> Result<Vec<SessionMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, created_at, last_active_at, last_message_at, directory,
                home_directory, claude_session_id, dangerously_skip_permissions,
                permission_mode, active_time, has_title_been_generated,
                provider, model, plan_content, parent_session_id, archived, archived_at
         FROM sessions
         ORDER BY last_active_at DESC
         LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![limit as i64, offset as i64], map_session_row)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn db_save_sessions(conn: &Connection, sessions: &[SessionMeta]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM sessions", [])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO sessions (
                 id, name, created_at, last_active_at, last_message_at, directory,
                 home_directory, claude_session_id, dangerously_skip_permissions,
                 permission_mode, active_time, has_title_been_generated,
                 provider, model, plan_content, parent_session_id, archived, archived_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
        )?;
        for s in sessions {
            stmt.execute(params![
                s.id, s.name, s.created_at, s.last_active_at, s.last_message_at,
                s.directory, s.home_directory, s.claude_session_id,
                s.dangerously_skip_permissions, s.permission_mode, s.active_time,
                s.has_title_been_generated, s.provider, s.model, s.plan_content,
                s.parent_session_id, s.archived, s.archived_at,
            ])?;
        }
    }
    tx.commit()
}

pub fn db_migrate_from_json(conn: &Connection, sessions: Vec<SessionMeta>) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO sessions (
                 id, name, created_at, last_active_at, last_message_at, directory,
                 home_directory, claude_session_id, dangerously_skip_permissions,
                 permission_mode, active_time, has_title_been_generated,
                 provider, model, plan_content, parent_session_id, archived, archived_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
        )?;
        for s in sessions {
            stmt.execute(params![
                s.id, s.name, s.created_at, s.last_active_at, s.last_message_at,
                s.directory, s.home_directory, s.claude_session_id,
                s.dangerously_skip_permissions, s.permission_mode, s.active_time,
                s.has_title_been_generated, s.provider, s.model, s.plan_content,
                s.parent_session_id, s.archived, s.archived_at,
            ])?;
        }
    }
    tx.commit()
}

pub fn db_get_usage_cache(
    conn: &Connection,
    jsonl_path: &str,
) -> Result<Option<(u64, SessionUsage, u64)>> {
    let mut stmt = conn.prepare(
        "SELECT byte_offset, jsonl_mtime,
                input_tokens, output_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                cost_usd, context_tokens
         FROM usage_cache WHERE jsonl_path = ?1",
    )?;

    let row = stmt
        .query_row(params![jsonl_path], |row| {
            Ok((
                row.get::<_, i64>(0)? as u64,
                row.get::<_, i64>(1)? as u64,
                SessionUsage {
                    input_tokens: row.get::<_, i64>(2)? as u64,
                    output_tokens: row.get::<_, i64>(3)? as u64,
                    cache_creation_input_tokens: row.get::<_, i64>(4)? as u64,
                    cache_read_input_tokens: row.get::<_, i64>(5)? as u64,
                    cost_usd: row.get(6)?,
                    context_tokens: row.get::<_, i64>(7)? as u64,
                    is_busy: false,
                },
            ))
        })
        .optional()?;

    Ok(row.map(|(offset, mtime, usage)| (offset, usage, mtime)))
}

// ── Conversation messages ──────────────────────────────────────────────────

/// A structured conversation message row, ready for the frontend.
#[derive(Serialize, Clone, Debug)]
pub struct ChatMessageRow {
    pub id: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub content: serde_json::Value,
    pub timestamp: f64,
    #[serde(rename = "costUsd", skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
}

/// Load all conversation messages for a session, ordered by seq.
pub fn db_get_conversation_messages(
    conn: &Connection,
    claude_session_id: &str,
) -> Result<Vec<ChatMessageRow>> {
    let mut stmt = conn.prepare(
        "SELECT message_id, message_type, content_json, seq, cost_usd, input_tokens, output_tokens
         FROM conversation_messages
         WHERE claude_session_id = ?1
         ORDER BY seq",
    )?;
    let rows = stmt.query_map(params![claude_session_id], |row| {
        let cost: Option<f64> = row.get(4)?;
        let input_tokens: Option<i64> = row.get(5)?;
        let output_tokens: Option<i64> = row.get(6)?;
        let usage = if input_tokens.is_some() || output_tokens.is_some() {
            Some(serde_json::json!({
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            }))
        } else {
            None
        };
        let content_str: String = row.get(2)?;
        let content = serde_json::from_str(&content_str).unwrap_or(serde_json::Value::Array(vec![]));
        Ok(ChatMessageRow {
            id: row.get(0)?,
            msg_type: row.get(1)?,
            content,
            timestamp: row.get::<_, i64>(3)? as f64,
            cost_usd: cost,
            usage,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Load the last N messages + total count for a session.
pub fn db_get_conversation_messages_tail(
    conn: &Connection,
    claude_session_id: &str,
    max_messages: usize,
) -> Result<(Vec<ChatMessageRow>, usize)> {
    let total: usize = conn.query_row(
        "SELECT COUNT(*) FROM conversation_messages WHERE claude_session_id = ?1",
        params![claude_session_id],
        |row| row.get::<_, usize>(0),
    )?;

    let mut stmt = conn.prepare(
        "SELECT message_id, message_type, content_json, seq, cost_usd, input_tokens, output_tokens
         FROM conversation_messages
         WHERE claude_session_id = ?1
         ORDER BY seq DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![claude_session_id, max_messages as i64], |row| {
        let cost: Option<f64> = row.get(4)?;
        let input_tokens: Option<i64> = row.get(5)?;
        let output_tokens: Option<i64> = row.get(6)?;
        let usage = if input_tokens.is_some() || output_tokens.is_some() {
            Some(serde_json::json!({
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            }))
        } else {
            None
        };
        let content_str: String = row.get(2)?;
        let content = serde_json::from_str(&content_str).unwrap_or(serde_json::Value::Array(vec![]));
        Ok(ChatMessageRow {
            id: row.get(0)?,
            msg_type: row.get(1)?,
            content,
            timestamp: row.get::<_, i64>(3)? as f64,
            cost_usd: cost,
            usage,
        })
    })?;
    let mut messages: Vec<_> = rows.filter_map(|r| r.ok()).collect();
    messages.reverse(); // Restore ascending order
    Ok((messages, total))
}

// ── Ingest tracking ───────────────────────────────────────────────────────

/// Ingest tracking state for a JSONL file.
pub struct IngestState {
    pub directory: String,
    pub byte_offset: u64,
    pub jsonl_mtime: u64,
    pub next_seq: i64,
}

pub fn db_get_ingest_tracking(
    conn: &Connection,
    claude_session_id: &str,
) -> Result<Option<IngestState>> {
    conn.query_row(
        "SELECT directory, byte_offset, jsonl_mtime, next_seq
         FROM ingest_tracking WHERE claude_session_id = ?1",
        params![claude_session_id],
        |row| {
            Ok(IngestState {
                directory: row.get(0)?,
                byte_offset: row.get::<_, i64>(1)? as u64,
                jsonl_mtime: row.get::<_, i64>(2)? as u64,
                next_seq: row.get(3)?,
            })
        },
    )
    .optional()
}

pub fn db_set_ingest_tracking(
    conn: &Connection,
    claude_session_id: &str,
    directory: &str,
    byte_offset: u64,
    jsonl_mtime: u64,
    next_seq: i64,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO ingest_tracking (
             claude_session_id, directory, byte_offset, jsonl_mtime, next_seq
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            claude_session_id,
            directory,
            byte_offset as i64,
            jsonl_mtime as i64,
            next_seq,
        ],
    )?;
    Ok(())
}

pub fn db_delete_conversation_messages(
    conn: &Connection,
    claude_session_id: &str,
) -> Result<()> {
    conn.execute(
        "DELETE FROM conversation_messages WHERE claude_session_id = ?1",
        params![claude_session_id],
    )?;
    Ok(())
}

// ── Usage cache ───────────────────────────────────────────────────────────

pub fn db_set_usage_cache(
    conn: &Connection,
    jsonl_path: &str,
    byte_offset: u64,
    mtime: u64,
    usage: &SessionUsage,
) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO usage_cache (
             jsonl_path, byte_offset, jsonl_mtime,
             input_tokens, output_tokens,
             cache_creation_input_tokens, cache_read_input_tokens,
             cost_usd, context_tokens
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            jsonl_path,
            byte_offset as i64,
            mtime as i64,
            usage.input_tokens as i64,
            usage.output_tokens as i64,
            usage.cache_creation_input_tokens as i64,
            usage.cache_read_input_tokens as i64,
            usage.cost_usd,
            usage.context_tokens as i64,
        ],
    )?;
    Ok(())
}
