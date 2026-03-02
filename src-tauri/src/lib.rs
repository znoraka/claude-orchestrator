mod clipboard_image;
mod file_watcher;
mod pty_manager;

use file_watcher::JsonlWatcher;
use pty_manager::PtyManager;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::{AppHandle, Manager, State};

/// Cached result for a JSONL file, invalidated when mtime changes.
struct CachedEntry<T> {
    mtime: SystemTime,
    value: T,
}

/// Incremental cache entry for usage: tracks byte offset so we only parse new lines.
struct IncrementalUsageEntry {
    byte_offset: u64,
    value: SessionUsage,
}

/// Caches expensive JSONL parsing results, keyed by file path.
struct JsonlCache {
    usage: HashMap<PathBuf, IncrementalUsageEntry>,
    title: HashMap<PathBuf, CachedEntry<Option<String>>>,
}

impl JsonlCache {
    fn new() -> Self {
        Self {
            usage: HashMap::new(),
            title: HashMap::new(),
        }
    }
}

/// Per-model pricing: (input, output, cache_create, cache_read) per 1M tokens.
#[derive(Serialize, Deserialize, Clone)]
struct ModelPricing {
    input: f64,
    output: f64,
    cache_create: f64,
    cache_read: f64,
}

/// Pricing config loaded from disk, keyed by model substring match.
#[derive(Serialize, Deserialize, Clone)]
struct PricingConfig {
    /// Ordered list of (model_contains_substring, pricing).
    /// First match wins, so put more specific patterns first.
    models: Vec<(String, ModelPricing)>,
}

impl Default for PricingConfig {
    fn default() -> Self {
        Self {
            models: vec![
                ("opus".to_string(), ModelPricing { input: 15.0, output: 75.0, cache_create: 18.75, cache_read: 1.50 }),
                ("haiku".to_string(), ModelPricing { input: 0.80, output: 4.0, cache_create: 1.0, cache_read: 0.08 }),
                ("sonnet".to_string(), ModelPricing { input: 3.0, output: 15.0, cache_create: 3.75, cache_read: 0.30 }),
            ],
        }
    }
}

impl PricingConfig {
    /// Load from ~/.claude-orchestrator/pricing.json, falling back to defaults.
    fn load() -> Self {
        if let Ok(home) = std::env::var("HOME") {
            let path = PathBuf::from(&home)
                .join(".claude-orchestrator")
                .join("pricing.json");
            if let Ok(data) = std::fs::read_to_string(&path) {
                if let Ok(config) = serde_json::from_str::<PricingConfig>(&data) {
                    return config;
                }
                eprintln!("[pricing] Failed to parse {:?}, using defaults", path);
            }
        }
        PricingConfig::default()
    }

    /// Look up pricing for a model string. Falls back to Sonnet pricing.
    fn lookup(&self, model: &str) -> (f64, f64, f64, f64) {
        for (pattern, p) in &self.models {
            if model.contains(pattern.as_str()) {
                return (p.input, p.output, p.cache_create, p.cache_read);
            }
        }
        // Fallback: Sonnet pricing
        (3.0, 15.0, 3.75, 0.30)
    }
}

struct AppState {
    pty_manager: Mutex<PtyManager>,
    jsonl_cache: Mutex<JsonlCache>,
    pricing: PricingConfig,
    file_watcher: Mutex<JsonlWatcher>,
}

#[derive(Serialize, Deserialize, Clone)]
struct SessionMeta {
    id: String,
    name: String,
    #[serde(rename = "createdAt")]
    created_at: f64,
    #[serde(rename = "lastActiveAt")]
    last_active_at: f64,
    #[serde(default)]
    directory: String,
    #[serde(default, rename = "claudeSessionId", skip_serializing_if = "Option::is_none")]
    claude_session_id: Option<String>,
    #[serde(default, rename = "dangerouslySkipPermissions")]
    dangerously_skip_permissions: bool,
}

fn sessions_path(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    Ok(dir.join("sessions.json"))
}

#[tauri::command]
fn save_sessions(app_handle: AppHandle, sessions: Vec<SessionMeta>) -> Result<(), String> {
    let path = sessions_path(&app_handle)?;
    let json = serde_json::to_string_pretty(&sessions)
        .map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(path, json).map_err(|e| format!("Write error: {}", e))?;
    Ok(())
}

#[tauri::command]
fn load_sessions(app_handle: AppHandle) -> Result<Vec<SessionMeta>, String> {
    let path = sessions_path(&app_handle)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    let sessions: Vec<SessionMeta> =
        serde_json::from_str(&data).map_err(|e| format!("Parse error: {}", e))?;
    Ok(sessions)
}

