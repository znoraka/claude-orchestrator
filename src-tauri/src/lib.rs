mod clipboard_image;
mod file_watcher;
mod pty_manager;
mod signal_watcher;

use file_watcher::JsonlWatcher;
use pty_manager::PtyManager;
use signal_watcher::SignalWatcher;
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
    _signal_watcher: SignalWatcher,
    mcp_script_path: Option<String>,
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
    #[serde(default, rename = "homeDirectory", skip_serializing_if = "Option::is_none")]
    home_directory: Option<String>,
    #[serde(default, rename = "claudeSessionId", skip_serializing_if = "Option::is_none")]
    claude_session_id: Option<String>,
    #[serde(default, rename = "dangerouslySkipPermissions")]
    dangerously_skip_permissions: bool,
    #[serde(default, rename = "activeTime")]
    active_time: f64,
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
    manager.create_session(&session_id, app_handle, directory, claude_session_id, resume, skip_perms, state.mcp_script_path.clone())
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
fn create_shell_pty_session(
    session_id: String,
    directory: String,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    eprintln!("[create_shell_pty_session] session_id={}, directory={:?}", session_id, directory);
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.create_shell_session(&session_id, app_handle, directory)
}

#[tauri::command]
fn directory_exists(path: String) -> bool {
    let expanded = if path.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            path.replacen('~', &home, 1)
        } else {
            path
        }
    } else {
        path
    };
    std::path::Path::new(&expanded).is_dir()
}

#[tauri::command]
fn destroy_pty_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.destroy_session(&session_id)
}

#[tauri::command]
fn get_pty_scrollback(session_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let data = manager.get_scrollback(&session_id)?;
    eprintln!("[get_pty_scrollback] session_id={}, scrollback_len={}", session_id, data.len());
    Ok(data)
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

#[derive(Serialize, Clone)]
struct WorktreeInfo {
    path: String,
    branch: String,
    #[serde(rename = "isMain")]
    is_main: bool,
}

#[tauri::command]
fn list_worktrees(directory: String) -> Result<Vec<WorktreeInfo>, String> {
    let expanded = if directory.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            directory.replacen('~', &home, 1)
        } else {
            directory.clone()
        }
    } else {
        directory.clone()
    };

    let output = std::process::Command::new("git")
        .current_dir(&expanded)
        .env("PATH", shell_path())
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let home = std::env::var("HOME").unwrap_or_default();

    // Parse porcelain output: blocks separated by blank lines
    // Each block has: worktree <path>\nHEAD <sha>\nbranch <ref>\n
    let mut worktrees: Vec<WorktreeInfo> = Vec::new();
    let mut is_first = true;

    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in stdout.lines() {
        if line.is_empty() {
            // End of block
            if let Some(path) = current_path.take() {
                if !std::path::Path::new(&path).is_dir() {
                    current_branch = None;
                    is_first = false;
                    continue;
                }
                let branch = current_branch.take().unwrap_or_default();
                let display_path = if !home.is_empty() && path.starts_with(&home) {
                    format!("~{}", &path[home.len()..])
                } else {
                    path
                };
                worktrees.push(WorktreeInfo {
                    path: display_path,
                    branch,
                    is_main: is_first,
                });
                is_first = false;
            }
            current_branch = None;
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.to_string());
        } else if let Some(branch_ref) = line.strip_prefix("branch ") {
            // refs/heads/main -> main
            current_branch = Some(
                branch_ref
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch_ref)
                    .to_string(),
            );
        }
    }
    // Handle last block (porcelain output may not end with blank line)
    if let Some(path) = current_path.take() {
        if std::path::Path::new(&path).is_dir() {
            let branch = current_branch.take().unwrap_or_default();
            let display_path = if !home.is_empty() && path.starts_with(&home) {
                format!("~{}", &path[home.len()..])
            } else {
                path
            };
            worktrees.push(WorktreeInfo {
                path: display_path,
                branch,
                is_main: is_first,
            });
        }
    }

    Ok(worktrees)
}

#[tauri::command]
fn create_worktree(
    directory: String,
    branch_name: String,
    worktree_name: Option<String>,
) -> Result<String, String> {
    let expanded = if directory.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            directory.replacen('~', &home, 1)
        } else {
            directory.clone()
        }
    } else {
        directory.clone()
    };

    let name = worktree_name.unwrap_or_else(|| branch_name.replace('/', "-"));
    let worktree_path = std::path::Path::new(&expanded)
        .join(".worktrees")
        .join(&name);

    // Create .worktrees directory if needed
    let worktrees_dir = std::path::Path::new(&expanded).join(".worktrees");
    std::fs::create_dir_all(&worktrees_dir)
        .map_err(|e| format!("Failed to create .worktrees dir: {}", e))?;

    // Try creating with a new branch first
    let output = std::process::Command::new("git")
        .current_dir(&expanded)
        .env("PATH", shell_path())
        .args([
            "worktree",
            "add",
            &worktree_path.to_string_lossy(),
            "-b",
            &branch_name,
        ])
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        // Branch might already exist, try without -b
        let output2 = std::process::Command::new("git")
            .current_dir(&expanded)
            .env("PATH", shell_path())
            .args([
                "worktree",
                "add",
                &worktree_path.to_string_lossy(),
                &branch_name,
            ])
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output2.status.success() {
            let err = String::from_utf8_lossy(&output2.stderr);
            return Err(format!("git worktree add failed: {}", err.trim()));
        }
    }

    let home = std::env::var("HOME").unwrap_or_default();
    let result = worktree_path.to_string_lossy().to_string();
    if !home.is_empty() && result.starts_with(&home) {
        Ok(format!("~{}", &result[home.len()..]))
    } else {
        Ok(result)
    }
}

#[tauri::command]
fn remove_worktree(path: String) -> Result<(), String> {
    let expanded = if path.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            path.replacen('~', &home, 1)
        } else {
            path.clone()
        }
    } else {
        path.clone()
    };

    let output = std::process::Command::new("git")
        .current_dir(&expanded)
        .env("PATH", shell_path())
        .args(["worktree", "remove", &expanded, "--force"])
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree remove failed: {}", err.trim()));
    }

    Ok(())
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

