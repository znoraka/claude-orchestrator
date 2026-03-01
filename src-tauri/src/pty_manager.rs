use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_session(
        &self,
        session_id: &str,
        app_handle: AppHandle,
        directory: String,
        claude_session_id: Option<String>,
        resume: bool,
        dangerously_skip_permissions: bool,
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

        // Build the claude command with flags
        let mut claude_args = vec!["claude".to_string()];
        if dangerously_skip_permissions {
            claude_args.push("--dangerously-skip-permissions".to_string());
        }
        if let Some(ref sid) = claude_session_id {
            if resume {
                claude_args.push("--resume".to_string());
                claude_args.push(sid.clone());
            } else {
                claude_args.push("--session-id".to_string());
                claude_args.push(sid.clone());
            }
        }
        let claude_cmd = claude_args.join(" ");

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

        let shell_cmd = format!("cd '{}' && exec {}", expanded_dir, claude_cmd);
        eprintln!("[pty_manager] Spawning: {} -lc \"{}\"", shell, shell_cmd);
        cmd.arg("-lc");
        cmd.arg(&shell_cmd);

        pair.slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn claude: {}", e))?;

        // Drop slave – we only need master side
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

        // Spawn a thread to read PTY output and emit events to the frontend
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            // Buffer for incomplete UTF-8 sequences split across reads
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // Flush any remaining pending bytes before closing
                        if !pending.is_empty() {
                            let data = String::from_utf8_lossy(&pending).to_string();
                            let _ = app_handle.emit(&format!("pty-output-{}", sid), data);
                        }
                        let _ = app_handle.emit(&format!("pty-exit-{}", sid), ());
                        break;
                    }
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);

                        // Find the last valid UTF-8 boundary in pending
                        let valid_up_to = match std::str::from_utf8(&pending) {
                            Ok(_) => pending.len(),
                            Err(e) => e.valid_up_to(),
                        };

                        if valid_up_to > 0 {
                            // Safety: we just validated this range is valid UTF-8
                            let data = unsafe {
                                std::str::from_utf8_unchecked(&pending[..valid_up_to])
                            };
                            let _ = app_handle.emit(
                                &format!("pty-output-{}", sid),
                                data.to_string(),
                            );
                        }

                        // Keep any trailing incomplete bytes for the next read
                        if valid_up_to < pending.len() {
                            let remaining = pending[valid_up_to..].to_vec();
                            pending.clear();
                            pending.extend_from_slice(&remaining);
                        } else {
                            pending.clear();
                        }
                    }
                    Err(_) => {
                        let _ = app_handle.emit(&format!("pty-exit-{}", sid), ());
                        break;
                    }
                }
            }
        });

        let session = PtySession {
            writer,
            master: pair.master,
        };

        self.sessions
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?
            .insert(session_id.to_string(), session);

        Ok(())
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

    pub fn destroy_session(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        sessions.remove(session_id);
        Ok(())
    }
}