#[tauri::command]
fn create_pty_session(
    session_id: String,
    directory: String,
    claude_session_id: Option<String>,
    resume: bool,
    #[allow(non_snake_case)] dangerouslySkipPermissions: Option<bool>,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let skip_perms = dangerouslySkipPermissions.unwrap_or(false);
    eprintln!("[create_pty_session] session_id={}, directory={:?}, claude_session_id={:?}, resume={}, skip_permissions={}", session_id, directory, claude_session_id, resume, skip_perms);
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.create_session(&session_id, app_handle, directory, claude_session_id, resume, skip_perms)
}

#[tauri::command]
fn write_to_pty(session_id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.write_to_session(&session_id, &data)
}

#[tauri::command]
fn resize_pty(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.resize_session(&session_id, cols, rows)
}

#[tauri::command]
fn destroy_pty_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.destroy_session(&session_id)
}

#[tauri::command]
fn get_pty_scrollback(session_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.get_scrollback(&session_id)
}

#[tauri::command]
fn list_directories(partial: String) -> Result<Vec<String>, String> {
    let expanded = if partial.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            partial.replacen('~', &home, 1)
        } else {
            partial.clone()
        }
    } else {
        partial.clone()
    };

    let path = std::path::Path::new(&expanded);

    // Determine the parent to list and the prefix to filter by
    let (dir, prefix) = if path.is_dir() && expanded.ends_with('/') {
        (path.to_path_buf(), String::new())
    } else {
        let parent = path.parent().unwrap_or(std::path::Path::new("/"));
        let prefix = path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        (parent.to_path_buf(), prefix)
    };

    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Read dir error: {}", e))?;

    let home = std::env::var("HOME").unwrap_or_default();
    let mut results: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().map(|ft| ft.is_dir()).unwrap_or(false)
                && !e
                    .file_name()
                    .to_string_lossy()
                    .starts_with('.')
        })
        .filter(|e| {
            prefix.is_empty()
                || e.file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with(&prefix.to_lowercase())
        })
        .map(|e| {
            let full = e.path().to_string_lossy().to_string();
            if !home.is_empty() && full.starts_with(&home) {
                format!("~{}", &full[home.len()..])
            } else {
                full
            }
        })
        .collect();

    results.sort();
    results.truncate(50);
    Ok(results)
}

/// Resolve a JSONL path from session ID and directory.
fn jsonl_path_for(claude_session_id: &str, directory: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    let expanded_dir = if directory.starts_with('~') {
        directory.replacen('~', &home, 1)
    } else {
        directory.to_string()
    };
    let trimmed_dir = expanded_dir.trim_end_matches('/');
    let encoded_path = trimmed_dir.replace('/', "-");
    Ok(PathBuf::from(&home)
        .join(".claude")
        .join("projects")
        .join(&encoded_path)
        .join(format!("{}.jsonl", claude_session_id)))
}

/// Get the mtime of a file, or None if it doesn't exist.
fn file_mtime(path: &std::path::Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

fn parse_conversation_title(jsonl_path: &std::path::Path) -> Result<Option<String>, String> {
    let file = std::fs::File::open(jsonl_path)
        .map_err(|e| format!("Failed to open conversation file: {}", e))?;
    let reader = std::io::BufReader::new(file);

    use std::io::BufRead;
    for line in reader.lines() {
        let line = line.map_err(|e| format!("Read error: {}", e))?;
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            if parsed.get("type").and_then(|t| t.as_str()) == Some("user") {
                if let Some(content) = parsed
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if content.starts_with("<command-message>") {
                        continue;
                    }
                    let title: String = content.chars().take(60).collect();
                    let title = if content.chars().count() > 60 {
                        format!("{}…", title.trim_end())
                    } else {
                        title
                    };
                    return Ok(Some(title));
                }
            }
        }
    }
    Ok(None)
}

#[tauri::command]
fn get_conversation_title(
    claude_session_id: String,
    directory: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;

    let mtime = match file_mtime(&jsonl_path) {
        Some(t) => t,
        None => return Ok(None),
    };

    // Check cache
    {
        let cache = state.jsonl_cache.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = cache.title.get(&jsonl_path) {
            if entry.mtime == mtime {
                return Ok(entry.value.clone());
            }
        }
    }

    let result = parse_conversation_title(&jsonl_path)?;

    // Update cache
    {
        let mut cache = state.jsonl_cache.lock().map_err(|e| e.to_string())?;
        cache.title.insert(jsonl_path, CachedEntry { mtime, value: result.clone() });
    }

    Ok(result)
}

