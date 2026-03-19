mod agent_manager;
mod clipboard_image;
mod db;
mod file_watcher;
mod pty_manager;
mod signal_watcher;

use agent_manager::AgentManager;
use file_watcher::JsonlWatcher;
use pty_manager::PtyManager;
use signal_watcher::SignalWatcher;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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

/// Incremental cache entry for conversation lines: tracks byte offset for append-only reads.
struct ConversationCacheEntry {
    byte_offset: u64,
    mtime: SystemTime,
    lines: Vec<String>,
}

/// Caches expensive JSONL parsing results, keyed by file path.
struct JsonlCache {
    usage: HashMap<PathBuf, IncrementalUsageEntry>,
    title: HashMap<PathBuf, CachedEntry<Option<String>>>,
    conversation: HashMap<PathBuf, ConversationCacheEntry>,
}

impl JsonlCache {
    fn new() -> Self {
        Self {
            usage: HashMap::new(),
            title: HashMap::new(),
            conversation: HashMap::new(),
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

struct FileListCache {
    entries: HashMap<String, (std::time::Instant, Vec<String>)>,
}

struct AppState {
    pty_manager: Mutex<PtyManager>,
    agent_manager: Arc<Mutex<AgentManager>>,
    jsonl_cache: Mutex<JsonlCache>,
    pricing: PricingConfig,
    file_watcher: Mutex<JsonlWatcher>,
    _signal_watcher: SignalWatcher,
    mcp_script_path: Option<String>,
    agent_script_paths: std::collections::HashMap<String, String>,
    title_server_port: std::sync::atomic::AtomicU16,
    _title_server_child: Mutex<Option<std::process::Child>>,
    file_list_cache: Mutex<FileListCache>,
    db: Arc<Mutex<rusqlite::Connection>>,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct SessionMeta {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(rename = "createdAt")]
    pub(crate) created_at: f64,
    #[serde(rename = "lastActiveAt")]
    pub(crate) last_active_at: f64,
    #[serde(default, rename = "lastMessageAt")]
    pub(crate) last_message_at: f64,
    #[serde(default)]
    pub(crate) directory: String,
    #[serde(default, rename = "homeDirectory", skip_serializing_if = "Option::is_none")]
    pub(crate) home_directory: Option<String>,
    #[serde(default, rename = "claudeSessionId", skip_serializing_if = "Option::is_none")]
    pub(crate) claude_session_id: Option<String>,
    #[serde(default, rename = "dangerouslySkipPermissions")]
    pub(crate) dangerously_skip_permissions: bool,
    #[serde(default, rename = "permissionMode", skip_serializing_if = "Option::is_none")]
    pub(crate) permission_mode: Option<String>,
    #[serde(default, rename = "activeTime")]
    pub(crate) active_time: f64,
    #[serde(default, rename = "hasTitleBeenGenerated")]
    pub(crate) has_title_been_generated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    #[serde(default, rename = "planContent", skip_serializing_if = "Option::is_none")]
    pub(crate) plan_content: Option<String>,
    #[serde(default, rename = "parentSessionId", skip_serializing_if = "Option::is_none")]
    pub(crate) parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) archived: Option<bool>,
    #[serde(default, rename = "archivedAt", skip_serializing_if = "Option::is_none")]
    pub(crate) archived_at: Option<f64>,
}

#[tauri::command]
fn save_sessions(
    sessions: Vec<SessionMeta>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::db_save_sessions(&conn, &sessions).map_err(|e| format!("DB write error: {}", e))
}

#[tauri::command]
fn load_sessions(state: State<'_, AppState>) -> Result<Vec<SessionMeta>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::db_load_sessions(&conn).map_err(|e| format!("DB read error: {}", e))
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
fn pty_has_child_process(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.has_child_process(&session_id)
}

/// Check whether a path falls inside a macOS TCC-protected directory (Desktop,
/// Documents, Downloads, etc.).  Accessing these from a non-sandboxed app
/// triggers a system permission dialog, so we avoid proactive filesystem calls
/// on them.
#[cfg(target_os = "macos")]
fn is_tcc_protected(expanded_path: &str) -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return false;
    }
    const PROTECTED: &[&str] = &[
        "Desktop",
        "Documents",
        "Downloads",
        "Movies",
        "Music",
        "Pictures",
    ];
    for dir in PROTECTED {
        let prefix = format!("{}/{}", home, dir);
        if expanded_path == prefix || expanded_path.starts_with(&format!("{}/", prefix)) {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "macos"))]
fn is_tcc_protected(_expanded_path: &str) -> bool {
    false
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
    if is_tcc_protected(&expanded) {
        return true;
    }
    std::path::Path::new(&expanded).is_dir()
}

#[tauri::command]
fn get_pty_scrollback(session_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let data = manager.get_scrollback(&session_id)?;
    eprintln!("[get_pty_scrollback] session_id={}, scrollback_len={}", session_id, data.len());
    Ok(data)
}

// ── Agent session commands ──────────────────────────────────────────

#[tauri::command]
async fn create_agent_session(
    session_id: String,
    directory: String,
    claude_session_id: Option<String>,
    resume: bool,
    system_prompt: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Extract owned values from State before moving into spawn_blocking
    let agent_script_paths = state.agent_script_paths.clone();
    let mcp_script = state.mcp_script_path.clone();
    let agent_manager = state.agent_manager.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let provider = provider.unwrap_or_else(|| "claude-code".to_string());

        // Expand leading ~ to $HOME (shells expand ~ but programmatic callers don't)
        let home = std::env::var("HOME")
            .unwrap_or_else(|_| format!("/Users/{}", std::env::var("USER").unwrap_or_default()));
        let directory = if directory.starts_with("~/") {
            format!("{}/{}", home, &directory[2..])
        } else if directory == "~" {
            home
        } else {
            directory
        };

        // Resolve git root so the agent always spawns from the project root.
        // This lets Claude see the root CLAUDE.md / .claude/ even for worktree sessions.
        let agent_cwd = find_git_root(&directory).unwrap_or_else(|| directory.clone());

        // On fresh sessions where the selected dir differs from the git root (e.g. a worktree),
        // prepend a cd instruction so Claude immediately navigates to the right directory.
        let system_prompt = if !resume && agent_cwd != directory {
            let cd_prefix = format!(
                "Your working directory for this session is `{dir}`. \
                 Start by running `cd {dir}` before doing any file work.",
                dir = directory
            );
            match system_prompt {
                Some(ref existing) if !existing.is_empty() => {
                    Some(format!("{}\n\n{}", cd_prefix, existing))
                }
                _ => Some(cd_prefix),
            }
        } else {
            system_prompt
        };

        // Shadow directory with git root — the agent bridge will use this as cwd.
        let directory = agent_cwd;

        eprintln!("[create_agent_session] session_id={}, directory={:?}, claude_session_id={:?}, resume={}, provider={}", session_id, directory, claude_session_id, resume, provider);

        let agent_script = agent_script_paths
            .get(&provider)
            .ok_or_else(|| format!("Agent bridge script not found for provider '{}'. Run `pnpm build` to build it.", provider))?
            .clone();

        let config = if provider == "claude-code" {
            // Build MCP servers config for the agent SDK
            let mcp_servers = if let Some(ref mcp_path) = mcp_script {
                serde_json::json!({
                    "orchestrator": {
                        "command": "node",
                        "args": [mcp_path],
                        "env": {
                            "ORCHESTRATOR_SESSION_ID": &session_id,
                            "ORCHESTRATOR_SIGNAL_DIR": if cfg!(debug_assertions) { "/tmp/orchestrator-signals-dev" } else { "/tmp/orchestrator-signals" }
                        }
                    }
                })
            } else {
                serde_json::json!({})
            };

            // Resolve the `claude` CLI so the Agent SDK can find it inside the app bundle
            let claude_cli = resolve_bin("claude");

            serde_json::json!({
                "sessionId": &session_id,
                "cwd": &directory,
                "resume": if resume { claude_session_id.as_deref() } else { None::<&str> },
                "mcpServers": mcp_servers,
                "systemPrompt": system_prompt,
                "claudeCliPath": claude_cli,
                "permissionMode": permission_mode,
            })
        } else {
            // Generic config for other providers (opencode, etc.)
            serde_json::json!({
                "sessionId": &session_id,
                "cwd": &directory,
                "systemPrompt": system_prompt,
                "model": model,
                "permissionMode": permission_mode,
                "ocSessionId": if resume { claude_session_id.as_deref() } else { None::<&str> },
            })
        };
        let config_json = config.to_string();

        let manager = agent_manager.lock().map_err(|e| e.to_string())?;
        manager.create_session(&session_id, app_handle, &agent_script, &config_json)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn send_agent_message(session_id: String, message: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    manager.send_message(&session_id, &message)
}

#[tauri::command]
fn abort_agent(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    manager.abort(&session_id)
}

#[tauri::command]
fn set_agent_cwd(session_id: String, cwd: String, state: State<'_, AppState>) -> Result<(), String> {
    // Expand ~ to absolute path (agent bridge needs absolute paths)
    let home = std::env::var("HOME")
        .unwrap_or_else(|_| format!("/Users/{}", std::env::var("USER").unwrap_or_default()));
    let abs_cwd = if cwd.starts_with("~/") {
        format!("{}/{}", home, &cwd[2..])
    } else if cwd == "~" {
        home
    } else {
        cwd
    };
    let msg = serde_json::json!({"type": "set_cwd", "cwd": abs_cwd}).to_string();
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    manager.send_message(&session_id, &msg)
}

#[tauri::command]
fn destroy_agent_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    manager.destroy_session(&session_id)
}

#[tauri::command]
fn get_agent_history(session_id: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    manager.get_history(&session_id)
}

/// Spawn the opencode bridge in list-models mode and return the JSON array of models.
#[tauri::command]
async fn fetch_opencode_models(state: State<'_, AppState>) -> Result<String, String> {
    let bridge_path = state
        .agent_script_paths
        .get("opencode")
        .ok_or_else(|| "OpenCode bridge script not found".to_string())?
        .clone();

    let result: Result<String, String> = tauri::async_runtime::spawn_blocking(move || {
        let node_bin = resolve_bin("node")
            .ok_or_else(|| "Could not find `node` binary".to_string())?;
        let path_env = shell_path();
        let home = std::env::var("HOME")
            .unwrap_or_else(|_| format!("/Users/{}", std::env::var("USER").unwrap_or_default()));
        let config_json = r#"{"mode":"list-models"}"#;

        let output = std::process::Command::new(&node_bin)
            .arg(&bridge_path)
            .arg(config_json)
            .env("PATH", path_env)
            .env("HOME", &home)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("Failed to spawn opencode bridge: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return Ok("[]".to_string());
        }
        let first_line = stdout.lines().next().unwrap_or("[]");
        Ok(first_line.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    result
}

/// Spawn the codex bridge in list-models mode and return the JSON array of models.
#[tauri::command]
async fn fetch_codex_models(state: State<'_, AppState>) -> Result<String, String> {
    let bridge_path = state
        .agent_script_paths
        .get("codex")
        .ok_or_else(|| "Codex bridge script not found".to_string())?
        .clone();

    let result: Result<String, String> = tauri::async_runtime::spawn_blocking(move || {
        let node_bin = resolve_bin("node")
            .ok_or_else(|| "Could not find `node` binary".to_string())?;
        let path_env = shell_path();
        let home = std::env::var("HOME")
            .unwrap_or_else(|_| format!("/Users/{}", std::env::var("USER").unwrap_or_default()));
        let openai_api_key = shell_env_var("OPENAI_API_KEY");
        let config_json = r#"{"mode":"list-models"}"#;

        let mut cmd = std::process::Command::new(&node_bin);
        cmd.arg(&bridge_path)
            .arg(config_json)
            .env("PATH", path_env)
            .env("HOME", &home)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(key) = openai_api_key {
            cmd.env("OPENAI_API_KEY", key);
        }

        let output = cmd.output()
            .map_err(|e| format!("Failed to spawn codex bridge: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return Ok("[]".to_string());
        }
        let first_line = stdout.lines().next().unwrap_or("[]");
        Ok(first_line.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    result
}

/// Check which agent providers have their CLI available on the system.
/// Returns a JSON object like {"claude-code": true, "opencode": false}.
#[tauri::command]
fn check_providers() -> std::collections::HashMap<String, bool> {
    let mut result = std::collections::HashMap::new();
    result.insert("claude-code".to_string(), resolve_bin("claude").is_some());
    result.insert("opencode".to_string(), resolve_bin("opencode").is_some());
    result.insert("codex".to_string(), resolve_bin("codex").is_some());
    result
}

#[tauri::command]
async fn list_directories(partial: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list_directories_sync(partial))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

fn list_directories_sync(partial: String) -> Result<Vec<String>, String> {
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

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]),
    };

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

// ── Slash commands discovery ──────────────────────────────────────────

#[derive(Serialize, Clone)]
struct SlashCommand {
    name: String,
    description: String,
    source: String, // "project" or "user"
}

#[tauri::command]
async fn list_slash_commands(directory: String) -> Result<Vec<SlashCommand>, String> {
    tauri::async_runtime::spawn_blocking(move || list_slash_commands_sync(directory))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

fn list_slash_commands_sync(directory: String) -> Result<Vec<SlashCommand>, String> {
    let mut commands = Vec::new();

    // Scan project-level .claude/commands/
    let project_dir = std::path::Path::new(&directory).join(".claude").join("commands");
    if project_dir.is_dir() {
        scan_commands_dir(&project_dir, "project", &mut commands);
    }

    // Scan user-level ~/.claude/commands/
    if let Ok(home) = std::env::var("HOME") {
        let user_dir = std::path::Path::new(&home).join(".claude").join("commands");
        if user_dir.is_dir() {
            scan_commands_dir(&user_dir, "user", &mut commands);
        }
    }

    commands.sort_by(|a, b| a.name.cmp(&b.name));
    // Deduplicate: project commands take priority over user commands
    commands.dedup_by(|b, a| {
        if a.name == b.name {
            // Keep a (first occurrence), which is project if both exist (sorted + stable)
            true
        } else {
            false
        }
    });
    Ok(commands)
}

fn scan_commands_dir(dir: &std::path::Path, source: &str, commands: &mut Vec<SlashCommand>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    let description = std::fs::read_to_string(&path)
                        .ok()
                        .and_then(|content| {
                            content.lines().next().map(|line| {
                                line.trim().trim_start_matches('#').trim().to_string()
                            })
                        })
                        .unwrap_or_default();
                    commands.push(SlashCommand {
                        name: stem.to_string(),
                        description,
                        source: source.to_string(),
                    });
                }
            }
        }
    }
}

#[derive(Serialize, Clone)]
struct WorktreeInfo {
    path: String,
    branch: String,
    #[serde(rename = "isMain")]
    is_main: bool,
}

#[tauri::command]
async fn list_worktrees(directory: String) -> Result<Vec<WorktreeInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || list_worktrees_sync(directory))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

fn list_worktrees_sync(directory: String) -> Result<Vec<WorktreeInfo>, String> {
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

    // Clone heavy gitignored dirs (node_modules, .venv, etc.) via APFS clonefile
    clone_heavy_dirs(&expanded, &worktree_path.to_string_lossy());

    let home = std::env::var("HOME").unwrap_or_default();
    let result = worktree_path.to_string_lossy().to_string();
    if !home.is_empty() && result.starts_with(&home) {
        Ok(format!("~{}", &result[home.len()..]))
    } else {
        Ok(result)
    }
}

/// Clone heavy gitignored directories (node_modules, .venv, etc.) from source repo
/// into a new worktree using `cp -Rc` (APFS copy-on-write clonefile).
fn clone_heavy_dirs(source: &str, worktree: &str) {
    let find_output = std::process::Command::new("find")
        .current_dir(source)
        .args([
            ".",
            "-path", "./.worktrees", "-prune", "-o",
            "-path", "./.git", "-prune", "-o",
            "(", "-name", "node_modules",
                 "-o", "-name", ".venv",
                 "-o", "-name", "venv",
                 "-o", "-name", "vendor", ")",
            "-type", "d", "-print", "-prune",
        ])
        .output();

    let output = match find_output {
        Ok(o) if o.status.success() => o,
        _ => return,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    for rel_path in stdout.lines() {
        let rel_path = rel_path.trim_start_matches("./");
        if rel_path.is_empty() {
            continue;
        }
        let src = std::path::Path::new(source).join(rel_path);
        let dst = std::path::Path::new(worktree).join(rel_path);

        // Ensure parent directory exists
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        // APFS copy-on-write clone
        let _ = std::process::Command::new("cp")
            .args(["-Rc", &src.to_string_lossy(), &dst.to_string_lossy()])
            .output();
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
    let encoded_path = trimmed_dir.replace('/', "-").replace('.', "-");
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

/// Query the OpenCode SQLite database for the latest session title matching a directory.
/// OpenCode stores its DB at ~/.local/share/opencode/opencode.db with a `session` table.
#[tauri::command]
fn get_opencode_session_title(directory: String) -> Result<Option<String>, String> {
    let expanded_dir = if directory.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            directory.replacen('~', &home, 1)
        } else {
            directory.clone()
        }
    } else {
        directory.clone()
    };

    let db_path = dirs_opencode_db();
    let db_path = match db_path {
        Some(p) if p.exists() => p,
        _ => return Ok(None),
    };

    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open opencode DB: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT title FROM session WHERE directory = ?1 ORDER BY time_updated DESC LIMIT 1")
        .map_err(|e| format!("SQL prepare error: {}", e))?;

    let title: Option<String> = stmt
        .query_row(rusqlite::params![expanded_dir], |row| row.get(0))
        .ok();

    Ok(title)
}

fn dirs_opencode_db() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(std::path::PathBuf::from(home).join(".local/share/opencode/opencode.db"))
}

#[derive(Serialize, Clone, Default)]
pub(crate) struct SessionUsage {
    #[serde(rename = "inputTokens")]
    pub(crate) input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub(crate) output_tokens: u64,
    #[serde(rename = "cacheCreationInputTokens")]
    pub(crate) cache_creation_input_tokens: u64,
    #[serde(rename = "cacheReadInputTokens")]
    pub(crate) cache_read_input_tokens: u64,
    #[serde(rename = "costUsd")]
    pub(crate) cost_usd: f64,
    #[serde(rename = "contextTokens")]
    pub(crate) context_tokens: u64,
    #[serde(rename = "isBusy")]
    pub(crate) is_busy: bool,
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
                    usage.context_tokens = inp + cc + cr;

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

    let jsonl_path_str = jsonl_path.to_string_lossy().to_string();

    // Get current mtime to detect file changes
    let current_mtime = jsonl_path
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Check in-memory cache first; fall back to SQLite cache on a cache miss
    let (byte_offset, base_usage) = {
        let cache = state.jsonl_cache.lock().map_err(|e| e.to_string())?;
        match cache.usage.get(&jsonl_path) {
            Some(entry) => (entry.byte_offset, entry.value.clone()),
            None => {
                // Try loading from SQLite so we don't re-scan from byte 0
                let db_conn = state.db.lock().map_err(|e| e.to_string())?;
                match db::db_get_usage_cache(&db_conn, &jsonl_path_str) {
                    Ok(Some((offset, usage, stored_mtime)))
                        if stored_mtime == current_mtime || offset > 0 =>
                    {
                        (offset, usage)
                    }
                    _ => (0, SessionUsage::default()),
                }
            }
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

    // Update in-memory cache and persist to SQLite when new data was parsed
    if new_offset != byte_offset {
        {
            let mut cache = state.jsonl_cache.lock().map_err(|e| e.to_string())?;
            cache.usage.insert(
                jsonl_path,
                IncrementalUsageEntry {
                    byte_offset: new_offset,
                    value: usage.clone(),
                },
            );
        }
        // Persist to SQLite (best-effort; don't fail the command on DB errors)
        if let Ok(db_conn) = state.db.lock() {
            let _ = db::db_set_usage_cache(
                &db_conn,
                &jsonl_path_str,
                new_offset,
                current_mtime,
                &usage,
            );
        }
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

/// Walk up from `dir` to find a .git directory/file, returning the repo root.
fn find_git_root(dir: &str) -> Option<String> {
    let mut path = PathBuf::from(dir);
    loop {
        if path.join(".git").exists() {
            return Some(path.to_string_lossy().to_string());
        }
        if !path.pop() {
            return None;
        }
    }
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

    // Consolidate by git repo root: walk up each directory to find .git,
    // then merge all entries that share the same repo root.
    let mut repo_map: HashMap<String, ProjectUsage> = HashMap::new();
    for proj in projects {
        let repo_root = find_git_root(&proj.directory).unwrap_or_else(|| proj.directory.clone());
        match repo_map.get_mut(&repo_root) {
            Some(existing) => {
                existing.cost_usd += proj.cost_usd;
                existing.total_tokens += proj.total_tokens;
                existing.session_count += proj.session_count;
            }
            None => {
                repo_map.insert(repo_root.clone(), ProjectUsage {
                    directory: repo_root,
                    cost_usd: proj.cost_usd,
                    total_tokens: proj.total_tokens,
                    session_count: proj.session_count,
                });
            }
        }
    }
    let mut projects: Vec<ProjectUsage> = repo_map.into_values().collect();

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
async fn get_message_count(claude_session_id: String, directory: String) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || get_message_count_sync(claude_session_id, directory))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

fn get_message_count_sync(claude_session_id: String, directory: String) -> Result<u32, String> {
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
/// Call the warm title server with a user message and return the generated title.
async fn call_title_server(port: u16, body: String) -> Result<Option<String>, String> {

    let response = tauri::async_runtime::spawn_blocking(move || {
        let client = std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| format!("Failed to connect to title server: {}", e))?;
        client.set_read_timeout(Some(std::time::Duration::from_secs(30))).ok();
        client.set_write_timeout(Some(std::time::Duration::from_secs(5))).ok();

        use std::io::{Read, Write};
        let mut stream = client;
        let request = format!(
            "POST / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            port,
            body.len(),
            body
        );
        stream.write_all(request.as_bytes())
            .map_err(|e| format!("Failed to send request: {}", e))?;

        let mut response = String::new();
        stream.read_to_string(&mut response)
            .map_err(|e| format!("Failed to read response: {}", e))?;

        Ok::<String, String>(response)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Parse HTTP response — extract body after \r\n\r\n
    let body = response.split("\r\n\r\n").nth(1).unwrap_or("");
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(title) = parsed.get("title").and_then(|t| t.as_str()) {
            let title = title.trim().to_string();
            if !title.is_empty() {
                return Ok(Some(title));
            }
        }
        if let Some(error) = parsed.get("error").and_then(|e| e.as_str()) {
            return Err(format!("Title server error: {}", error));
        }
    }

    Ok(None)
}

#[tauri::command]
async fn generate_smart_title(
    claude_session_id: String,
    directory: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let port = state.title_server_port.load(std::sync::atomic::Ordering::Relaxed);
    if port == 0 {
        return Err("Title server not running".to_string());
    }

    // Extract user message from JSONL in a blocking task
    let user_msg = tauri::async_runtime::spawn_blocking(move || {
        extract_first_user_message(&claude_session_id, &directory)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let user_msg = match user_msg {
        Some(m) => m,
        None => return Ok(None),
    };

    let text = user_msg.get("text").and_then(|t| t.as_str()).unwrap_or("");
    let body = serde_json::json!({ "message": text }).to_string();
    call_title_server(port, body).await
}

#[tauri::command]
async fn generate_title_from_text(
    message: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let port = state.title_server_port.load(std::sync::atomic::Ordering::Relaxed);
    if port == 0 {
        return Err("Title server not running".to_string());
    }

    let truncated: String = message.chars().take(500).collect();
    let body = serde_json::json!({ "message": truncated }).to_string();
    call_title_server(port, body).await
}

/// Call the title server's /classify endpoint to determine if a prompt is simple or complex.
async fn call_classify_server(port: u16, user_msg: String) -> Result<String, String> {
    let body = serde_json::json!({ "message": user_msg }).to_string();

    let response = tauri::async_runtime::spawn_blocking(move || {
        let client = std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| format!("Failed to connect to classify server: {}", e))?;
        client.set_read_timeout(Some(std::time::Duration::from_secs(15))).ok();
        client.set_write_timeout(Some(std::time::Duration::from_secs(5))).ok();

        use std::io::{Read, Write};
        let mut stream = client;
        let request = format!(
            "POST /classify HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            port,
            body.len(),
            body
        );
        stream.write_all(request.as_bytes())
            .map_err(|e| format!("Failed to send request: {}", e))?;

        let mut response = String::new();
        stream.read_to_string(&mut response)
            .map_err(|e| format!("Failed to read response: {}", e))?;

        Ok::<String, String>(response)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Parse HTTP response — extract body after \r\n\r\n
    let body = response.split("\r\n\r\n").nth(1).unwrap_or("");
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(classification) = parsed.get("classification").and_then(|c| c.as_str()) {
            return Ok(classification.to_string());
        }
    }

    // Default to complex on any parse failure
    Ok("complex".to_string())
}

#[tauri::command]
async fn classify_prompt(
    message: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let port = state.title_server_port.load(std::sync::atomic::Ordering::Relaxed);
    if port == 0 {
        return Ok("complex".to_string());
    }

    let truncated: String = message.chars().take(500).collect();
    call_classify_server(port, truncated).await
}

fn is_image_path(line: &str) -> bool {
    let t = line.trim();
    let has_img_prefix = t.starts_with("/var/folders/")
        || t.starts_with("/tmp/")
        || t.starts_with("/var/tmp/");
    let has_img_ext = t.ends_with(".png")
        || t.ends_with(".jpg")
        || t.ends_with(".jpeg")
        || t.ends_with(".gif")
        || t.ends_with(".webp");
    has_img_prefix && has_img_ext
}

fn extract_first_user_message(claude_session_id: &str, directory: &str) -> Result<Option<serde_json::Value>, String> {
    let jsonl_path = jsonl_path_for(claude_session_id, directory)?;

    if !jsonl_path.exists() {
        return Ok(None);
    }

    let file = std::fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open conversation file: {}", e))?;
    let reader = std::io::BufReader::new(file);

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
                    // Collect text blocks only; images are not sent to the title server
                    let mut texts = Vec::new();
                    let mut has_images = false;

                    if let Some(s) = content.as_str() {
                        let filtered: Vec<&str> = s.lines()
                            .filter(|line| !is_image_path(line))
                            .collect();
                        let filtered_text = filtered.join("\n");
                        if !filtered_text.is_empty() {
                            texts.push(filtered_text);
                        } else if s.lines().any(is_image_path) {
                            has_images = true;
                        }
                    } else if let Some(arr) = content.as_array() {
                        for block in arr {
                            let block_type = block.get("type").and_then(|t| t.as_str());
                            if block_type == Some("text") {
                                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                    texts.push(text.to_string());
                                }
                            } else if block_type == Some("image") {
                                has_images = true;
                            }
                        }
                    }

                    let combined_text = texts.join("\n");
                    if combined_text.starts_with("<command-message>") {
                        continue;
                    }

                    // Use placeholder when message is image-only
                    let text = if combined_text.is_empty() {
                        if has_images { "[Image]".to_string() } else { continue; }
                    } else {
                        combined_text.chars().take(500).collect()
                    };

                    return Ok(Some(serde_json::json!({ "text": text })));
                }
            }
        }
    }

    Ok(None)
}

/// Truncate large text fields in content blocks to keep IPC payloads small.
/// Modifies the JSON value in-place.
fn truncate_content_blocks(val: &mut serde_json::Value) {
    const MAX_TEXT: usize = 20_000; // chars, not bytes

    let content = val
        .pointer_mut("/message/content");

    if let Some(serde_json::Value::Array(blocks)) = content {
        for block in blocks.iter_mut() {
            if let Some(serde_json::Value::String(text)) = block.get_mut("text") {
                if text.len() > MAX_TEXT {
                    // Truncate at a safe char boundary
                    let end = text.char_indices()
                        .nth(MAX_TEXT)
                        .map(|(i, _)| i)
                        .unwrap_or(text.len());
                    text.truncate(end);
                    text.push_str("\n…[truncated]");
                }
            }
        }
    } else if let Some(serde_json::Value::String(text)) = val.pointer_mut("/message/content") {
        if text.len() > MAX_TEXT {
            let end = text.char_indices()
                .nth(MAX_TEXT)
                .map(|(i, _)| i)
                .unwrap_or(text.len());
            text.truncate(end);
            text.push_str("\n…[truncated]");
        }
    }
}

/// Read new lines from a JSONL file starting at `byte_offset`, filter to wanted message types,
/// and truncate large content blocks. Returns `(new_filtered_lines, new_byte_offset)`.
fn read_and_filter_jsonl_lines(path: &std::path::Path, byte_offset: u64) -> Result<(Vec<String>, u64), String> {
    use std::io::{BufRead, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open conversation file: {}", e))?;

    let file_len = file.metadata()
        .map_err(|e| format!("Failed to get file metadata: {}", e))?
        .len();

    if byte_offset >= file_len {
        return Ok((vec![], byte_offset));
    }

    file.seek(SeekFrom::Start(byte_offset))
        .map_err(|e| format!("Failed to seek in file: {}", e))?;

    const WANTED: &[&str] = &[
        "\"type\":\"user\"", "\"type\": \"user\"",
        "\"type\":\"assistant\"", "\"type\": \"assistant\"",
        "\"type\":\"result\"", "\"type\": \"result\"",
        "\"type\":\"error\"", "\"type\": \"error\"",
    ];
    const TRUNCATE_THRESHOLD: usize = 30_000;

    let reader = std::io::BufReader::new(file);
    let mut new_offset = byte_offset;
    let mut lines = Vec::new();

    for line_result in reader.lines() {
        let l = line_result.map_err(|e| format!("Failed to read line: {}", e))?;
        new_offset += l.len() as u64 + 1; // +1 for newline
        if l.is_empty() || !WANTED.iter().any(|w| l.contains(w)) {
            continue;
        }
        if l.len() <= TRUNCATE_THRESHOLD {
            lines.push(l);
        } else if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&l) {
            truncate_content_blocks(&mut val);
            lines.push(serde_json::to_string(&val).unwrap_or(l));
        } else {
            lines.push(l);
        }
    }

    Ok((lines, new_offset))
}

/// Get all cached conversation lines for a JSONL path, reading incrementally from disk.
/// Returns a reference-counted clone of the cached lines.
fn get_cached_conversation_lines(
    jsonl_path: &std::path::Path,
    cache: &Mutex<JsonlCache>,
) -> Result<Vec<String>, String> {
    let mtime = std::fs::metadata(jsonl_path)
        .map_err(|e| format!("Failed to get metadata: {}", e))?
        .modified()
        .map_err(|e| format!("Failed to get mtime: {}", e))?;

    // Fast path: check if cache is fresh
    {
        let guard = cache.lock().unwrap();
        if let Some(entry) = guard.conversation.get(jsonl_path) {
            if entry.mtime == mtime {
                return Ok(entry.lines.clone());
            }
        }
    }

    // Cache miss or stale — read incrementally
    let guard = cache.lock().unwrap();
    // Double-check after acquiring lock
    let existing_offset = guard.conversation.get(jsonl_path)
        .filter(|e| e.mtime == mtime)
        .map(|e| e.byte_offset);

    if let Some(_offset) = existing_offset {
        // Another thread filled it while we waited
        return Ok(guard.conversation.get(jsonl_path).unwrap().lines.clone());
    }

    // Check if file was truncated/replaced (mtime changed and we had a cache entry)
    let start_offset = guard.conversation.get(jsonl_path)
        .filter(|e| {
            // Only reuse offset if file grew (same or newer mtime, offset still valid)
            let file_len = std::fs::metadata(jsonl_path).map(|m| m.len()).unwrap_or(0);
            file_len >= e.byte_offset
        })
        .map(|e| e.byte_offset)
        .unwrap_or(0);

    let mut existing_lines = if start_offset > 0 {
        guard.conversation.get(jsonl_path).map(|e| e.lines.clone()).unwrap_or_default()
    } else {
        Vec::new()
    };

    // Drop the lock during I/O
    drop(guard);

    let (new_lines, new_offset) = read_and_filter_jsonl_lines(jsonl_path, start_offset)?;
    existing_lines.extend(new_lines);

    let result = existing_lines.clone();

    // Store in cache
    let mut guard = cache.lock().unwrap();
    guard.conversation.insert(jsonl_path.to_path_buf(), ConversationCacheEntry {
        byte_offset: new_offset,
        mtime,
        lines: existing_lines,
    });

    Ok(result)
}

#[tauri::command]
fn get_conversation_jsonl(
    claude_session_id: String,
    directory: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;
    if !jsonl_path.exists() {
        return Ok(vec![]);
    }
    get_cached_conversation_lines(&jsonl_path, &state.jsonl_cache)
}

#[derive(Serialize)]
struct ConversationTailResult {
    lines: Vec<String>,
    total: usize,
}

#[tauri::command]
fn get_conversation_jsonl_tail(
    claude_session_id: String,
    directory: String,
    max_lines: usize,
    state: State<'_, AppState>,
) -> Result<ConversationTailResult, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;
    if !jsonl_path.exists() {
        return Ok(ConversationTailResult { lines: vec![], total: 0 });
    }

    let all_lines = get_cached_conversation_lines(&jsonl_path, &state.jsonl_cache)?;
    let total = all_lines.len();
    let tail = if total <= max_lines {
        all_lines
    } else {
        all_lines[total - max_lines..].to_vec()
    };

    Ok(ConversationTailResult { lines: tail, total })
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

/// Read an environment variable from the user's login+interactive shell.
/// Useful for GUI-launched processes that don't inherit the terminal env.
fn shell_env_var(name: &str) -> Option<String> {
    // Fast path: already in the process environment (e.g. app started from terminal).
    if let Ok(val) = std::env::var(name) {
        if !val.is_empty() {
            return Some(val);
        }
    }
    // Slow path: source both login and interactive rc files via the user's shell.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let script = format!("echo ${}", name);
    let val = std::process::Command::new(&shell)
        .args(["-ilc", &script])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())?;
    if val == name || val.starts_with('$') {
        // Shell echoed the literal variable name — not set
        None
    } else {
        Some(val)
    }
}

/// Resolve the absolute path of a binary using the shell PATH,
/// falling back to well-known install locations.
/// Results are cached so we only spawn a shell once per binary name.
fn resolve_bin(name: &str) -> Option<String> {
    use std::sync::OnceLock;
    use std::collections::HashMap;
    use std::sync::Mutex;

    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    let mut map = cache.lock().ok()?;
    if let Some(cached) = map.get(name) {
        return cached.clone();
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let result = std::process::Command::new(&shell)
        .args(["-lc", &format!("which {}", name)])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            // GUI apps may not inherit the full shell PATH, so check
            // well-known install directories as a fallback.
            let home = std::env::var("HOME").ok()?;
            let candidates = [
                format!("{home}/.{name}/bin/{name}"),
                format!("{home}/.local/bin/{name}"),
                format!("{home}/go/bin/{name}"),
                format!("{home}/.cargo/bin/{name}"),
                format!("/usr/local/bin/{name}"),
                format!("/opt/homebrew/bin/{name}"),
            ];
            candidates.into_iter().find(|p| std::path::Path::new(p).is_file())
        });

    map.insert(name.to_string(), result.clone());
    result
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

        // Create worktree with a local branch tracking the remote
        let wt = std::process::Command::new("git")
            .current_dir(&expanded)
            .env("PATH", shell_path())
            .args([
                "worktree",
                "add",
                "-b",
                &head_ref_name,
                &worktree_path.to_string_lossy(),
                &format!("origin/{}", head_ref_name),
            ])
            .output()
            .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

        // If -b failed (branch already exists), try without creating a new branch
        if !wt.status.success() {
            let err_str = String::from_utf8_lossy(&wt.stderr);
            if err_str.contains("already exists") {
                let wt2 = std::process::Command::new("git")
                    .current_dir(&expanded)
                    .env("PATH", shell_path())
                    .args([
                        "worktree",
                        "add",
                        &worktree_path.to_string_lossy(),
                        &head_ref_name,
                    ])
                    .output()
                    .map_err(|e| format!("Failed to run git worktree add: {}", e))?;
                if !wt2.status.success() {
                    let err2 = String::from_utf8_lossy(&wt2.stderr);
                    return Err(format!("git worktree add failed: {}", err2.trim()));
                }
            } else {
                return Err(format!("git worktree add failed: {}", err_str.trim()));
            }
        }

        // Clone heavy gitignored dirs (node_modules, .venv, etc.) via APFS clonefile
        clone_heavy_dirs(&expanded, &worktree_path.to_string_lossy());

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
async fn get_git_status(directory: String) -> Result<GitStatusResult, String> {
    tauri::async_runtime::spawn_blocking(move || get_git_status_sync(directory))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

fn get_git_status_sync(directory: String) -> Result<GitStatusResult, String> {
    let output = git_command(&directory)
        .args(["status", "--porcelain", "-b", "--untracked-files=all"])
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
    let mut branch = lines
        .next()
        .unwrap_or("")
        .strip_prefix("## ")
        .unwrap_or("")
        .split("...")
        .next()
        .unwrap_or("")
        .to_string();

    // In worktrees, git status may show "HEAD (no branch)" even though a branch is checked out.
    // Fall back to `git branch --show-current` which handles worktrees correctly.
    if branch == "HEAD (no branch)" || branch.is_empty() {
        if let Ok(branch_output) = git_command(&directory)
            .args(["branch", "--show-current"])
            .output()
        {
            let name = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();
            if !name.is_empty() {
                branch = name;
            }
        }
    }

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

    files.truncate(500);

    Ok(GitStatusResult {
        branch,
        files,
        is_git_repo: true,
    })
}

#[tauri::command]
async fn get_git_diff(directory: String, file_path: String, staged: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || get_git_diff_sync(directory, file_path, staged))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn get_git_numstat(directory: String, staged: bool) -> Result<HashMap<String, (u32, u32)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = git_command(&directory);
        cmd.arg("diff").arg("--numstat");
        if staged {
            cmd.arg("--cached");
        }
        let output = cmd.output().map_err(|e| format!("Failed to run git diff --numstat: {}", e))?;
        let mut map = HashMap::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() == 3 {
                let added = parts[0].parse::<u32>().unwrap_or(0);
                let removed = parts[1].parse::<u32>().unwrap_or(0);
                map.insert(parts[2].to_string(), (added, removed));
            }
        }
        Ok(map)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn get_git_diff_sync(directory: String, file_path: String, staged: bool) -> Result<String, String> {
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

// --- Commit & Push ---

#[tauri::command]
async fn generate_commit_message(
    directory: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let port = state.title_server_port.load(std::sync::atomic::Ordering::Relaxed);
    if port == 0 {
        return Err("Title server not running".to_string());
    }

    // Get all local changes: try `git diff HEAD` first (captures both staged and unstaged vs last commit),
    // fall back to `git diff --staged` for repos with no commits yet.
    let diff = tauri::async_runtime::spawn_blocking(move || {
        let output = git_command(&directory)
            .args(["diff", "HEAD"])
            .output()
            .map_err(|e| format!("Failed to run git diff HEAD: {}", e))?;
        if output.status.success() && !output.stdout.is_empty() {
            return Ok::<String, String>(String::from_utf8_lossy(&output.stdout).to_string());
        }
        // Fallback: initial commit or empty working tree — try staged diff
        let staged = git_command(&directory)
            .args(["diff", "--staged"])
            .output()
            .map_err(|e| format!("Failed to run git diff --staged: {}", e))?;
        Ok(String::from_utf8_lossy(&staged.stdout).to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    if diff.trim().is_empty() {
        return Ok(String::new());
    }

    // Call title server /commit-message endpoint
    let body = serde_json::json!({ "diff": diff }).to_string();
    let response = tauri::async_runtime::spawn_blocking(move || {
        let client = std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| format!("Failed to connect to title server: {}", e))?;
        client.set_read_timeout(Some(std::time::Duration::from_secs(60))).ok();
        client.set_write_timeout(Some(std::time::Duration::from_secs(5))).ok();

        use std::io::{Read, Write};
        let mut stream = client;
        let request = format!(
            "POST /commit-message HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            port,
            body.len(),
            body
        );
        stream.write_all(request.as_bytes())
            .map_err(|e| format!("Failed to send request: {}", e))?;

        let mut response = String::new();
        stream.read_to_string(&mut response)
            .map_err(|e| format!("Failed to read response: {}", e))?;

        Ok::<String, String>(response)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let body = response.split("\r\n\r\n").nth(1).unwrap_or("");
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(msg) = parsed.get("message").and_then(|m| m.as_str()) {
            return Ok(msg.trim().to_string());
        }
        if let Some(error) = parsed.get("error").and_then(|e| e.as_str()) {
            return Err(format!("Server error: {}", error));
        }
    }

    Ok(String::new())
}

#[tauri::command]
async fn git_commit_and_push(directory: String, message: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // git commit
        let commit = git_command(&directory)
            .args(["commit", "-m", &message])
            .output()
            .map_err(|e| format!("Failed to run git commit: {}", e))?;
        if !commit.status.success() {
            return Err(format!(
                "git commit failed: {}",
                String::from_utf8_lossy(&commit.stderr)
            ));
        }

        // Try git push, fall back to --set-upstream if no upstream configured
        let push = git_command(&directory)
            .args(["push"])
            .output()
            .map_err(|e| format!("Failed to run git push: {}", e))?;

        if !push.status.success() {
            let stderr = String::from_utf8_lossy(&push.stderr);
            if stderr.contains("no upstream") || stderr.contains("has no upstream") || stderr.contains("--set-upstream") {
                // Get current branch name
                let branch_out = git_command(&directory)
                    .args(["branch", "--show-current"])
                    .output()
                    .map_err(|e| format!("Failed to get branch: {}", e))?;
                let branch = String::from_utf8_lossy(&branch_out.stdout).trim().to_string();

                let push2 = git_command(&directory)
                    .args(["push", "--set-upstream", "origin", &branch])
                    .output()
                    .map_err(|e| format!("Failed to run git push --set-upstream: {}", e))?;
                if !push2.status.success() {
                    return Err(format!(
                        "git push failed: {}",
                        String::from_utf8_lossy(&push2.stderr)
                    ));
                }
            } else {
                return Err(format!("git push failed: {}", stderr));
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn git_unstage_all(directory: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = git_command(&directory)
            .args(["restore", "--staged", "."])
            .output()
            .map_err(|e| format!("Failed to run git restore: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "git restore --staged failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn git_stage_files(directory: String, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = git_command(&directory);
        cmd.args(["add", "--"]);
        for f in &files {
            cmd.arg(f);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git add: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "git add failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn git_unstage_files(directory: String, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = git_command(&directory);
        cmd.args(["restore", "--staged", "--"]);
        for f in &files {
            cmd.arg(f);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git restore: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "git restore --staged failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
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
struct PrFileEntry {
    path: String,
    status: String, // "A" | "M" | "D" | "R"
}

#[derive(Serialize, Clone)]
struct PrDiffResult {
    files: Vec<PrFileEntry>,
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
        // Get full diff (we extract both file list and status from it)
        let diff_output = gh_in_dir(&directory)
            .args(["pr", "diff", &pr_number.to_string()])
            .output()
            .map_err(|e| format!("Failed to run gh pr diff: {}", e))?;
        if !diff_output.status.success() {
            return Err(String::from_utf8_lossy(&diff_output.stderr).to_string());
        }
        let full_diff = String::from_utf8_lossy(&diff_output.stdout).to_string();

        // Parse files and their status from diff headers
        let mut files: Vec<PrFileEntry> = Vec::new();
        let mut current_file: Option<String> = None;
        let mut current_status = "M";
        for line in full_diff.lines() {
            if line.starts_with("diff --git a/") {
                // Flush previous file
                if let Some(path) = current_file.take() {
                    files.push(PrFileEntry { path, status: current_status.to_string() });
                }
                // Extract path from "diff --git a/path b/path"
                if let Some(b_part) = line.split(" b/").last() {
                    current_file = Some(b_part.to_string());
                }
                current_status = "M"; // default
            } else if line.starts_with("new file mode") {
                current_status = "A";
            } else if line.starts_with("deleted file mode") {
                current_status = "D";
            } else if line.starts_with("rename from") {
                current_status = "R";
            }
        }
        // Flush last file
        if let Some(path) = current_file {
            files.push(PrFileEntry { path, status: current_status.to_string() });
        }

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
fn read_file_base64(file_path: String) -> Result<String, String> {
    use std::io::Read;
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
    let mut buf = Vec::new();
    std::fs::File::open(&expanded)
        .map_err(|e| format!("Failed to open file: {}", e))?
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(base64_encode(&buf))
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(CHARS[(b0 >> 2)] as char);
        out.push(CHARS[((b0 & 3) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 { CHARS[((b1 & 15) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[b2 & 63] as char } else { '=' });
    }
    out
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
async fn search_project_files(directory: String, query: String, state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    use std::time::Instant;

    let directory = if directory.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            directory.replacen('~', &home, 1)
        } else {
            directory
        }
    } else {
        directory
    };

    const CACHE_TTL_SECS: u64 = 30;

    // Check cache first — clone what we need, then drop the lock before any blocking work
    let cached = {
        let cache = state.file_list_cache.lock().map_err(|e| e.to_string())?;
        cache.entries.get(&directory).and_then(|(cached_at, cached_files)| {
            if cached_at.elapsed().as_secs() < CACHE_TTL_SECS {
                Some(cached_files.clone())
            } else {
                None
            }
        })
    };

    let files: Vec<String> = if let Some(files) = cached {
        files
    } else {
        let dir = directory.clone();
        let files = tauri::async_runtime::spawn_blocking(move || list_project_files(&dir))
            .await
            .map_err(|e| e.to_string())?;
        let mut cache = state.file_list_cache.lock().map_err(|e| e.to_string())?;
        cache.entries.insert(directory.clone(), (Instant::now(), files.clone()));
        files
    };

    let query_lower = query.to_lowercase();

    if query_lower.is_empty() {
        let mut results: Vec<String> = files.into_iter().take(20).collect();
        results.sort();
        return Ok(results);
    }

    let query_chars: Vec<char> = query_lower.chars().collect();
    let mut results: Vec<(String, i32)> = Vec::new();

    for line in files.iter() {
        let line: &String = line;
        if line.is_empty() {
            continue;
        }
        let line_lower = line.to_lowercase();
        let filename = line.rsplit('/').next().unwrap_or(line).to_lowercase();

        // Fuzzy match: all query chars must appear in order
        if let Some(score) = fuzzy_score(&query_chars, &query_lower, &line_lower, &filename) {
            results.push((line.to_string(), score));
        }
    }

    results.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    results.truncate(20);

    Ok(results.into_iter().map(|(path, _)| path).collect())
}

fn list_project_files(directory: &str) -> Vec<String> {
    use std::process::Command;

    // Use just `git ls-files` (reads from index, nearly instant) instead of
    // `--cached --others --exclude-standard` which scans the entire working tree.
    let git_result = Command::new("git")
        .args(["ls-files"])
        .current_dir(directory)
        .output();

    match git_result {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|l| !l.is_empty())
                .map(|l| l.to_string())
                .collect()
        }
        _ => {
            let mut found = Vec::new();
            let base = std::path::Path::new(directory);
            walk_dir_recursive(base, base, &mut found, 0);
            found
        }
    }
}

/// Fuzzy match query chars against a path. Returns Some(score) if all query chars
/// appear in order in the haystack, None otherwise. Higher score = better match.
fn fuzzy_score(query_chars: &[char], query: &str, path: &str, filename: &str) -> Option<i32> {
    let path_chars: Vec<char> = path.chars().collect();
    let mut qi = 0;
    let mut pi = 0;
    let mut score: i32 = 0;
    let mut prev_match_idx: Option<usize> = None;

    while qi < query_chars.len() && pi < path_chars.len() {
        if query_chars[qi] == path_chars[pi] {
            // Bonus for consecutive matches (characters appear adjacent)
            if let Some(prev) = prev_match_idx {
                if pi == prev + 1 {
                    score += 4;
                }
            }
            // Bonus for matching at word boundaries (after / . _ -)
            if pi == 0 || matches!(path_chars[pi - 1], '/' | '.' | '_' | '-') {
                score += 3;
            }
            prev_match_idx = Some(pi);
            qi += 1;
        }
        pi += 1;
    }

    if qi < query_chars.len() {
        return None; // not all query chars matched
    }

    // Exact substring match in filename is a big bonus
    if filename.contains(query) {
        score += 20;
    }
    // Filename starts with query
    if filename.starts_with(query) {
        score += 10;
    }
    // Prefer shorter paths
    score -= (path.len() as i32) / 20;

    Some(score)
}

fn walk_dir_recursive(base: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>, depth: u32) {
    const SKIP_DIRS: &[&str] = &[
        "node_modules", "target", ".git", ".hg", ".svn", "dist", "build",
        "__pycache__", ".next", ".nuxt", "vendor", ".worktrees",
    ];
    if depth > 12 { return; }
    let Ok(entries) = std::fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') && depth == 0 && name_str != ".github" { continue; }
        if let Ok(ft) = entry.file_type() {
            if ft.is_dir() {
                if SKIP_DIRS.contains(&name_str.as_ref()) { continue; }
                if name_str.starts_with('.') { continue; }
                walk_dir_recursive(base, &entry.path(), out, depth + 1);
            } else if ft.is_file() {
                if let Ok(rel) = entry.path().strip_prefix(base) {
                    out.push(rel.to_string_lossy().to_string());
                }
            }
        }
        if out.len() > 5000 { return; } // safety limit
    }
}

#[tauri::command]
fn open_in_editor(editor: String, file_path: String) -> Result<(), String> {
    let expanded = if file_path.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            file_path.replacen('~', &home, 1)
        } else {
            file_path
        }
    } else {
        file_path
    };
    if let Some(app_name) = editor.strip_prefix("app:") {
        // macOS app bundle — use `open -a "AppName" path`
        std::process::Command::new("open")
            .args(["-a", app_name, &expanded])
            .spawn()
            .map_err(|e| format!("Failed to open app '{}': {}", app_name, e))?;
    } else {
        std::process::Command::new(&editor)
            .arg(&expanded)
            .env("PATH", shell_path())
            .spawn()
            .map_err(|e| format!("Failed to open editor '{}': {}", editor, e))?;
    }
    Ok(())
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

/// Read file paths from the system pasteboard (macOS).
/// Uses osascript to get file URLs from Finder clipboard.
#[tauri::command]
fn get_clipboard_file_paths() -> Vec<String> {
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(r#"
            use framework "AppKit"
            set pb to current application's NSPasteboard's generalPasteboard()
            set urlClass to current application's NSURL
            set urls to pb's readObjectsForClasses:{urlClass} options:(missing value)
            if urls is missing value then return ""
            set paths to {}
            repeat with u in urls
                set end of paths to (u's |path|() as text)
            end repeat
            return (paths as list) as text
        "#)
        .output();

    match output {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if text.is_empty() {
                vec![]
            } else {
                text.split(", ").map(|s| s.to_string()).collect()
            }
        }
        Err(_) => vec![],
    }
}

#[tauri::command]
fn set_dock_badge(label: Option<String>) {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSApplication;
        use objc2_foundation::{MainThreadMarker, NSString};
        if let Some(mtm) = MainThreadMarker::new() {
            let app = NSApplication::sharedApplication(mtm);
            let tile = app.dockTile();
            match label {
                Some(text) => {
                    let ns_str = NSString::from_str(&text);
                    tile.setBadgeLabel(Some(&ns_str));
                }
                None => {
                    tile.setBadgeLabel(None);
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Write panics to ~/.claude/orchestrator-crash.log so crashes are visible
    // even when the app is launched from Finder (where stderr is not visible).
    let crash_log = std::env::var("HOME").ok()
        .map(|h| std::path::PathBuf::from(h).join(".claude").join("orchestrator-crash.log"));
    std::panic::set_hook(Box::new(move |info| {
        let msg = info.to_string();
        eprintln!("[PANIC] {}", msg);
        if let Some(ref path) = crash_log {
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .and_then(|mut f| {
                    use std::io::Write;
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    writeln!(f, "=== PANIC at unix:{ts} ===\n{msg}\n")
                });
        }
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // ── Start the embedded orchestrator-server ───────────────────────
            // This WS server is the single backend for both the Tauri WebView
            // and any browser clients connecting to http://localhost:2420.
            {
                let data_dir = app
                    .path()
                    .app_data_dir()
                    .expect("Failed to get app data dir");
                std::fs::create_dir_all(&data_dir).ok();

                // Resolve resource scripts (same logic as below for Tauri commands)
                let resource_dir = app
                    .handle()
                    .path()
                    .resource_dir()
                    .ok();
                let cargo_resources = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("resources");

                let find_resource = |filename: &str| -> Option<String> {
                    let candidates = [
                        resource_dir.as_ref().map(|d| d.join("resources").join(filename)),
                        Some(cargo_resources.join(filename)),
                    ];
                    candidates
                        .into_iter()
                        .flatten()
                        .find(|p| p.exists())
                        .map(|p| p.to_string_lossy().to_string())
                };

                let mcp_script_path = find_resource("mcp-server.bundle.mjs");
                let title_script_path = find_resource("title-server.bundle.mjs")
                    .map(PathBuf::from);

                let bridges = [
                    ("claude-code", "agent-bridge.bundle.mjs"),
                    ("opencode", "agent-bridge-opencode.bundle.mjs"),
                    ("codex", "agent-bridge-codex.bundle.mjs"),
                ];
                let mut agent_script_paths = std::collections::HashMap::new();
                for (provider, filename) in bridges {
                    if let Some(path) = find_resource(filename) {
                        agent_script_paths.insert(provider.to_string(), path);
                    }
                }

                // Resolve the frontend dist dir for static file serving
                let static_dir = {
                    let candidates = [
                        // Production: bundled in app resources
                        resource_dir.as_ref().map(|d| d.join("dist")),
                        // Dev: project root dist/
                        Some(
                            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                                .parent()
                                .unwrap()
                                .join("dist"),
                        ),
                    ];
                    candidates.into_iter().flatten().find(|p| p.join("index.html").exists())
                };

                let config = orchestrator_core::ServerConfig {
                    data_dir,
                    mcp_script_path,
                    agent_script_paths,
                    title_script_path,
                };

                let port: u16 = std::env::var("ORCHESTRATOR_PORT")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(2420);

                eprintln!("[tauri] Starting embedded orchestrator-server on port {}", port);

                // Use a channel to get the actual port back from the server thread.
                // The outer loop restarts the server if the thread panics.
                let (port_tx, port_rx) = std::sync::mpsc::channel::<u16>();
                std::thread::spawn(move || {
                    let port_tx = std::sync::Mutex::new(Some(port_tx));
                    loop {
                        let config = config.clone();
                        let static_dir = static_dir.clone();
                        let port_tx_ref = &port_tx;
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            let rt = tokio::runtime::Builder::new_multi_thread()
                                .enable_all()
                                .build()
                                .expect("Failed to create tokio runtime");
                            rt.block_on(async move {
                                let actual_port = orchestrator_server::start_server(config, port, static_dir).await;
                                if let Some(tx) = port_tx_ref.lock().unwrap().take() {
                                    let _ = tx.send(actual_port);
                                }
                                // Keep runtime alive — server runs in a spawned task
                                std::future::pending::<()>().await;
                            });
                        }));
                        if let Err(e) = result {
                            let msg = format!("[tauri] Orchestrator server panicked: {:?}. Restarting in 1s...", e);
                            eprintln!("{}", msg);
                            // Also append to crash log
                            if let Ok(home) = std::env::var("HOME") {
                                let path = std::path::PathBuf::from(home).join(".claude").join("orchestrator-crash.log");
                                let _ = std::fs::OpenOptions::new()
                                    .create(true)
                                    .append(true)
                                    .open(path)
                                    .and_then(|mut f| {
                                        use std::io::Write;
                                        let ts = std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .unwrap_or_default()
                                            .as_secs();
                                        writeln!(f, "=== SERVER CRASH at unix:{ts} ===\n{msg}\n")
                                    });
                            }
                            std::thread::sleep(std::time::Duration::from_secs(1));
                        } else {
                            break; // normal exit (shouldn't happen due to pending())
                        }
                    }
                });

                // Wait for the server to bind (should be near-instant)
                let actual_port = port_rx.recv_timeout(std::time::Duration::from_secs(10))
                    .expect("Orchestrator server failed to start within 10s");
                eprintln!("[tauri] Orchestrator server listening on port {}", actual_port);

                // Inject the port into the WebView so bridge.ts can find it.
                // Also persist to localStorage so it survives page reloads.
                let webview = app.get_webview_window("main")
                    .expect("Failed to get main webview window");
                webview.eval(&format!(
                    "window.__ORCHESTRATOR_PORT__ = {port}; localStorage.setItem('__ORCHESTRATOR_PORT__', '{port}');",
                    port = actual_port
                )).expect("Failed to inject port into webview");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // The orchestrator-server thread will be killed when the
                // process exits. Just exit cleanly.
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
