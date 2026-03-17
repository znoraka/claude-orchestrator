use notify_debouncer_mini::{new_debouncer, DebouncedEventKind};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::{EventSender, ServerEvent};

/// Watches JSONL files and emits `JsonlChanged` events when they are modified.
pub struct JsonlWatcher {
    watched: Arc<Mutex<HashSet<PathBuf>>>,
    _debouncer: notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
}

impl JsonlWatcher {
    pub fn new(event_tx: EventSender) -> Result<Self, String> {
        let watched: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));
        let watched_clone = watched.clone();

        let debouncer = new_debouncer(
            Duration::from_millis(500),
            move |results: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
                let events = match results {
                    Ok(evts) => evts,
                    Err(e) => {
                        eprintln!("[file_watcher] Error: {:?}", e);
                        return;
                    }
                };
                let watched_set = match watched_clone.lock() {
                    Ok(s) => s,
                    Err(_) => return,
                };
                for event in events {
                    if event.kind != DebouncedEventKind::Any {
                        continue;
                    }
                    let path = &event.path;
                    if watched_set.contains(path) {
                        let path_str = path.to_string_lossy().to_string();
                        event_tx.emit(ServerEvent::JsonlChanged { path: path_str });
                    }
                }
            },
        )
        .map_err(|e| format!("Failed to create file watcher: {}", e))?;

        Ok(Self {
            watched,
            _debouncer: debouncer,
        })
    }

    pub fn watch(&mut self, path: PathBuf) -> Result<(), String> {
        let mut watched = self.watched.lock().map_err(|e| e.to_string())?;
        if watched.contains(&path) {
            return Ok(());
        }

        let dir = path.parent().ok_or("No parent directory")?;
        if dir.exists() {
            self._debouncer
                .watcher()
                .watch(dir, notify::RecursiveMode::NonRecursive)
                .map_err(|e| format!("Failed to watch {:?}: {}", dir, e))?;
        }

        watched.insert(path);
        Ok(())
    }

    pub fn unwatch(&mut self, path: &PathBuf) -> Result<(), String> {
        let mut watched = self.watched.lock().map_err(|e| e.to_string())?;
        if !watched.remove(path) {
            return Ok(());
        }

        if let Some(dir) = path.parent() {
            let still_watching_dir = watched.iter().any(|p| p.parent() == Some(dir));
            if !still_watching_dir {
                let _ = self._debouncer.watcher().unwatch(dir);
            }
        }

        Ok(())
    }
}
