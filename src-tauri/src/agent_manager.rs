use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

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
}

impl AgentManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            history: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawn the agent bridge process for a session.
    pub fn create_session(
        &self,
        session_id: &str,
        app_handle: AppHandle,
        bridge_script_path: &str,
        config_json: &str,
    ) -> Result<(), String> {
        // Destroy existing session if any
        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            if let Some(mut old) = sessions.remove(session_id) {
                #[cfg(unix)]
                kill_process_group(old.pid);
                let _ = old.child.kill();
            }
        }

        // Clear history for fresh session
        {
            let mut history = self.history.lock().map_err(|e| e.to_string())?;
            history.remove(session_id);
        }

        // Ensure history directory exists for persistence
        let hist_dir = history_dir();
        let _ = std::fs::create_dir_all(&hist_dir);
        let hist_file = history_file_for(session_id);
        // Clear disk history so a remount after edit/recreate doesn't replay stale messages
        let _ = std::fs::remove_file(&hist_file);

        let path_env = super::shell_path();

        // Resolve absolute path to `node` using the shell PATH
        // (macOS GUI apps have minimal PATH that doesn't include nvm/fnm/homebrew)
        let node_bin = super::resolve_bin("node")
            .ok_or_else(|| "Could not find `node` binary. Is Node.js installed?".to_string())?;

        // Ensure HOME is set (macOS GUI apps may not inherit it from launchd)
        let home = std::env::var("HOME")
            .unwrap_or_else(|_| format!("/Users/{}", std::env::var("USER").unwrap_or_default()));

        // Extract cwd from config for the bridge process itself
        let bridge_cwd = serde_json::from_str::<serde_json::Value>(config_json)
            .ok()
            .and_then(|v| v.get("cwd").and_then(|c| c.as_str().map(String::from)))
            .unwrap_or_else(|| home.clone());

        // Expand leading ~ to HOME (Command::current_dir doesn't do shell expansion)
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

        // Stdout reader thread: emit each JSON line as a Tauri event
        let app_handle_clone = app_handle.clone();
        let sid_clone = sid.clone();
        let history_clone = Arc::clone(&history_ref);
        let sessions_clone = Arc::clone(&self.sessions);
        let hist_file_clone = hist_file.clone();
        thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            // Open file in append mode for persisting bridge output
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

                // Store in history (memory)
                if let Ok(mut hist) = history_clone.lock() {
                    let entry = hist.entry(sid_clone.clone()).or_insert_with(Vec::new);
                    entry.push(line.clone());
                    if entry.len() > MAX_HISTORY_MESSAGES {
                        let drain_count = entry.len() - MAX_HISTORY_MESSAGES;
                        entry.drain(..drain_count);
                    }
                }

                // Persist to disk for session restore
                if let Some(ref mut f) = disk_file {
                    let _ = writeln!(f, "{}", line);
                    let _ = f.flush();
                }

                let event_name = format!("agent-message-{}", sid_clone);
                let _ = app_handle_clone.emit(&event_name, &line);
            }

            // Process exited — remove session and capture exit code
            let mut exit_code: Option<i32> = None;
            if let Ok(mut sessions) = sessions_clone.lock() {
                if let Some(mut session) = sessions.remove(&sid_clone) {
                    if let Ok(status) = session.child.wait() {
                        exit_code = status.code();
                    }
                }
            }
            let exit_event = format!("agent-exit-{}", sid_clone);
            // None means the session was already removed (intentional destroy_session kill)
            // or the process was killed by a signal — treat both as clean exit (0).
            let code = exit_code.unwrap_or(0);
            let _ = app_handle_clone.emit(&exit_event, code.to_string());
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

    /// Send a JSON line to the bridge's stdin.
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
        session
            .stdin
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to agent stdin: {}", e))?;
        session
            .stdin
            .flush()
            .map_err(|e| format!("Failed to flush agent stdin: {}", e))?;
        drop(sessions);

        // Store user message in history (memory)
        if let Ok(mut hist) = self.history.lock() {
            let entry = hist.entry(session_id.to_string()).or_insert_with(Vec::new);
            entry.push(json_line.to_string());
        }

        // Persist user message to disk
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

    /// Send an abort command to the bridge and hard-kill the entire process group.
    pub fn abort(&self, session_id: &str) -> Result<(), String> {
        // Send graceful abort first (best-effort)
        let _ = self.send_message(session_id, r#"{"type":"abort"}"#);

        // Hard-kill the entire process group (bridge + CLI + subtree)
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(session) = sessions.get_mut(session_id) {
            #[cfg(unix)]
            kill_process_group(session.pid);
            let _ = session.child.kill();
        }
        Ok(())
    }

    /// Kill the bridge process and clean up.
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
        // Keep history for replay if component remounts
        Ok(())
    }

    /// Return accumulated JSON-line history for replay.
    /// Falls back to reading from disk if in-memory history is empty (e.g. after app restart).
    pub fn get_history(&self, session_id: &str) -> Result<Vec<String>, String> {
        let history = self.history.lock().map_err(|e| e.to_string())?;
        if let Some(lines) = history.get(session_id) {
            if !lines.is_empty() {
                return Ok(lines.clone());
            }
        }
        drop(history);

        // Fall back to persisted file on disk
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

    /// Check if a session exists and its process is still running.
    #[allow(dead_code)]
    pub fn is_alive(&self, session_id: &str) -> bool {
        let mut sessions = match self.sessions.lock() {
            Ok(s) => s,
            Err(_) => return false,
        };
        if let Some(session) = sessions.get_mut(session_id) {
            // try_wait returns Ok(Some(status)) if exited, Ok(None) if still running
            match session.child.try_wait() {
                Ok(None) => true,
                _ => false,
            }
        } else {
            false
        }
    }
}