#[derive(Serialize, Clone, Default)]
struct SessionUsage {
    #[serde(rename = "inputTokens")]
    input_tokens: u64,
    #[serde(rename = "outputTokens")]
    output_tokens: u64,
    #[serde(rename = "cacheCreationInputTokens")]
    cache_creation_input_tokens: u64,
    #[serde(rename = "cacheReadInputTokens")]
    cache_read_input_tokens: u64,
    #[serde(rename = "costUsd")]
    cost_usd: f64,
    #[serde(rename = "isBusy")]
    is_busy: bool,
}

/// Check if the LLM is currently busy by finding the last "user" or "assistant"
/// entry in the JSONL file. Other types (system, progress, queue-operation, etc.)
/// are ignored. If the last relevant entry is "user", Claude is thinking.
fn is_session_busy(jsonl_path: &std::path::Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = match std::fs::File::open(jsonl_path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return false,
    };
    if len == 0 {
        return false;
    }

    // Read last 64KB — more than enough for recent entries
    let start = if len > 65536 { len - 65536 } else { 0 };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return false;
    }

    // Walk lines in reverse, find the last "user" or "assistant" entry
    for line in buf.lines().rev() {
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
            match parsed.get("type").and_then(|t| t.as_str()) {
                Some("user") => return true,
                Some("assistant") => return false,
                _ => continue,
            }
        }
    }
    false
}

/// Parse usage from a JSONL file starting at `byte_offset`.
/// Returns the accumulated usage and the new byte offset.
fn parse_session_usage_incremental(
    jsonl_path: &std::path::Path,
    byte_offset: u64,
    base_usage: &SessionUsage,
    pricing: &PricingConfig,
) -> Result<(SessionUsage, u64), String> {
    use std::io::{BufRead, Seek, SeekFrom};

    let mut file = std::fs::File::open(jsonl_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let file_len = file.metadata()
        .map_err(|e| format!("Failed to get metadata: {}", e))?
        .len();

    // If file hasn't grown (or shrank), return cached value
    if file_len <= byte_offset {
        return Ok((base_usage.clone(), byte_offset));
    }

    file.seek(SeekFrom::Start(byte_offset))
        .map_err(|e| format!("Seek error: {}", e))?;

    let reader = std::io::BufReader::new(file);
    let mut usage = base_usage.clone();

    for line in reader.lines() {
        let line = line.map_err(|e| format!("Read error: {}", e))?;
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            if parsed.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                let msg = parsed.get("message");
                let model = msg
                    .and_then(|m| m.get("model"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("");

                if let Some(u) = msg.and_then(|m| m.get("usage")) {
                    let inp = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let out = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let cc = u.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let cr = u.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);

                    usage.input_tokens += inp;
                    usage.output_tokens += out;
                    usage.cache_creation_input_tokens += cc;
                    usage.cache_read_input_tokens += cr;

                    let (ip, op, cp, rp) = pricing.lookup(model);
                    usage.cost_usd += (inp as f64 * ip
                        + out as f64 * op
                        + cc as f64 * cp
                        + cr as f64 * rp)
                        / 1_000_000.0;
                }
            }
        }
    }

    Ok((usage, file_len))
}

#[tauri::command]
fn get_session_usage(
    claude_session_id: String,
    directory: String,
    state: State<'_, AppState>,
) -> Result<SessionUsage, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;

    if !jsonl_path.exists() {
        return Ok(SessionUsage::default());
    }

    // Get current offset and base usage from cache (or start from scratch)
    let (byte_offset, base_usage) = {
        let cache = state.jsonl_cache.lock().map_err(|e| e.to_string())?;
        match cache.usage.get(&jsonl_path) {
            Some(entry) => (entry.byte_offset, entry.value.clone()),
            None => (0, SessionUsage::default()),
        }
    };

    let (mut usage, new_offset) = parse_session_usage_incremental(
        &jsonl_path,
        byte_offset,
        &base_usage,
        &state.pricing,
    )?;

    // Check if LLM is currently busy (last entry is not "assistant")
    usage.is_busy = is_session_busy(&jsonl_path);

    // Update cache with new offset
    if new_offset != byte_offset {
        let mut cache = state.jsonl_cache.lock().map_err(|e| e.to_string())?;
        cache.usage.insert(jsonl_path, IncrementalUsageEntry {
            byte_offset: new_offset,
            value: usage.clone(),
        });
    }

    Ok(usage)
}

