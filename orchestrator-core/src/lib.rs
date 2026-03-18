pub mod agent_manager;
pub mod commands;
pub mod db;
pub mod file_watcher;
pub mod pty_manager;
pub mod signal_watcher;
pub mod utils;

pub use agent_manager::AgentManager;
pub use db::{db_get_usage_cache, db_load_sessions, db_migrate_from_json, db_save_sessions,
             db_set_usage_cache, open_db};
pub use file_watcher::JsonlWatcher;
pub use pty_manager::PtyManager;
pub use signal_watcher::{OrchestratorSignal, SignalWatcher};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicU16;

// ── Event bus ──────────────────────────────────────────────────────────────

/// Replaces every `app_handle.emit()` call. Backend components hold a clone of
/// this sender; the Tauri shim (or Axum WS handler) subscribes and forwards.
#[derive(Clone)]
pub struct EventSender(pub tokio::sync::broadcast::Sender<ServerEvent>);

impl EventSender {
    pub fn new() -> (Self, tokio::sync::broadcast::Receiver<ServerEvent>) {
        let (tx, rx) = tokio::sync::broadcast::channel(512);
        (Self(tx), rx)
    }

    /// Best-effort send — silently drops if all receivers are gone.
    pub fn emit(&self, event: ServerEvent) {
        let _ = self.0.send(event);
    }
}

/// All push events emitted by the backend.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerEvent {
    AgentMessage {
        #[serde(rename = "sessionId")]
        session_id: String,
        line: String,
    },
    AgentExit {
        #[serde(rename = "sessionId")]
        session_id: String,
        code: i32,
    },
    PtyOutput {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: String,
    },
    PtyExit {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    JsonlChanged {
        path: String,
    },
    OrchestratorSignal {
        signal: OrchestratorSignal,
    },
    SessionsChanged,
}

// ── Config ─────────────────────────────────────────────────────────────────

/// Paths/config the server needs at startup, populated by the host
/// (Tauri, standalone server, etc.).
pub struct ServerConfig {
    pub data_dir: PathBuf,
    pub mcp_script_path: Option<String>,
    pub agent_script_paths: HashMap<String, String>,
    pub title_script_path: Option<PathBuf>,
}

// ── Shared types ───────────────────────────────────────────────────────────

/// Cached result for a JSONL file, invalidated when mtime changes.
pub(crate) struct CachedEntry<T> {
    pub(crate) mtime: std::time::SystemTime,
    pub(crate) value: T,
}

/// Incremental cache entry for usage: tracks byte offset so we only parse new lines.
pub(crate) struct IncrementalUsageEntry {
    pub(crate) byte_offset: u64,
    pub(crate) value: SessionUsage,
}

/// Incremental cache entry for conversation lines.
pub(crate) struct ConversationCacheEntry {
    pub(crate) byte_offset: u64,
    pub(crate) mtime: std::time::SystemTime,
    pub(crate) lines: Vec<String>,
}

/// Caches expensive JSONL parsing results, keyed by file path.
pub struct JsonlCache {
    pub(crate) usage: HashMap<PathBuf, IncrementalUsageEntry>,
    pub(crate) title: HashMap<PathBuf, CachedEntry<Option<String>>>,
    pub(crate) conversation: HashMap<PathBuf, ConversationCacheEntry>,
}

impl JsonlCache {
    pub fn new() -> Self {
        Self {
            usage: HashMap::new(),
            title: HashMap::new(),
            conversation: HashMap::new(),
        }
    }
}

/// Per-model pricing: (input, output, cache_create, cache_read) per 1M tokens.
#[derive(Serialize, Deserialize, Clone)]
pub struct ModelPricing {
    pub input: f64,
    pub output: f64,
    pub cache_create: f64,
    pub cache_read: f64,
}

