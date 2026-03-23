use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

use crate::ingest::LiveIngestor;
use crate::{EventSender, ServerEvent};

/// Maximum stored messages per session for replay on component remount.
const MAX_HISTORY_MESSAGES: usize = 10_000;

/// Directory where bridge output is persisted for session restore.
fn history_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home)
        .join(".claude-orchestrator")
        .join("history")
}

fn history_file_for(session_id: &str) -> PathBuf {
    history_dir().join(format!("{}.jsonl", session_id))
}

pub struct AgentSession {
    stdin: ChildStdin,
    child: Child,
    pid: u32,
}

#[cfg(unix)]
fn kill_process_group(pid: u32) {
    let _ = Command::new("kill")
        .args(["-9", &format!("-{}", pid)])
        .env("PATH", "/bin:/usr/bin")
        .status();
}

pub struct AgentManager {
    sessions: Arc<Mutex<HashMap<String, AgentSession>>>,
    history: Arc<Mutex<HashMap<String, Vec<String>>>>,
    busy_sessions: Arc<Mutex<HashSet<String>>>,
}

impl AgentManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            history: Arc::new(Mutex::new(HashMap::new())),
            busy_sessions: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn get_busy_sessions(&self) -> Vec<String> {
        self.busy_sessions.lock().map(|s| s.iter().cloned().collect()).unwrap_or_default()
    }

    /// Spawn the agent bridge process for a session.
    pub fn create_session(
        &self,
        session_id: &str,
        event_tx: EventSender,
        bridge_script_path: &str,
        config_json: &str,
        db: Option<Arc<Mutex<rusqlite::Connection>>>,
        claude_session_id: Option<String>,
        directory: Option<String>,
    ) -> Result<(), String> {
        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            if let Some(mut old) = sessions.remove(session_id) {
                let _ = old.child.kill();
            }
        }
        {
            let mut history = self.history.lock().map_err(|e| e.to_string())?;
            history.remove(session_id);
        }
        {
            let mut busy = self.busy_sessions.lock().map_err(|e| e.to_string())?;
            busy.remove(session_id);
        }

        let hist_dir = history_dir();
        let _ = std::fs::create_dir_all(&hist_dir);
        let hist_file = history_file_for(session_id);

        let path_env = crate::utils::shell_path();
        let node_bin = crate::utils::resolve_bin("node")
            .ok_or_else(|| "Could not find `node` binary. Is Node.js installed?".to_string())?;

        let home = std::env::var("HOME")
            .unwrap_or_else(|_| format!("/Users/{}", std::env::var("USER").unwrap_or_default()));

        let bridge_cwd = serde_json::from_str::<serde_json::Value>(config_json)
            .ok()
            .and_then(|v| v.get("cwd").and_then(|c| c.as_str().map(String::from)))
            .unwrap_or_else(|| home.clone());

        let bridge_cwd = if bridge_cwd.starts_with("~/") {
            format!("{}/{}", home, &bridge_cwd[2..])
        } else if bridge_cwd == "~" {
            home.clone()
        } else {
            bridge_cwd
        };

        eprintln!(
            "[agent_manager] node: {}, bridge: {}, cwd: {}",
            node_bin, bridge_script_path, bridge_cwd
        );

        let mut cmd = Command::new(&node_bin);
        cmd.arg(bridge_script_path)
            .arg(config_json)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(&bridge_cwd)
            .env("PATH", path_env)
            .env("HOME", &home);
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "Failed to spawn agent bridge (node={}, cwd={}): {}",
                node_bin, bridge_cwd, e
            )
        })?;
        let pid = child.id();

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture stderr".to_string())?;

        let sid = session_id.to_string();
        let history_ref = Arc::clone(&self.history);
        let busy_sessions_clone = Arc::clone(&self.busy_sessions);

        // Build a LiveIngestor if we have DB + claude_session_id
        let live_ingestor = match (db, claude_session_id, directory) {
            (Some(db), Some(csid), Some(dir)) => Some(Mutex::new(LiveIngestor::new(db, csid, dir))),
            _ => None,
        };

        // Stdout reader thread: emit each JSON line as an event
        let event_tx_clone = event_tx.clone();
        let sid_clone = sid.clone();
        let history_clone = Arc::clone(&history_ref);
        let sessions_clone = Arc::clone(&self.sessions);
        let hist_file_clone = hist_file.clone();
        thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            let mut disk_file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&hist_file_clone)
                .ok();
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if line.is_empty() {
                    continue;
                }

                if let Ok(mut hist) = history_clone.lock() {
                    let entry = hist.entry(sid_clone.clone()).or_insert_with(Vec::new);
                    entry.push(line.clone());
                    if entry.len() > MAX_HISTORY_MESSAGES {
                        let drain_count = entry.len() - MAX_HISTORY_MESSAGES;
                        entry.drain(..drain_count);
                    }
                }

                if let Some(ref mut f) = disk_file {
                    let _ = writeln!(f, "{}", line);
                    let _ = f.flush();
                }

                // Ingest directly into DB (bypasses JSONL file watcher)
                if let Some(ref ingestor) = live_ingestor {
                    if let Ok(mut ing) = ingestor.lock() {
                        if ing.ingest_line(&line) {
                            // Don't emit MessagesIngested on every line — batch
                            // notifications are handled below via AgentMessage
                        }
                    }
                }

                // Track busy state: assistant → busy, terminal events → not busy
                if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(msg_type) = msg.get("type").and_then(|v| v.as_str()) {
                        match msg_type {
                            "assistant" => {
                                let was_busy = busy_sessions_clone.lock()
                                    .map(|mut s| { let added = s.insert(sid_clone.clone()); !added })
                                    .unwrap_or(true);
                                if !was_busy {
                                    event_tx_clone.emit(ServerEvent::SessionBusyChanged {
                                        session_id: sid_clone.clone(),
                                        is_busy: true,
                                    });
                                }
                            }
                            "result" | "query_complete" | "error" | "aborted" => {
                                let removed = busy_sessions_clone.lock()
                                    .map(|mut s| s.remove(&sid_clone))
                                    .unwrap_or(false);
                                if removed {
                                    event_tx_clone.emit(ServerEvent::SessionBusyChanged {
                                        session_id: sid_clone.clone(),
                                        is_busy: false,
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                }

                event_tx_clone.emit(ServerEvent::AgentMessage {
                    session_id: sid_clone.clone(),
                    line: line.clone(),
                });
            }

            // Finalize ingest tracking so the file watcher knows our seq
            if let Some(ref ingestor) = live_ingestor {
                if let Ok(ing) = ingestor.lock() {
                    ing.finalize();
                }
            }

            // Process exited — remove session and capture exit code.
            // IMPORTANT: take the session out of the map quickly and drop the
            // lock BEFORE calling child.wait().  wait() can block if the process
            // group hasn't fully exited yet, and holding the lock during that
            // time prevents send_message / other operations from proceeding.
            let removed = sessions_clone.lock().ok()
                .and_then(|mut s| s.remove(&sid_clone));
            let mut exit_code: Option<i32> = None;
            if let Some(mut session) = removed {
                if let Ok(status) = session.child.wait() {
                    exit_code = status.code();
                }
            }
            // None means the session was already removed (intentional destroy_session kill)
            // or the process was killed by a signal — treat both as clean exit (0).
            let code = exit_code.unwrap_or(0);
            // Ensure busy state is cleared on exit (handles crashes/kills)
            let was_busy = busy_sessions_clone.lock()
                .map(|mut s| s.remove(&sid_clone))
                .unwrap_or(false);
            if was_busy {
                event_tx_clone.emit(ServerEvent::SessionBusyChanged {
                    session_id: sid_clone.clone(),
                    is_busy: false,
                });
            }
            event_tx_clone.emit(ServerEvent::AgentExit {
                session_id: sid_clone.clone(),
                code,
            });
        });

        // Stderr reader thread: log to eprintln
        let sid_stderr = sid.clone();
        thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(l) => eprintln!("[agent-bridge:{}] {}", sid_stderr, l),
                    Err(_) => break,
                }
            }
        });

        let session = AgentSession { stdin, child, pid };
        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions.insert(sid, session);
        }

        Ok(())
    }

    pub fn send_message(&self, session_id: &str, json_line: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Agent session not found: {}", session_id))?;
        let data = if json_line.ends_with('\n') {
            json_line.to_string()
        } else {
            format!("{}\n", json_line)
        };
        session.stdin.write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to agent stdin: {}", e))?;
        session.stdin.flush()
            .map_err(|e| format!("Failed to flush agent stdin: {}", e))?;
        drop(sessions);

        if let Ok(mut hist) = self.history.lock() {
            let entry = hist.entry(session_id.to_string()).or_insert_with(Vec::new);
            entry.push(json_line.to_string());
        }

        let hist_path = history_file_for(session_id);
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&hist_path)
        {
            let _ = writeln!(file, "{}", json_line);
            let _ = file.flush();
        }

        Ok(())
    }

    pub fn abort(&self, session_id: &str) -> Result<(), String> {
        let _ = self.send_message(session_id, r#"{"type":"abort"}"#);
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(session) = sessions.get_mut(session_id) {
            #[cfg(unix)]
            kill_process_group(session.pid);
            let _ = session.child.kill();
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_id, mut session) in sessions.drain() {
                #[cfg(unix)]
                kill_process_group(session.pid);
                let _ = session.child.kill();
            }
        }
    }

    pub fn destroy_session(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(mut session) = sessions.remove(session_id) {
            #[cfg(unix)]
            kill_process_group(session.pid);
            let _ = session.child.kill();
        }
        Ok(())
    }

    pub fn get_history(&self, session_id: &str) -> Result<Vec<String>, String> {
        let history = self.history.lock().map_err(|e| e.to_string())?;
        if let Some(lines) = history.get(session_id) {
            if !lines.is_empty() {
                return Ok(lines.clone());
            }
        }
        drop(history);

        let path = history_file_for(session_id);
        if path.exists() {
            use std::io::{BufRead, BufReader};
            let file = std::fs::File::open(&path)
                .map_err(|e| format!("Failed to open history file: {}", e))?;
            let reader = BufReader::new(file);
            let lines: Vec<String> = reader
                .lines()
                .filter_map(|l| l.ok())
                .filter(|l| !l.is_empty())
                .collect();
            return Ok(lines);
        }

        Ok(vec![])
    }

    #[allow(dead_code)]
    pub fn is_alive(&self, session_id: &str) -> bool {
        let mut sessions = match self.sessions.lock() {
            Ok(s) => s,
            Err(_) => return false,
        };
        if let Some(session) = sessions.get_mut(session_id) {
            matches!(session.child.try_wait(), Ok(None))
        } else {
            false
        }
    }
}