/// Compute cost from a single JSONL file, only counting entries from today.
fn usage_from_jsonl(path: &std::path::Path, today: &str, pricing: &PricingConfig) -> (f64, u64) {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (0.0, 0),
    };
    let reader = std::io::BufReader::new(file);
    let mut cost = 0.0;
    let mut tokens = 0u64;
    use std::io::BufRead;
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            if parsed.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            // Check timestamp starts with today's date
            if let Some(ts) = parsed.get("timestamp").and_then(|t| t.as_str()) {
                if !ts.starts_with(today) {
                    continue;
                }
            } else {
                continue;
            }
            let msg = parsed.get("message");
            let model = msg
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
                .unwrap_or("");
            if let Some(u) = msg.and_then(|m| m.get("usage")) {
                let inp = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let out = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cc = u.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cr = u.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                tokens += inp + out + cc + cr;
                let (ip, op, cp, rp) = pricing.lookup(model);
                cost += (inp as f64 * ip + out as f64 * op + cc as f64 * cp + cr as f64 * rp)
                    / 1_000_000.0;
            }
        }
    }
    (cost, tokens)
}

#[derive(Serialize, Clone)]
struct TodayUsageSummary {
    #[serde(rename = "costUsd")]
    cost_usd: f64,
    #[serde(rename = "totalTokens")]
    total_tokens: u64,
}

#[tauri::command]
fn get_total_usage_today(state: State<'_, AppState>) -> Result<TodayUsageSummary, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    let projects_dir = std::path::PathBuf::from(&home)
        .join(".claude")
        .join("projects");

    if !projects_dir.exists() {
        return Ok(TodayUsageSummary { cost_usd: 0.0, total_tokens: 0 });
    }

    // Today's date in UTC (matching JSONL timestamp format)
    let today = {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // Format as YYYY-MM-DD using chrono-free approach
        let secs_per_day = 86400u64;
        // Get local midnight by using local offset
        // Simple approach: use the current date from timestamp
        let days = now / secs_per_day;
        let y;
        let m;
        let d;
        // Civil date from days since epoch (algorithm from Howard Hinnant)
        {
            let z = days as i64 + 719468;
            let era = if z >= 0 { z } else { z - 146096 } / 146097;
            let doe = (z - era * 146097) as u64;
            let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
            y = yoe as i64 + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            d = doy - (153 * mp + 2) / 5 + 1;
            m = if mp < 10 { mp + 3 } else { mp - 9 };
        }
        let year = if m <= 2 { y + 1 } else { y };
        format!("{:04}-{:02}-{:02}", year, m, d)
    };

    let mut total_cost = 0.0;
    let mut total_tokens = 0u64;

    // Walk all project subdirectories
    let project_entries = std::fs::read_dir(&projects_dir)
        .map_err(|e| format!("Read projects dir: {}", e))?;

    for project_entry in project_entries.flatten() {
        if !project_entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let session_entries = match std::fs::read_dir(project_entry.path()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in session_entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // Skip files not modified today (quick filter before parsing)
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    let age = std::time::SystemTime::now()
                        .duration_since(modified)
                        .unwrap_or_default();
                    if age.as_secs() > 86400 {
                        continue;
                    }
                }
            }
            let (cost, tokens) = usage_from_jsonl(&path, &today, &state.pricing);
            total_cost += cost;
            total_tokens += tokens;
        }
    }

    Ok(TodayUsageSummary { cost_usd: total_cost, total_tokens })
}