/// Pricing config loaded from disk, keyed by model substring match.
#[derive(Serialize, Deserialize, Clone)]
pub struct PricingConfig {
    /// Ordered list of (model_contains_substring, pricing).
    pub models: Vec<(String, ModelPricing)>,
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
    pub fn load() -> Self {
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

    pub fn lookup(&self, model: &str) -> (f64, f64, f64, f64) {
        for (pattern, p) in &self.models {
            if model.contains(pattern.as_str()) {
                return (p.input, p.output, p.cache_create, p.cache_read);
            }
        }
        (3.0, 15.0, 3.75, 0.30)
    }
}

pub struct FileListCache {
    pub entries: HashMap<String, (std::time::Instant, Vec<String>)>,
}

/// Core server state — shared between command handlers and event sources.
pub struct ServerState {
    pub pty_manager: Mutex<PtyManager>,
    pub agent_manager: Arc<Mutex<AgentManager>>,
    pub jsonl_cache: Mutex<JsonlCache>,
    pub pricing: PricingConfig,
    pub file_watcher: Mutex<JsonlWatcher>,
    pub _signal_watcher: SignalWatcher,
    pub mcp_script_path: Option<String>,
    pub agent_script_paths: HashMap<String, String>,
    pub title_server_port: AtomicU16,
    pub _title_server_child: Mutex<Option<std::process::Child>>,
    pub file_list_cache: Mutex<FileListCache>,
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub event_tx: EventSender,
}

impl ServerState {
    pub fn new(config: ServerConfig) -> Result<(Arc<Self>, tokio::sync::broadcast::Receiver<ServerEvent>), String> {
        let (event_tx, event_rx) = EventSender::new();

        let watcher = JsonlWatcher::new(event_tx.clone())
            .map_err(|e| format!("Failed to create file watcher: {}", e))?;

        signal_watcher::SignalWatcher::cleanup_stale();
        let signal_watcher = SignalWatcher::new(event_tx.clone())
            .map_err(|e| format!("Failed to create signal watcher: {}", e))?;

        std::fs::create_dir_all(&config.data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;

        let db_conn = open_db(&config.data_dir)
            .map_err(|e| format!("Failed to open database: {}", e))?;

        // One-time migration from sessions.json
        {
            let count: i64 = db_conn
                .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
                .unwrap_or(0);
            if count == 0 {
                let json_path = config.data_dir.join("sessions.json");
                if json_path.exists() {
                    if let Ok(data) = std::fs::read_to_string(&json_path) {
                        if let Ok(legacy) = serde_json::from_str::<Vec<SessionMeta>>(&data) {
                            let n = legacy.len();
                            if let Err(e) = db_migrate_from_json(&db_conn, legacy) {
                                eprintln!("[db] Migration from sessions.json failed: {}", e);
                            } else {
                                eprintln!("[db] Migrated {} sessions from sessions.json", n);
                            }
                        }
                    }
                }
            }
        }

        let db = Arc::new(Mutex::new(db_conn));

        let state = Arc::new(Self {
            pty_manager: Mutex::new(PtyManager::new()),
            agent_manager: Arc::new(Mutex::new(AgentManager::new())),
            jsonl_cache: Mutex::new(JsonlCache::new()),
            pricing: PricingConfig::load(),
            file_watcher: Mutex::new(watcher),
            _signal_watcher: signal_watcher,
            mcp_script_path: config.mcp_script_path,
            agent_script_paths: config.agent_script_paths,
            title_server_port: AtomicU16::new(0),
            _title_server_child: Mutex::new(None),
            file_list_cache: Mutex::new(FileListCache { entries: HashMap::new() }),
            db,
            event_tx,
        });

        // Spawn title server
        if let Some(title_script) = config.title_script_path {
            eprintln!("[setup] Title server script found at {:?}", title_script);
            let state_clone = state.clone();
            std::thread::spawn(move || {
                let Some(node_bin) = utils::resolve_bin("node") else {
                    eprintln!("[setup] Cannot start title server: node binary not found");
                    return;
                };
                let claude_cli = utils::resolve_bin("claude");
                let opencode_cli = utils::resolve_bin("opencode");
                let title_config = serde_json::json!({
                    "claudeCliPath": claude_cli,
                    "opencodeCliPath": opencode_cli,
                });
                match std::process::Command::new(&node_bin)
                    .arg(title_script.to_string_lossy().as_ref())
                    .arg(title_config.to_string())
                    .env("PATH", utils::shell_path())
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::inherit())
                    .spawn()
                {
                    Ok(mut child) => {
                        if let Some(ref mut stdout) = child.stdout {
                            use std::io::BufRead;
                            let mut reader = std::io::BufReader::new(stdout);
                            let mut line = String::new();
                            if reader.read_line(&mut line).is_ok() {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                                    if let Some(port) = parsed.get("port").and_then(|p| p.as_u64()) {
                                        state_clone.title_server_port.store(port as u16, std::sync::atomic::Ordering::Relaxed);
                                        eprintln!("[setup] Title server started on port {}", port);
                                    }
                                }
                            }
                        }
                        child.stdout.take();
                        if let Ok(mut guard) = state_clone._title_server_child.lock() {
                            *guard = Some(child);
                        }
                    }
                    Err(e) => {
                        eprintln!("[setup] Failed to spawn title server: {}", e);
                    }
                }
            });
        } else {
            eprintln!("[setup] Title server script not found. Run `pnpm build:title-server` to build it.");
        }

        Ok((state, event_rx))
    }

    pub fn shutdown(&self) {
        if let Ok(mgr) = self.pty_manager.lock() {
            mgr.kill_all();
        }
        if let Ok(mgr) = self.agent_manager.lock() {
            mgr.kill_all();
        }
        if let Ok(mut child) = self._title_server_child.lock() {
            if let Some(mut c) = child.take() {
                let _ = c.kill();
            }
        }
    }
}

// ── Public types ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct SessionMeta {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: f64,
    #[serde(rename = "lastActiveAt")]
    pub last_active_at: f64,
    #[serde(default, rename = "lastMessageAt")]
    pub last_message_at: f64,
    #[serde(default)]
    pub directory: String,
    #[serde(default, rename = "homeDirectory", skip_serializing_if = "Option::is_none")]
    pub home_directory: Option<String>,
    #[serde(default, rename = "claudeSessionId", skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
    #[serde(default, rename = "dangerouslySkipPermissions")]
    pub dangerously_skip_permissions: bool,
    #[serde(default, rename = "permissionMode", skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, rename = "activeTime")]
    pub active_time: f64,
    #[serde(default, rename = "hasTitleBeenGenerated")]
    pub has_title_been_generated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, rename = "planContent", skip_serializing_if = "Option::is_none")]
    pub plan_content: Option<String>,
    #[serde(default, rename = "parentSessionId", skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, rename = "archivedAt", skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<f64>,
}

#[derive(Serialize, Clone, Default)]
pub struct SessionUsage {
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
    #[serde(rename = "cacheCreationInputTokens")]
    pub cache_creation_input_tokens: u64,
    #[serde(rename = "cacheReadInputTokens")]
    pub cache_read_input_tokens: u64,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
    #[serde(rename = "contextTokens")]
    pub context_tokens: u64,
    #[serde(rename = "isBusy")]
    pub is_busy: bool,
}