/// Extract the text from a user message content field, which can be a string
/// or an array of content blocks like [{type: "text", text: "..."}].
fn extract_user_text(content: &serde_json::Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
}

fn parse_conversation_title(jsonl_path: &std::path::Path) -> Result<Option<String>, String> {
    let file = std::fs::File::open(jsonl_path)
        .map_err(|e| format!("Failed to open conversation file: {}", e))?;
    let reader = std::io::BufReader::new(file);

    let mut first_command: Option<String> = None;

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
                {
                    if let Some(text) = extract_user_text(content) {
                        if text.starts_with("<command-message>") {
                            // Save first command name as fallback
                            if first_command.is_none() {
                                // Extract from <command-name>/name</command-name>
                                if let Some(start) = text.find("<command-name>") {
                                    let after = &text[start + 14..];
                                    if let Some(end) = after.find("</command-name>") {
                                        first_command = Some(after[..end].to_string());
                                    }
                                }
                            }
                            continue;
                        }
                        let title: String = text.chars().take(60).collect();
                        let title = if text.chars().count() > 60 {
                            format!("{}…", title.trim_end())
                        } else {
                            title
                        };
                        return Ok(Some(title));
                    }
                }
            }
        }
    }
    // Fall back to command name if only commands were found
    Ok(first_command)
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

/// Convert seconds since Unix epoch to a civil date string (YYYY-MM-DD).
/// Algorithm from Howard Hinnant.
fn civil_date_from_epoch(epoch_secs: u64) -> String {
    let days = epoch_secs / 86400;
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", year, m, d)
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
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let today = civil_date_from_epoch(now_secs);

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

#[derive(Serialize, Clone)]
struct DailyUsage {
    date: String,
    #[serde(rename = "costUsd")]
    cost_usd: f64,
    #[serde(rename = "totalTokens")]
    total_tokens: u64,
    #[serde(rename = "inputTokens")]
    input_tokens: u64,
    #[serde(rename = "outputTokens")]
    output_tokens: u64,
}

#[derive(Serialize, Clone)]
struct ProjectUsage {
    directory: String,
    #[serde(rename = "costUsd")]
    cost_usd: f64,
    #[serde(rename = "totalTokens")]
    total_tokens: u64,
    #[serde(rename = "sessionCount")]
    session_count: u32,
}

/// Parse usage from a JSONL file, bucketing by date.
/// Returns a map of date -> (cost, input_tokens, output_tokens).
fn usage_by_date_from_jsonl(
    path: &std::path::Path,
    pricing: &PricingConfig,
) -> HashMap<String, (f64, u64, u64)> {
    let mut buckets: HashMap<String, (f64, u64, u64)> = HashMap::new();
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return buckets,
    };
    let reader = std::io::BufReader::new(file);
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
            let date = match parsed.get("timestamp").and_then(|t| t.as_str()) {
                Some(ts) if ts.len() >= 10 => ts[..10].to_string(),
                _ => continue,
            };
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
                let (ip, op, cp, rp) = pricing.lookup(model);
                let cost = (inp as f64 * ip + out as f64 * op + cc as f64 * cp + cr as f64 * rp)
                    / 1_000_000.0;
                let entry = buckets.entry(date).or_insert((0.0, 0, 0));
                entry.0 += cost;
                entry.1 += inp + cc + cr;
                entry.2 += out;
            }
        }
    }
    buckets
}

#[derive(Serialize, Clone)]
struct UsageDashboard {
    history: Vec<DailyUsage>,
    projects: Vec<ProjectUsage>,
}

#[tauri::command]
async fn get_usage_dashboard(days: u32, state: State<'_, AppState>) -> Result<UsageDashboard, String> {
    let pricing = state.pricing.clone();
    tauri::async_runtime::spawn_blocking(move || {
        compute_usage_dashboard(days, &pricing)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn compute_usage_dashboard(days: u32, pricing: &PricingConfig) -> Result<UsageDashboard, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    let projects_dir = PathBuf::from(&home).join(".claude").join("projects");
    if !projects_dir.exists() {
        return Ok(UsageDashboard { history: vec![], projects: vec![] });
    }

    let max_age_secs = days as u64 * 86400;
    let mut date_map: HashMap<String, (f64, u64, u64)> = HashMap::new();
    let mut projects: Vec<ProjectUsage> = Vec::new();

    let project_entries = std::fs::read_dir(&projects_dir)
        .map_err(|e| format!("Read projects dir: {}", e))?;

    for project_entry in project_entries.flatten() {
        if !project_entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let folder_name = project_entry.file_name().to_string_lossy().to_string();
        let decoded_dir = if folder_name.starts_with('-') {
            folder_name.replacen('-', "/", 1).replace('-', "/")
        } else {
            folder_name.clone()
        };

        let mut project_cost = 0.0;
        let mut project_tokens = 0u64;
        let mut session_count = 0u32;

        let session_entries = match std::fs::read_dir(project_entry.path()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in session_entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            session_count += 1;

            // Check if file is recent enough for the history chart
            let is_recent = entry.metadata().ok().and_then(|m| m.modified().ok()).map_or(false, |modified| {
                SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or_default()
                    .as_secs() <= max_age_secs
            });

            let buckets = usage_by_date_from_jsonl(&path, pricing);
            for (date, (cost, inp, out)) in &buckets {
                project_cost += cost;
                project_tokens += inp + out;
                if is_recent {
                    let entry = date_map.entry(date.clone()).or_insert((0.0, 0, 0));
                    entry.0 += cost;
                    entry.1 += inp;
                    entry.2 += out;
                }
            }
        }

        if session_count > 0 {
            projects.push(ProjectUsage {
                directory: decoded_dir,
                cost_usd: project_cost,
                total_tokens: project_tokens,
                session_count,
            });
        }
    }

    // Build history
    let now_secs = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let cutoff_date = civil_date_from_epoch(now_secs.saturating_sub(max_age_secs));
    let mut history: Vec<DailyUsage> = date_map
        .into_iter()
        .filter(|(date, _)| *date >= cutoff_date)
        .map(|(date, (cost, inp, out))| DailyUsage {
            date,
            cost_usd: cost,
            total_tokens: inp + out,
            input_tokens: inp,
            output_tokens: out,
        })
        .collect();
    history.sort_by(|a, b| a.date.cmp(&b.date));

    projects.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));

    Ok(UsageDashboard { history, projects })
}

