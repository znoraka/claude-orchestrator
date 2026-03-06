use notify_debouncer_mini::new_debouncer;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Use a distinct signal directory for debug (dev) vs release (built) to avoid
/// two instances racing on the same signal files.
#[cfg(debug_assertions)]
const SIGNAL_DIR: &str = "/tmp/orchestrator-signals-dev";
#[cfg(not(debug_assertions))]
const SIGNAL_DIR: &str = "/tmp/orchestrator-signals";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorSignal {
    pub action: String,
    pub directory: String,
    pub session_name: Option<String>,
    pub session_id: String,
}

/// Watches `/tmp/orchestrator-signals/` for JSON signal files using OS file-system
/// notifications (via `notify`). When a `.json` file appears, it is parsed, emitted
/// as a Tauri event, and deleted.
pub struct SignalWatcher {
    _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
}

impl SignalWatcher {
    pub fn new(app_handle: AppHandle) -> Result<Self, String> {
        // Ensure the signal directory exists
        fs::create_dir_all(SIGNAL_DIR)
            .map_err(|e| format!("Failed to create signal dir: {}", e))?;

        let signal_dir = PathBuf::from(SIGNAL_DIR);

        // Process any signals already present at startup
        Self::process_signals(&signal_dir, &app_handle);

        eprintln!("[signal_watcher] Watching {} with notify", SIGNAL_DIR);

        let dir_for_callback = signal_dir.clone();
        let mut debouncer = new_debouncer(
            Duration::from_millis(100),
            move |results: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
                match results {
                    Ok(_) => Self::process_signals(&dir_for_callback, &app_handle),
                    Err(e) => eprintln!("[signal_watcher] Watcher error: {:?}", e),
                }
            },
        )
        .map_err(|e| format!("Failed to create signal watcher: {}", e))?;

        debouncer
            .watcher()
            .watch(&signal_dir, notify::RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch signal dir: {}", e))?;

        Ok(Self {
            _debouncer: debouncer,
        })
    }

    /// Scan the signal directory for `.json` files, process each one, and delete it.
    fn process_signals(signal_dir: &PathBuf, app_handle: &AppHandle) {
        let entries = match fs::read_dir(signal_dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }

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

            // Normalize absolute paths to ~-relative form
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