#[tauri::command]
fn generate_smart_title(claude_session_id: String, directory: String) -> Result<Option<String>, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;

    if !jsonl_path.exists() {
        return Ok(None);
    }

    let file = std::fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open conversation file: {}", e))?;
    let reader = std::io::BufReader::new(file);

    let mut first_user_message: Option<String> = None;
    let mut first_assistant_text: Option<String> = None;

    use std::io::BufRead;
    for line in reader.lines() {
        let line = line.map_err(|e| format!("Read error: {}", e))?;
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            let msg_type = parsed.get("type").and_then(|t| t.as_str());

            if msg_type == Some("user") && first_user_message.is_none() {
                if let Some(content) = parsed
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if content.starts_with("<command-message>") {
                        continue;
                    }
                    first_user_message = Some(content.chars().take(500).collect());
                }
            }

            if msg_type == Some("assistant") && first_user_message.is_some() && first_assistant_text.is_none() {
                if let Some(content) = parsed.get("message").and_then(|m| m.get("content")) {
                    // content can be a string or an array of content blocks
                    let text = if let Some(s) = content.as_str() {
                        Some(s.to_string())
                    } else if let Some(arr) = content.as_array() {
                        // Find the first text block
                        arr.iter().find_map(|block| {
                            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                block.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                            } else {
                                None
                            }
                        })
                    } else {
                        None
                    };
                    if let Some(t) = text {
                        first_assistant_text = Some(t.chars().take(500).collect());
                    }
                }
            }

            if first_user_message.is_some() && first_assistant_text.is_some() {
                break;
            }
        }
    }

    let (user_msg, assistant_msg) = match (first_user_message, first_assistant_text) {
        (Some(u), Some(a)) => (u, a),
        _ => return Ok(None),
    };

    let prompt = format!(
        "Summarize this conversation in 3-6 words as a short title. Reply with ONLY the title, nothing else.\n\nUser: {}\nAssistant: {}",
        user_msg, assistant_msg
    );

    let output = std::process::Command::new("claude")
        .args(["-p", "--model", "haiku", &prompt])
        .output()
        .map_err(|e| format!("Failed to run claude CLI: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "claude CLI failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let title = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if title.is_empty() {
        return Ok(None);
    }

    Ok(Some(title))
}

#[derive(Serialize, Clone)]
struct TranscriptMessage {
    role: String,
    text: String,
    timestamp: String,
}

#[tauri::command]
fn get_session_transcript(claude_session_id: String, directory: String) -> Result<Vec<TranscriptMessage>, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;

    if !jsonl_path.exists() {
        return Ok(vec![]);
    }

    let file = std::fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open transcript file: {}", e))?;
    let reader = std::io::BufReader::new(file);

    let mut messages = Vec::new();

    use std::io::BufRead;
    for line in reader.lines() {
        let line = line.map_err(|e| format!("Read error: {}", e))?;
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            let msg_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let timestamp = parsed.get("timestamp").and_then(|t| t.as_str()).unwrap_or("").to_string();

            if msg_type == "user" {
                if let Some(content) = parsed
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if content.starts_with("<command-message>") {
                        continue;
                    }
                    let text: String = content.chars().take(2000).collect();
                    messages.push(TranscriptMessage {
                        role: "user".to_string(),
                        text,
                        timestamp,
                    });
                }
            } else if msg_type == "assistant" {
                if let Some(content) = parsed.get("message").and_then(|m| m.get("content")) {
                    let text = if let Some(s) = content.as_str() {
                        Some(s.to_string())
                    } else if let Some(arr) = content.as_array() {
                        let parts: Vec<String> = arr.iter().filter_map(|block| {
                            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                block.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                            } else {
                                None
                            }
                        }).collect();
                        if parts.is_empty() { None } else { Some(parts.join("\n")) }
                    } else {
                        None
                    };
                    if let Some(t) = text {
                        let truncated: String = t.chars().take(2000).collect();
                        messages.push(TranscriptMessage {
                            role: "assistant".to_string(),
                            text: truncated,
                            timestamp,
                        });
                    }
                }
            }
        }
    }

    Ok(messages)
}

#[tauri::command]
fn watch_jsonl(
    claude_session_id: String,
    directory: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = jsonl_path_for(&claude_session_id, &directory)?;
    let mut watcher = state.file_watcher.lock().map_err(|e| e.to_string())?;
    watcher.watch(path)
}

#[tauri::command]
fn unwatch_jsonl(
    claude_session_id: String,
    directory: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = jsonl_path_for(&claude_session_id, &directory)?;
    let mut watcher = state.file_watcher.lock().map_err(|e| e.to_string())?;
    watcher.unwatch(&path)
}

#[tauri::command]
fn save_clipboard_image(base64_data: String) -> Result<String, String> {
    clipboard_image::save_image_from_base64(&base64_data)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let watcher = JsonlWatcher::new(app.handle().clone())
                .expect("Failed to create file watcher");
            app.manage(AppState {
                pty_manager: Mutex::new(PtyManager::new()),
                jsonl_cache: Mutex::new(JsonlCache::new()),
                pricing: PricingConfig::load(),
                file_watcher: Mutex::new(watcher),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_pty_session,
            write_to_pty,
            resize_pty,
            destroy_pty_session,
            get_pty_scrollback,
            save_clipboard_image,
            save_sessions,
            load_sessions,
            list_directories,
            get_conversation_title,
            get_session_usage,
            get_total_usage_today,
            generate_smart_title,
            get_session_transcript,
            watch_jsonl,
            unwatch_jsonl,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