#[tauri::command]
fn get_message_count(claude_session_id: String, directory: String) -> Result<u32, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;
    if !jsonl_path.exists() {
        return Ok(0);
    }
    let file = std::fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let reader = std::io::BufReader::new(file);
    let mut count = 0u32;
    use std::io::BufRead;
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }
        // Quick check before full parse
        if line.contains("\"type\":\"user\"") || line.contains("\"type\": \"user\"") {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                if parsed.get("type").and_then(|t| t.as_str()) == Some("user") {
                    count += 1;
                }
            }
        }
    }
    Ok(count)
}

#[tauri::command]
fn generate_smart_title(claude_session_id: String, directory: String, include_recent: Option<bool>) -> Result<Option<String>, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;

    if !jsonl_path.exists() {
        return Ok(None);
    }

    let file = std::fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open conversation file: {}", e))?;
    let reader = std::io::BufReader::new(file);

    let mut first_user_message: Option<String> = None;
    let mut first_assistant_text: Option<String> = None;
    // Collect all exchanges for recent context
    let mut all_exchanges: Vec<(String, String)> = Vec::new(); // (role, text)

    use std::io::BufRead;
    for line in reader.lines() {
        let line = line.map_err(|e| format!("Read error: {}", e))?;
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            let msg_type = parsed.get("type").and_then(|t| t.as_str());

            if msg_type == Some("user") {
                if let Some(content) = parsed
                    .get("message")
                    .and_then(|m| m.get("content"))
                {
                    if let Some(text) = extract_user_text(content) {
                        if text.starts_with("<command-message>") {
                            continue;
                        }
                        let truncated: String = text.chars().take(500).collect();
                        if first_user_message.is_none() {
                            first_user_message = Some(truncated.clone());
                        }
                        all_exchanges.push(("user".to_string(), truncated));
                    }
                }
            }

            if msg_type == Some("assistant") {
                if let Some(content) = parsed.get("message").and_then(|m| m.get("content")) {
                    let text = if let Some(s) = content.as_str() {
                        Some(s.to_string())
                    } else if let Some(arr) = content.as_array() {
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
                        let truncated: String = t.chars().take(500).collect();
                        if first_user_message.is_some() && first_assistant_text.is_none() {
                            first_assistant_text = Some(truncated.clone());
                        }
                        all_exchanges.push(("assistant".to_string(), truncated));
                    }
                }
            }

            // If not including recent, break early
            if !include_recent.unwrap_or(false)
                && first_user_message.is_some()
                && first_assistant_text.is_some()
            {
                break;
            }
        }
    }

    let (user_msg, assistant_msg) = match (first_user_message, first_assistant_text) {
        (Some(u), Some(a)) => (u, a),
        _ => return Ok(None),
    };

    let prompt = if include_recent.unwrap_or(false) && all_exchanges.len() > 2 {
        // Include first exchange + last 2-3 exchanges
        let recent_start = all_exchanges.len().saturating_sub(3);
        let mut recent_text = String::new();
        for (role, text) in &all_exchanges[recent_start..] {
            let truncated: String = text.chars().take(200).collect();
            recent_text.push_str(&format!("\n{}: {}", if role == "user" { "User" } else { "Assistant" }, truncated));
        }
        format!(
            "Summarize this conversation in 3-6 words as a short title. The conversation has evolved, so consider the recent messages too. Reply with ONLY the title, nothing else.\n\nFirst exchange:\nUser: {}\nAssistant: {}\n\nRecent messages:{}",
            user_msg, assistant_msg, recent_text
        )
    } else {
        format!(
            "Summarize this conversation in 3-6 words as a short title. Reply with ONLY the title, nothing else.\n\nUser: {}\nAssistant: {}",
            user_msg, assistant_msg
        )
    };

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
struct ConversationMessage {
    role: String,
    text: String,
    timestamp: String,
}

