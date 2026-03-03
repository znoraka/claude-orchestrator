use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const SIGNAL_DIR: &str = "/tmp/orchestrator-signals";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorSignal {
    pub action: String,
    pub directory: String,
    pub session_name: Option<String>,
    pub session_id: String,
}

/// Polls `/tmp/orchestrator-signals/` for JSON signal files written by the MCP server.
/// When a `.json` file is found, it is parsed and emitted as a Tauri event, then deleted.
pub struct SignalWatcher {
    _handle: std::thread::JoinHandle<()>,
}

impl SignalWatcher {
    pub fn new(app_handle: AppHandle) -> Result<Self, String> {
        // Ensure the signal directory exists
        fs::create_dir_all(SIGNAL_DIR)
            .map_err(|e| format!("Failed to create signal dir: {}", e))?;

        let signal_dir = PathBuf::from(SIGNAL_DIR);

        eprintln!("[signal_watcher] Polling {} every 200ms", SIGNAL_DIR);

        let handle = std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(200));

                let entries = match fs::read_dir(&signal_dir) {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue;
                    }

                    // Read and parse the signal file
                    let contents = match fs::read_to_string(&path) {
                        Ok(c) => c,
                        Err(_) => continue,
                    };

                    // Delete immediately to avoid re-processing
                    let _ = fs::remove_file(&path);

                    let mut signal: OrchestratorSignal = match serde_json::from_str(&contents) {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("[signal_watcher] Failed to parse {:?}: {}", path, e);
                            continue;
                        }
                    };

                    // Normalize absolute paths to ~-relative form for consistency
                    // with list_worktrees/list_directories which also use ~ prefix.
                    if let Ok(home) = std::env::var("HOME") {
                        if !home.is_empty() && signal.directory.starts_with(&home) {
                            signal.directory = format!("~{}", &signal.directory[home.len()..]);
                        }
                    }

                    eprintln!(
                        "[signal_watcher] Received signal: action={}, directory={}, from_session={}",
                        signal.action, signal.directory, signal.session_id
                    );

                    if let Err(e) = app_handle.emit("orchestrator-signal", &signal) {
                        eprintln!("[signal_watcher] Failed to emit event: {}", e);
                    }
                }
            }
        });

        Ok(Self { _handle: handle })
    }

    /// Clean up any stale signal files from previous runs.
    pub fn cleanup_stale() {
        if let Ok(entries) = fs::read_dir(SIGNAL_DIR) {
            for entry in entries.flatten() {
                if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}
