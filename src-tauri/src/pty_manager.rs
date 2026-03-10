use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Maximum scrollback buffer size per session (1 MB).
const MAX_SCROLLBACK_BYTES: usize = 1_024 * 1_024;

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child_pid: Option<u32>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    /// Accumulated PTY output per session, replayed when the terminal remounts.
    scrollback: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            scrollback: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Retrieve accumulated scrollback for a session.
    pub fn get_scrollback(&self, session_id: &str) -> Result<String, String> {
        let scrollback = self.scrollback.lock().map_err(|e| format!("Lock error: {}", e))?;
        match scrollback.get(session_id) {
            Some(buf) => Ok(String::from_utf8_lossy(buf).to_string()),
            None => Ok(String::new()),
        }
    }

    pub fn write_to_session(&self, session_id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        if let Some(session) = sessions.get_mut(session_id) {
            session
                .writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("Write error: {}", e))?;
            session
                .writer
                .flush()
                .map_err(|e| format!("Flush error: {}", e))?;
            Ok(())
        } else {
            Err(format!("Session {} not found", session_id))
        }
    }

    pub fn resize_session(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        if let Some(session) = sessions.get(session_id) {
            session
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("Resize error: {}", e))?;
            Ok(())
        } else {
            Err(format!("Session {} not found", session_id))
        }
    }

    /// Spawn a plain login shell (no `claude` command) for the given session.
    pub fn create_shell_session(
        &self,
        session_id: &str,
        app_handle: AppHandle,
        directory: String,
    ) -> Result<(), String> {
        if directory.is_empty() {
            return Err("directory is required".to_string());
        }

        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        // Expand ~ in directory
        let expanded_dir = if directory.starts_with('~') {
            if let Ok(home) = std::env::var("HOME") {
                directory.replacen('~', &home, 1)
            } else {
                directory.clone()
            }
        } else {
            directory.clone()
        };

        // Spawn through shell with explicit cd to guarantee correct working directory
        // (portable-pty's cmd.cwd() is unreliable on macOS)
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");

        fn shell_escape_dir(s: &str) -> String {
            format!("'{}'", s.replace('\'', "'\\''"))
        }

        let escaped_dir = shell_escape_dir(&expanded_dir);
        let shell_cmd = format!("cd {} && exec {} -l", escaped_dir, shell_escape_dir(&shell));
        cmd.arg("-lc");
        cmd.arg(&shell_cmd);
        eprintln!("[pty_manager] Spawning shell: {} -lc \"{}\"", shell, shell_cmd);

        let child = pair.slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;

        let child_pid = child.process_id();

        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        let sid = session_id.to_string();
        let scrollback_buf = self.scrollback.clone();

        {
            let mut sb = scrollback_buf.lock().map_err(|e| format!("Lock error: {}", e))?;
            sb.entry(sid.clone()).or_insert_with(Vec::new);
        }

        let (tx, rx) = mpsc::channel::<Vec<u8>>();

        // Thread 1: reader — forwards raw bytes to channel, no batching logic
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            // tx dropped here → Disconnected signals emitter thread to exit
        });

        // Thread 2: emitter — batches received bytes and flushes on timer
        // recv_timeout ensures we flush within FLUSH_INTERVAL even when PTY goes idle,
        // fixing the bug where output was invisible until the user typed a character.
        thread::spawn(move || {
            const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

            let mut first_output = true;
            let mut pending = Vec::<u8>::new();
            let mut batch = String::new();
            let mut last_flush = Instant::now();

            macro_rules! flush_batch {
                () => {
                    if !batch.is_empty() {
                        let data = std::mem::take(&mut batch);
                        if let Ok(mut sb) = scrollback_buf.lock() {
                            if let Some(sbuf) = sb.get_mut(&sid) {
                                sbuf.extend_from_slice(data.as_bytes());
                                if sbuf.len() > MAX_SCROLLBACK_BYTES {
                                    let drain_to = sbuf.len() - MAX_SCROLLBACK_BYTES;
                                    sbuf.drain(..drain_to);
                                }
                            }
                        }
                        let event_name = format!("pty-output-{}", sid);
                        if let Err(e) = app_handle.emit(&event_name, data) {
                            eprintln!("[pty_manager] emit error for {}: {}", event_name, e);
                        }
                        last_flush = Instant::now();
                    }
                };
            }

            loop {
                match rx.recv_timeout(FLUSH_INTERVAL) {
                    Ok(bytes) => {
                        if first_output {
                            eprintln!("[pty_manager] shell first output for {} ({} bytes)", sid, bytes.len());
                            first_output = false;
                        }
                        pending.extend_from_slice(&bytes);

                        let valid_up_to = match std::str::from_utf8(&pending) {
                            Ok(_) => pending.len(),
                            Err(e) => e.valid_up_to(),
                        };

                        if valid_up_to > 0 {
                            let valid_str = unsafe {
                                std::str::from_utf8_unchecked(&pending[..valid_up_to])
                            };
                            batch.push_str(valid_str);
                        }

                        if valid_up_to < pending.len() {
                            let remaining = pending[valid_up_to..].to_vec();
                            pending = remaining;
                        } else {
                            pending.clear();
                        }

                        if last_flush.elapsed() >= FLUSH_INTERVAL {
                            flush_batch!();
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        // No new data for a full flush interval — emit whatever is pending
                        flush_batch!();
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        // Reader thread exited (EOF or error)
                        eprintln!("[pty_manager] shell reader EOF for {}", sid);
                        flush_batch!();
                        let _ = app_handle.emit(&format!("pty-exit-{}", sid), ());
                        break;
                    }
                }
            }
        });

        let session = PtySession {
            writer,
            master: pair.master,
            child_pid,
        };

        self.sessions
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?
            .insert(session_id.to_string(), session);

        Ok(())
    }

    /// Check if the shell process has any child processes (i.e. a command is running).
    pub fn has_child_process(&self, session_id: &str) -> Result<bool, String> {
        let sessions = self.sessions.lock().map_err(|e| format!("Lock error: {}", e))?;
        let session = sessions.get(session_id).ok_or_else(|| format!("Session {} not found", session_id))?;
        let pid = match session.child_pid {
            Some(pid) => pid,
            None => return Ok(false),
        };
        // Use pgrep -P to check if the shell has child processes
        let output = std::process::Command::new("pgrep")
            .arg("-P")
            .arg(pid.to_string())
            .output()
            .map_err(|e| format!("Failed to run pgrep: {}", e))?;
        Ok(output.status.success())
    }

    #[allow(dead_code)]
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.drain();
        }
    }

    pub fn destroy_session(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        sessions.remove(session_id);

        // Clean up scrollback buffer
        if let Ok(mut sb) = self.scrollback.lock() {
            sb.remove(session_id);
        }

        // Clean up MCP config directory
        let mcp_config_dir = format!("/tmp/orchestrator-mcp/{}", session_id);
        let _ = std::fs::remove_dir_all(&mcp_config_dir);

        Ok(())
    }
}