#[tauri::command]
fn get_session_conversation(claude_session_id: String, directory: String) -> Result<Vec<ConversationMessage>, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;

    if !jsonl_path.exists() {
        return Ok(vec![]);
    }

    let file = std::fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open conversation file: {}", e))?;
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
                {
                    if let Some(user_text) = extract_user_text(content) {
                        if user_text.starts_with("<command-message>") {
                            continue;
                        }
                        let text: String = user_text.chars().take(2000).collect();
                        messages.push(ConversationMessage {
                            role: "user".to_string(),
                            text,
                            timestamp,
                        });
                    }
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
                        messages.push(ConversationMessage {
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

#[derive(Deserialize)]
struct SearchableSession {
    #[serde(rename = "claudeSessionId")]
    claude_session_id: String,
    directory: String,
}

#[tauri::command]
fn search_session_content(
    sessions: Vec<SearchableSession>,
    query: String,
) -> Result<Vec<String>, String> {
    use grep_regex::RegexMatcherBuilder;
    use grep_searcher::sinks::UTF8;
    use grep_searcher::SearcherBuilder;

    let pattern = regex::escape(&query);
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(true)
        .build(&pattern)
        .map_err(|e| format!("Invalid search pattern: {}", e))?;

    let mut matched_ids = Vec::new();

    for session in &sessions {
        let jsonl_path = match jsonl_path_for(&session.claude_session_id, &session.directory) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !jsonl_path.exists() {
            continue;
        }

        let mut found = false;
        let mut searcher = SearcherBuilder::new().build();
        let _ = searcher.search_path(
            &matcher,
            &jsonl_path,
            UTF8(|_line_num, _line| {
                found = true;
                Ok(false) // stop after first match
            }),
        );

        if found {
            matched_ids.push(session.claude_session_id.clone());
        }
    }

    Ok(matched_ids)
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

/// Resolve the full PATH from the user's login shell so that GUI-spawned
/// processes can find tools like `git` installed via Homebrew, nix, etc.
fn shell_path() -> &'static str {
    use std::sync::OnceLock;
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        std::process::Command::new(&shell)
            .args(["-lc", "echo $PATH"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    })
}

fn gh_command() -> std::process::Command {
    let mut cmd = std::process::Command::new("gh");
    cmd.env("PATH", shell_path());
    cmd
}

#[derive(Serialize, Deserialize, Clone)]
struct GhPrAuthor {
    login: String,
}

#[derive(Deserialize)]
struct GhPrReview {
    author: GhPrAuthor,
    state: String,
}

#[derive(Deserialize)]
struct GhCheckRun {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

#[derive(Deserialize)]
struct GhPr {
    number: u32,
    title: String,
    url: String,
    state: String,
    #[serde(rename = "isDraft")]
    is_draft: bool,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    author: GhPrAuthor,
    #[serde(default)]
    reviews: Vec<GhPrReview>,
    #[serde(rename = "statusCheckRollup", default)]
    status_check_rollup: Vec<GhCheckRun>,
}

#[derive(Serialize, Clone)]
struct PullRequest {
    number: u32,
    title: String,
    url: String,
    state: String,
    #[serde(rename = "isDraft")]
    is_draft: bool,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    author: String,
    #[serde(rename = "authorAvatar")]
    author_avatar: String,
    #[serde(rename = "hasMyApproval")]
    has_my_approval: bool,
    #[serde(rename = "hasMyComment")]
    has_my_comment: bool,
    #[serde(rename = "checksTotal")]
    checks_total: usize,
    #[serde(rename = "checksPassing")]
    checks_passing: usize,
    #[serde(rename = "checksFailing")]
    checks_failing: usize,
    #[serde(rename = "checksPending")]
    checks_pending: usize,
    checks: Vec<CheckInfo>,
}

#[derive(Serialize, Clone)]
struct CheckInfo {
    name: String,
    status: String, // "pass", "fail", "pending"
}

#[derive(Serialize)]
struct PullRequestsResult {
    #[serde(rename = "reviewRequested")]
    review_requested: Vec<PullRequest>,
    #[serde(rename = "myPrs")]
    my_prs: Vec<PullRequest>,
    #[serde(rename = "ghAvailable")]
    gh_available: bool,
    error: Option<String>,
}

impl PullRequest {
    fn from_gh(pr: GhPr, current_user: &str) -> Self {
        let has_my_approval = pr.reviews.iter().any(|r| {
            r.author.login.eq_ignore_ascii_case(current_user) && r.state == "APPROVED"
        });
        let has_my_comment = pr.reviews.iter().any(|r| {
            r.author.login.eq_ignore_ascii_case(current_user)
                && (r.state == "COMMENTED" || r.state == "CHANGES_REQUESTED")
        });
        let checks: Vec<CheckInfo> = pr.status_check_rollup.iter().map(|c| {
            let name = c.name.clone().or_else(|| c.context.clone()).unwrap_or_else(|| "unknown".to_string());
            // CheckRun uses conclusion (SUCCESS/FAILURE/...), StatusContext uses state (SUCCESS/FAILURE/...)
            let conclusion = c.conclusion.as_deref().or(c.state.as_deref()).unwrap_or("");
            let status_field = c.status.as_deref().unwrap_or("");
            let status = if conclusion.eq_ignore_ascii_case("SUCCESS")
                || conclusion.eq_ignore_ascii_case("NEUTRAL")
                || conclusion.eq_ignore_ascii_case("SKIPPED")
            {
                "pass"
            } else if conclusion.eq_ignore_ascii_case("FAILURE")
                || conclusion.eq_ignore_ascii_case("TIMED_OUT")
                || conclusion.eq_ignore_ascii_case("CANCELLED")
                || conclusion.eq_ignore_ascii_case("ERROR")
            {
                "fail"
            } else if status_field.eq_ignore_ascii_case("COMPLETED") {
                // completed but no recognized conclusion
                "pass"
            } else {
                "pending"
            };
            CheckInfo { name, status: status.to_string() }
        }).collect();

        let checks_total = checks.len();
        let checks_passing = checks.iter().filter(|c| c.status == "pass").count();
        let checks_failing = checks.iter().filter(|c| c.status == "fail").count();
        let checks_pending = checks.iter().filter(|c| c.status == "pending").count();

        Self {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            state: pr.state,
            is_draft: pr.is_draft,
            updated_at: pr.updated_at,
            head_ref_name: pr.head_ref_name,
            author_avatar: format!("https://github.com/{}.png?size=40", pr.author.login),
            author: pr.author.login,
            has_my_approval,
            has_my_comment,
            checks_total,
            checks_passing,
            checks_failing,
            checks_pending,
            checks,
        }
    }
}

fn gh_in_dir(directory: &str) -> std::process::Command {
    let expanded = if directory.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            directory.replacen('~', &home, 1)
        } else {
            directory.to_string()
        }
    } else {
        directory.to_string()
    };
    let mut cmd = std::process::Command::new("gh");
    cmd.current_dir(&expanded);
    cmd.env("PATH", shell_path());
    cmd
}

#[tauri::command]
async fn get_pull_requests(directory: String) -> PullRequestsResult {
    tauri::async_runtime::spawn_blocking(move || get_pull_requests_sync(&directory)).await.unwrap_or_else(|_| PullRequestsResult {
        review_requested: vec![],
        my_prs: vec![],
        gh_available: false,
        error: Some("Internal error".to_string()),
    })
}

fn get_pull_requests_sync(directory: &str) -> PullRequestsResult {
    // Check if gh is installed and authenticated
    let auth_check = gh_command()
        .args(["auth", "status"])
        .output();

    match auth_check {
        Err(_) => {
            return PullRequestsResult {
                review_requested: vec![],
                my_prs: vec![],
                gh_available: false,
                error: Some("GitHub CLI (gh) is not installed. Install it from https://cli.github.com".to_string()),
            };
        }
        Ok(output) if !output.status.success() => {
            return PullRequestsResult {
                review_requested: vec![],
                my_prs: vec![],
                gh_available: false,
                error: Some("Not authenticated with GitHub CLI. Run `gh auth login` to authenticate.".to_string()),
            };
        }
        _ => {}
    }

    // Get current GitHub user login
    let current_user = gh_command()
        .args(["api", "user", "--jq", ".login"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    let json_fields = "number,title,url,state,isDraft,updatedAt,headRefName,author,reviews,statusCheckRollup";

    let review_prs = gh_in_dir(directory)
        .args(["pr", "list", "--search", "involves:@me -author:@me", "--state=open",
               &format!("--json={}", json_fields), "--limit=30"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                serde_json::from_slice::<Vec<GhPr>>(&o.stdout).ok()
            } else {
                None
            }
        })
        .unwrap_or_default()
        .into_iter()
        .map(|pr| PullRequest::from_gh(pr, &current_user))
        .collect();

    let my_prs = gh_in_dir(directory)
        .args(["pr", "list", "--author=@me", "--state=open",
               &format!("--json={}", json_fields), "--limit=30"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                serde_json::from_slice::<Vec<GhPr>>(&o.stdout).ok()
            } else {
                None
            }
        })
        .unwrap_or_default()
        .into_iter()
        .map(|pr| PullRequest::from_gh(pr, &current_user))
        .collect();

    PullRequestsResult {
        review_requested: review_prs,
        my_prs,
        gh_available: true,
        error: None,
    }
}

#[tauri::command]
async fn checkout_pr(directory: String, pr_number: u32) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = gh_in_dir(&directory)
            .args(["pr", "checkout", &pr_number.to_string()])
            .output()
            .map_err(|e| format!("Failed to run gh: {}", e))?;
        if output.status.success() {
            let msg = String::from_utf8_lossy(&output.stderr);
            // gh pr checkout prints the branch name to stderr
            Ok(msg.trim().to_string())
        } else {
            let err = String::from_utf8_lossy(&output.stderr);
            Err(err.trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn checkout_pr_worktree(
    directory: String,
    pr_number: u32,
    head_ref_name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let expanded = if directory.starts_with('~') {
            if let Ok(home) = std::env::var("HOME") {
                directory.replacen('~', &home, 1)
            } else {
                directory.to_string()
            }
        } else {
            directory.to_string()
        };
        let dir_path = std::path::Path::new(&expanded);
        let worktree_name = format!("pr-{}", pr_number);
        let worktree_path = dir_path
            .join(".worktrees")
            .join(&worktree_name);

        // Ensure .worktrees directory exists
        let worktrees_dir = dir_path.join(".worktrees");
        std::fs::create_dir_all(&worktrees_dir)
            .map_err(|e| format!("Failed to create .worktrees dir: {}", e))?;

        // Fetch the branch
        let fetch = std::process::Command::new("git")
            .current_dir(&expanded)
            .env("PATH", shell_path())
            .args(["fetch", "origin", &head_ref_name])
            .output()
            .map_err(|e| format!("Failed to run git fetch: {}", e))?;
        if !fetch.status.success() {
            let err = String::from_utf8_lossy(&fetch.stderr);
            return Err(format!("git fetch failed: {}", err.trim()));
        }

        // Create worktree
        let wt = std::process::Command::new("git")
            .current_dir(&expanded)
            .env("PATH", shell_path())
            .args([
                "worktree",
                "add",
                &worktree_path.to_string_lossy(),
                &format!("origin/{}", head_ref_name),
            ])
            .output()
            .map_err(|e| format!("Failed to run git worktree add: {}", e))?;
        if !wt.status.success() {
            let err = String::from_utf8_lossy(&wt.stderr);
            return Err(format!("git worktree add failed: {}", err.trim()));
        }

        Ok(worktree_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn git_command(directory: &str) -> std::process::Command {
    let expanded = if directory.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            directory.replacen('~', &home, 1)
        } else {
            directory.to_string()
        }
    } else {
        directory.to_string()
    };
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(&expanded);
    cmd.env("PATH", shell_path());
    cmd
}

#[derive(Serialize, Clone)]
struct GitFileEntry {
    path: String,
    status: String,
    staged: bool,
}

#[derive(Serialize, Clone)]
struct GitStatusResult {
    branch: String,
    files: Vec<GitFileEntry>,
    #[serde(rename = "isGitRepo")]
    is_git_repo: bool,
}

#[tauri::command]
fn get_git_status(directory: String) -> Result<GitStatusResult, String> {
    let output = git_command(&directory)
        .args(["status", "--porcelain", "-b"])
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not a git repository") {
            return Ok(GitStatusResult {
                branch: String::new(),
                files: vec![],
                is_git_repo: false,
            });
        }
        return Err(format!("git status failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    let branch = lines
        .next()
        .unwrap_or("")
        .strip_prefix("## ")
        .unwrap_or("")
        .split("...")
        .next()
        .unwrap_or("")
        .to_string();

    let mut files = Vec::new();
    for line in lines {
        if line.len() < 4 {
            continue;
        }
        let index_status = line.chars().nth(0).unwrap_or(' ');
        let worktree_status = line.chars().nth(1).unwrap_or(' ');
        let path = line[3..].to_string();

        // Determine display status and staged flag
        if index_status == '?' && worktree_status == '?' {
            files.push(GitFileEntry {
                path,
                status: "??".to_string(),
                staged: false,
            });
        } else {
            // Staged change
            if index_status != ' ' && index_status != '?' {
                files.push(GitFileEntry {
                    path: path.clone(),
                    status: index_status.to_string(),
                    staged: true,
                });
            }
            // Unstaged change
            if worktree_status != ' ' && worktree_status != '?' {
                files.push(GitFileEntry {
                    path,
                    status: worktree_status.to_string(),
                    staged: false,
                });
            }
        }
    }

    Ok(GitStatusResult {
        branch,
        files,
        is_git_repo: true,
    })
}

#[tauri::command]
fn get_git_diff(directory: String, file_path: String, staged: bool) -> Result<String, String> {
    let mut cmd = git_command(&directory);
    cmd.arg("diff");
    if staged {
        cmd.arg("--cached");
    }
    cmd.arg("--");
    cmd.arg(&file_path);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// --- Phase 2: Branch Comparison ---

#[derive(Serialize, Clone)]
struct BranchDiffFile {
    path: String,
    status: String,
}

#[derive(Serialize, Clone)]
struct BranchDiffResult {
    files: Vec<BranchDiffFile>,
}

#[tauri::command]
fn switch_branch(directory: String, branch: String) -> Result<(), String> {
    // Try `git switch` first, fall back to `git checkout` for detached/remote branches
    let output = git_command(&directory)
        .args(["switch", &branch])
        .output()
        .map_err(|e| format!("Failed to run git switch: {}", e))?;
    if !output.status.success() {
        let output = git_command(&directory)
            .args(["checkout", &branch])
            .output()
            .map_err(|e| format!("Failed to run git checkout: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }
    Ok(())
}

#[tauri::command]
fn list_branches(directory: String) -> Result<Vec<String>, String> {
    // Sort branches by most recent commit date (descending) so recently-used branches come first
    let output = git_command(&directory)
        .args(["branch", "--sort=-committerdate", "--format=%(refname:short)"])
        .output()
        .map_err(|e| format!("Failed to run git branch: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

#[tauri::command]
fn get_branch_diff(directory: String, base: String, compare: String) -> Result<BranchDiffResult, String> {
    let output = git_command(&directory)
        .args(["diff", "--name-status", &format!("{}...{}", base, compare)])
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let files = stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(2, '\t').collect();
            if parts.len() == 2 {
                Some(BranchDiffFile {
                    status: parts[0].to_string(),
                    path: parts[1].to_string(),
                })
            } else {
                None
            }
        })
        .collect();
    Ok(BranchDiffResult { files })
}

#[tauri::command]
fn get_branch_file_diff(directory: String, base: String, compare: String, file_path: String) -> Result<String, String> {
    let output = git_command(&directory)
        .args(["diff", &format!("{}...{}", base, compare), "--", &file_path])
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[derive(Serialize, Clone)]
struct BranchCommit {
    hash: String,
    short_hash: String,
    author_email: String,
    author_name: String,
    subject: String,
    is_mine: bool,
    files: Vec<BranchDiffFile>,
}

#[derive(Serialize, Clone)]
struct BranchCommitsResult {
    commits: Vec<BranchCommit>,
    user_email: String,
}

#[tauri::command]
fn get_branch_commits(directory: String, base: String, compare: String) -> Result<BranchCommitsResult, String> {
    // Get git user email
    let email_output = git_command(&directory)
        .args(["config", "user.email"])
        .output()
        .map_err(|e| format!("Failed to get user email: {}", e))?;
    let user_email = String::from_utf8_lossy(&email_output.stdout).trim().to_string();

    // Get commits with their files using a delimiter-separated format
    let output = git_command(&directory)
        .args([
            "log",
            "--pretty=format:COMMIT_START%n%H%n%h%n%ae%n%an%n%s",
            "--name-status",
            &format!("{}..{}", base, compare),
        ])
        .output()
        .map_err(|e| format!("Failed to run git log: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut commits: Vec<BranchCommit> = Vec::new();

    for block in stdout.split("COMMIT_START\n").filter(|b| !b.trim().is_empty()) {
        let lines: Vec<&str> = block.lines().collect();
        if lines.len() < 5 {
            continue;
        }
        let hash = lines[0].to_string();
        let short_hash = lines[1].to_string();
        let author_email = lines[2].to_string();
        let author_name = lines[3].to_string();
        let subject = lines[4].to_string();

        let files: Vec<BranchDiffFile> = lines[5..]
            .iter()
            .filter_map(|line| {
                let line = line.trim();
                if line.is_empty() { return None; }
                let parts: Vec<&str> = line.splitn(2, '\t').collect();
                if parts.len() == 2 {
                    Some(BranchDiffFile {
                        status: parts[0].to_string(),
                        path: parts[1].to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();

        let is_mine = !user_email.is_empty()
            && author_email.to_lowercase() == user_email.to_lowercase();

        commits.push(BranchCommit {
            hash,
            short_hash,
            author_email,
            author_name,
            subject,
            is_mine,
            files,
        });
    }

    Ok(BranchCommitsResult { commits, user_email })
}

// --- Phase 3: PR Review ---

#[derive(Serialize, Clone)]
struct PrDiffResult {
    files: Vec<String>,
    #[serde(rename = "fullDiff")]
    full_diff: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct GhPrComment {
    id: u64,
    path: Option<String>,
    line: Option<u32>,
    body: String,
    body_html: Option<String>,
    user: GhPrAuthor,
    created_at: String,
}

#[derive(Serialize, Clone)]
struct PrComment {
    id: u64,
    path: String,
    line: u32,
    body: String,
    #[serde(rename = "bodyHtml")]
    body_html: String,
    user: String,
    #[serde(rename = "createdAt")]
    created_at: String,
}

#[tauri::command]
async fn get_pr_diff(directory: String, pr_number: u32) -> Result<PrDiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Get file list
        let names_output = gh_in_dir(&directory)
            .args(["pr", "diff", &pr_number.to_string(), "--name-only"])
            .output()
            .map_err(|e| format!("Failed to run gh pr diff: {}", e))?;
        if !names_output.status.success() {
            return Err(String::from_utf8_lossy(&names_output.stderr).to_string());
        }
        let files: Vec<String> = String::from_utf8_lossy(&names_output.stdout)
            .lines()
            .map(|l| l.to_string())
            .filter(|l| !l.is_empty())
            .collect();

        // Get full diff
        let diff_output = gh_in_dir(&directory)
            .args(["pr", "diff", &pr_number.to_string()])
            .output()
            .map_err(|e| format!("Failed to run gh pr diff: {}", e))?;
        let full_diff = String::from_utf8_lossy(&diff_output.stdout).to_string();

        Ok(PrDiffResult { files, full_diff })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn extract_file_diff(full_diff: &str, file_path: &str) -> String {
    let marker = format!("diff --git a/{} b/{}", file_path, file_path);
    let mut result = String::new();
    let mut in_section = false;
    for line in full_diff.lines() {
        if line.starts_with("diff --git ") {
            if in_section {
                break;
            }
            if line == marker {
                in_section = true;
            }
        }
        if in_section {
            result.push_str(line);
            result.push('\n');
        }
    }
    result
}

#[tauri::command]
async fn get_pr_file_diff(directory: String, pr_number: u32, file_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let diff_output = gh_in_dir(&directory)
            .args(["pr", "diff", &pr_number.to_string()])
            .output()
            .map_err(|e| format!("Failed to run gh pr diff: {}", e))?;
        let full_diff = String::from_utf8_lossy(&diff_output.stdout);
        Ok(extract_file_diff(&full_diff, &file_path))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn post_pr_comment(
    directory: String,
    pr_number: u32,
    body: String,
    path: String,
    line: u32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Get owner/repo from gh
        let repo_output = gh_in_dir(&directory)
            .args(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
            .output()
            .map_err(|e| format!("Failed to get repo info: {}", e))?;
        let repo = String::from_utf8_lossy(&repo_output.stdout).trim().to_string();
        if repo.is_empty() {
            return Err("Could not determine repository".to_string());
        }

        // Get the latest commit SHA on the PR for the review comment
        let pr_output = gh_in_dir(&directory)
            .args(["pr", "view", &pr_number.to_string(), "--json", "headRefOid", "-q", ".headRefOid"])
            .output()
            .map_err(|e| format!("Failed to get PR info: {}", e))?;
        let commit_id = String::from_utf8_lossy(&pr_output.stdout).trim().to_string();

        let output = gh_in_dir(&directory)
            .args([
                "api",
                &format!("repos/{}/pulls/{}/comments", repo, pr_number),
                "--method", "POST",
                "-f", &format!("body={}", body),
                "-f", &format!("path={}", path),
                "-F", &format!("line={}", line),
                "-f", &format!("commit_id={}", commit_id),
            ])
            .output()
            .map_err(|e| format!("Failed to post comment: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_pr_comments(directory: String, pr_number: u32) -> Result<Vec<PrComment>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo_output = gh_in_dir(&directory)
            .args(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
            .output()
            .map_err(|e| format!("Failed to get repo info: {}", e))?;
        let repo = String::from_utf8_lossy(&repo_output.stdout).trim().to_string();
        if repo.is_empty() {
            return Err("Could not determine repository".to_string());
        }

        let output = gh_in_dir(&directory)
            .args([
                "api",
                "-H", "Accept: application/vnd.github.full+json",
                &format!("repos/{}/pulls/{}/comments", repo, pr_number),
            ])
            .output()
            .map_err(|e| format!("Failed to get comments: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        let comments: Vec<GhPrComment> = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("Failed to parse comments: {}", e))?;

        Ok(comments
            .into_iter()
            .map(|c| PrComment {
                id: c.id,
                path: c.path.unwrap_or_default(),
                line: c.line.unwrap_or(0),
                body_html: c.body_html.unwrap_or_else(|| c.body.clone()),
                body: c.body,
                user: c.user.login,
                created_at: c.created_at,
            })
            .collect())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// --- PR file viewed state (GitHub GraphQL) ---

#[tauri::command]
async fn get_pr_viewed_files(directory: String, pr_number: u32) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo_output = gh_in_dir(&directory)
            .args(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
            .output()
            .map_err(|e| format!("Failed to get repo info: {}", e))?;
        let repo = String::from_utf8_lossy(&repo_output.stdout).trim().to_string();
        if repo.is_empty() {
            return Err("Could not determine repository".to_string());
        }
        let parts: Vec<&str> = repo.splitn(2, '/').collect();
        if parts.len() != 2 {
            return Err("Invalid repository format".to_string());
        }
        let (owner, name) = (parts[0], parts[1]);

        let query = format!(
            r#"query {{ repository(owner: "{}", name: "{}") {{ pullRequest(number: {}) {{ files(first: 100) {{ nodes {{ path viewerViewedState }} }} }} }} }}"#,
            owner, name, pr_number
        );

        let output = gh_in_dir(&directory)
            .args(["api", "graphql", "-f", &format!("query={}", query)])
            .output()
            .map_err(|e| format!("Failed to query GraphQL: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        let json: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        let mut viewed = Vec::new();
        if let Some(nodes) = json
            .pointer("/data/repository/pullRequest/files/nodes")
            .and_then(|n| n.as_array())
        {
            for node in nodes {
                if node.get("viewerViewedState").and_then(|v| v.as_str()) == Some("VIEWED") {
                    if let Some(path) = node.get("path").and_then(|p| p.as_str()) {
                        viewed.push(path.to_string());
                    }
                }
            }
        }
        Ok(viewed)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn set_pr_file_viewed(directory: String, pr_number: u32, path: String, viewed: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo_output = gh_in_dir(&directory)
            .args(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
            .output()
            .map_err(|e| format!("Failed to get repo info: {}", e))?;
        let repo = String::from_utf8_lossy(&repo_output.stdout).trim().to_string();
        if repo.is_empty() {
            return Err("Could not determine repository".to_string());
        }
        let parts: Vec<&str> = repo.splitn(2, '/').collect();
        if parts.len() != 2 {
            return Err("Invalid repository format".to_string());
        }
        let (owner, name) = (parts[0], parts[1]);

        // First get the PR node ID
        let id_query = format!(
            r#"query {{ repository(owner: "{}", name: "{}") {{ pullRequest(number: {}) {{ id }} }} }}"#,
            owner, name, pr_number
        );
        let id_output = gh_in_dir(&directory)
            .args(["api", "graphql", "-f", &format!("query={}", id_query)])
            .output()
            .map_err(|e| format!("Failed to query GraphQL: {}", e))?;
        if !id_output.status.success() {
            return Err(String::from_utf8_lossy(&id_output.stderr).to_string());
        }
        let id_json: serde_json::Value = serde_json::from_slice(&id_output.stdout)
            .map_err(|e| format!("Failed to parse response: {}", e))?;
        let pr_id = id_json
            .pointer("/data/repository/pullRequest/id")
            .and_then(|v| v.as_str())
            .ok_or("Could not get PR node ID")?
            .to_string();

        let mutation = if viewed {
            format!(
                r#"mutation {{ markFileAsViewed(input: {{ pullRequestId: "{}", path: "{}" }}) {{ clientMutationId }} }}"#,
                pr_id, path
            )
        } else {
            format!(
                r#"mutation {{ unmarkFileAsViewed(input: {{ pullRequestId: "{}", path: "{}" }}) {{ clientMutationId }} }}"#,
                pr_id, path
            )
        };

        let output = gh_in_dir(&directory)
            .args(["api", "graphql", "-f", &format!("query={}", mutation)])
            .output()
            .map_err(|e| format!("Failed to run mutation: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn read_file_content(directory: String, file_path: String) -> Result<String, String> {
    let expanded = if directory.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            directory.replacen('~', &home, 1)
        } else {
            directory.clone()
        }
    } else {
        directory.clone()
    };
    let full_path = std::path::PathBuf::from(&expanded).join(&file_path);
    std::fs::read_to_string(&full_path)
        .map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn read_file(file_path: String) -> Result<String, String> {
    let expanded = if file_path.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            file_path.replacen('~', &home, 1)
        } else {
            file_path.clone()
        }
    } else {
        file_path.clone()
    };
    let meta = std::fs::metadata(&expanded).map_err(|e| format!("Failed to stat file: {}", e))?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("File too large (>10MB)".into());
    }
    std::fs::read_to_string(&expanded).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn write_file(file_path: String, content: String) -> Result<(), String> {
    let expanded = if file_path.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            file_path.replacen('~', &home, 1)
        } else {
            file_path.clone()
        }
    } else {
        file_path.clone()
    };
    if content.len() > 10 * 1024 * 1024 {
        return Err("Content too large (>10MB)".into());
    }
    std::fs::write(&expanded, &content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn list_files(partial: String) -> Result<Vec<(String, bool)>, String> {
    let expanded = if partial.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            partial.replacen('~', &home, 1)
        } else {
            partial.clone()
        }
    } else {
        partial.clone()
    };

    let (dir, prefix) = if expanded.ends_with('/') {
        (std::path::PathBuf::from(&expanded), String::new())
    } else {
        let p = std::path::PathBuf::from(&expanded);
        let parent = p.parent().unwrap_or(std::path::Path::new("/"));
        let prefix = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        (parent.to_path_buf(), prefix)
    };

    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Failed to read dir: {}", e))?;
    let mut results: Vec<(String, bool)> = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if !prefix.is_empty() && !name.to_lowercase().starts_with(&prefix.to_lowercase()) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let display = if partial.starts_with('~') {
            let home = std::env::var("HOME").unwrap_or_default();
            let full = dir.join(&name).to_string_lossy().to_string();
            full.replacen(&home, "~", 1)
        } else {
            dir.join(&name).to_string_lossy().to_string()
        };
        results.push((display, is_dir));
    }

    results.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    results.truncate(50);
    Ok(results)
}

#[tauri::command]
fn resolve_path(file_path: String) -> Result<String, String> {
    let expanded = if file_path.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            file_path.replacen('~', &home, 1)
        } else {
            file_path
        }
    } else {
        file_path
    };
    std::fs::canonicalize(&expanded)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("Failed to resolve path: {}", e))
}

#[tauri::command]
fn save_clipboard_image(base64_data: String) -> Result<String, String> {
    clipboard_image::save_image_from_base64(&base64_data)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let watcher = JsonlWatcher::new(app.handle().clone())
                .expect("Failed to create file watcher");

            // Clean up stale signal files from previous runs
            SignalWatcher::cleanup_stale();

            let signal_watcher = SignalWatcher::new(app.handle().clone())
                .expect("Failed to create signal watcher");

            // Resolve MCP server script path.
            // Try in order: bundled (production), dev bundle next to Cargo.toml
            let mcp_script_path = {
                let candidates = [
                    // Production: Tauri resource bundle
                    app.handle()
                        .path()
                        .resource_dir()
                        .ok()
                        .map(|dir| dir.join("resources").join("mcp-server.bundle.mjs")),
                    // Dev: pre-built bundle in source tree (run `pnpm build:mcp`)
                    Some(
                        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                            .join("resources")
                            .join("mcp-server.bundle.mjs"),
                    ),
                ];
                candidates.into_iter().flatten().find(|p| p.exists()).map(|p| {
                    eprintln!("[setup] MCP script found at {:?}", p);
                    p.to_string_lossy().to_string()
                })
            };
            if mcp_script_path.is_none() {
                eprintln!("[setup] MCP script not found, MCP injection disabled. Run `pnpm build:mcp` to build it.");
            }

            app.manage(AppState {
                pty_manager: Mutex::new(PtyManager::new()),
                jsonl_cache: Mutex::new(JsonlCache::new()),
                pricing: PricingConfig::load(),
                file_watcher: Mutex::new(watcher),
                _signal_watcher: signal_watcher,
                mcp_script_path,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_pty_session,
            create_shell_pty_session,
            write_to_pty,
            resize_pty,
            directory_exists,
            destroy_pty_session,
            get_pty_scrollback,
            save_clipboard_image,
            save_sessions,
            load_sessions,
            list_directories,
            list_worktrees,
            create_worktree,
            remove_worktree,
            get_conversation_title,
            get_session_usage,
            get_total_usage_today,
            get_usage_dashboard,
            get_message_count,
            generate_smart_title,
            get_session_conversation,
            search_session_content,
            watch_jsonl,
            unwatch_jsonl,
            get_git_status,
            get_git_diff,
            read_file_content,
            read_file,
            write_file,
            resolve_path,
            list_files,
            get_pull_requests,
            checkout_pr,
            checkout_pr_worktree,
            list_branches,
            switch_branch,
            get_branch_diff,
            get_branch_file_diff,
            get_branch_commits,
            get_pr_diff,
            get_pr_file_diff,
            post_pr_comment,
            get_pr_comments,
            get_pr_viewed_files,
            set_pr_file_viewed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
