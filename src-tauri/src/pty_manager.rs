use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

/// Maximum scrollback buffer size per session (1 MB).
const MAX_SCROLLBACK_BYTES: usize = 1_024 * 1_024;

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
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

    pub fn create_session(
        &self,
        session_id: &str,
        app_handle: AppHandle,
        directory: String,
        claude_session_id: Option<String>,
        resume: bool,
        dangerously_skip_permissions: bool,
        mcp_script_path: Option<String>,
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

        // Inject MCP server config if script path is available
        if let Some(ref mcp_path) = mcp_script_path {
            let mcp_config_dir = format!("/tmp/orchestrator-mcp/{}", session_id);
            std::fs::create_dir_all(&mcp_config_dir)
                .map_err(|e| format!("Failed to create MCP config dir: {}", e))?;

            let mcp_config = serde_json::json!({
                "mcpServers": {
                    "orchestrator": {
                        "command": "node",
                        "args": [mcp_path],
                        "env": {
                            "ORCHESTRATOR_SESSION_ID": session_id,
                            "ORCHESTRATOR_SIGNAL_DIR": "/tmp/orchestrator-signals"
                        }
                    }
                }
            });

            let config_path = format!("{}/mcp.json", mcp_config_dir);
            std::fs::write(&config_path, serde_json::to_string_pretty(&mcp_config).unwrap())
                .map_err(|e| format!("Failed to write MCP config: {}", e))?;

            claude_args.push("--mcp-config".to_string());
            claude_args.push(config_path);

            // For new sessions (not resume), add system prompt instruction
            if !resume {
                claude_args.push("--append-system-prompt".to_string());
                claude_args.push(
                    "You have access to the `switch_workspace` MCP tool from the orchestrator server. \
                     When you create a git worktree or need to work in a different directory, \
                     call switch_workspace with the absolute path to that directory. \
                     This will update the orchestrator app's workspace metadata for this session.\n\n\
                     IMPORTANT: After calling switch_workspace, you MUST also run `cd <directory>` using the Bash tool \
                     to actually change your working directory. The switch_workspace tool only updates the orchestrator UI — \
                     it does not change your process's working directory.\n\n\
                     When creating a git worktree:\n\
                     1. Do NOT use the built-in EnterWorktree tool — it puts worktrees in .claude/worktrees/ which is not desired.\n\
                     2. Create worktrees manually: git worktree add .worktrees/<name> -b <branch-name>\n\
                     3. Worktrees should live in .worktrees/ relative to the repo root.\n\
                     4. Always call switch_workspace with the absolute path to the new worktree directory after creating it.\n\
                     5. After switch_workspace returns, run: cd <worktree-path>"
                        .to_string(),
                );
            }
        }

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

        // Shell-escape all components to prevent injection via directory names or args.
        // Each value is wrapped in single quotes with internal single quotes escaped
        // as '\'' (end quote, literal quote, start quote).
        fn shell_escape(s: &str) -> String {
            format!("'{}'", s.replace('\'', "'\\''"))
        }

        let escaped_dir = shell_escape(&expanded_dir);
        let escaped_args: Vec<String> = claude_args.iter().map(|a| shell_escape(a)).collect();
        let shell_cmd = format!("cd {} && exec {}", escaped_dir, escaped_args.join(" "));
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
        let scrollback_buf = self.scrollback.clone();

        // Initialize scrollback buffer for this session
        {
            let mut sb = scrollback_buf.lock().map_err(|e| format!("Lock error: {}", e))?;
            sb.entry(sid.clone()).or_insert_with(Vec::new);
        }

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

                            // Append to scrollback buffer (cap at MAX_SCROLLBACK_BYTES)
                            if let Ok(mut sb) = scrollback_buf.lock() {
                                if let Some(buf) = sb.get_mut(&sid) {
                                    buf.extend_from_slice(&pending[..valid_up_to]);
                                    if buf.len() > MAX_SCROLLBACK_BYTES {
                                        let drain_to = buf.len() - MAX_SCROLLBACK_BYTES;
                                        buf.drain(..drain_to);
                                    }
                                }
                            }
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

        pair.slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;

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

        thread::spawn(move || {
            let mut first_output = true;
            let mut buf = [0u8; 4096];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        eprintln!("[pty_manager] shell reader EOF for {}", sid);
                        if !pending.is_empty() {
                            let data = String::from_utf8_lossy(&pending).to_string();
                            let _ = app_handle.emit(&format!("pty-output-{}", sid), data);
                        }
                        let _ = app_handle.emit(&format!("pty-exit-{}", sid), ());
                        break;
                    }
                    Ok(n) => {
                        if first_output {
                            eprintln!("[pty_manager] shell first output for {} ({} bytes)", sid, n);
                            first_output = false;
                        }
                        pending.extend_from_slice(&buf[..n]);

                        let valid_up_to = match std::str::from_utf8(&pending) {
                            Ok(_) => pending.len(),
                            Err(e) => e.valid_up_to(),
                        };

                        if valid_up_to > 0 {
                            let data = unsafe {
                                std::str::from_utf8_unchecked(&pending[..valid_up_to])
                            };
                            let event_name = format!("pty-output-{}", sid);
                            if let Err(e) = app_handle.emit(&event_name, data.to_string()) {
                                eprintln!("[pty_manager] emit error for {}: {}", event_name, e);
                            }

                            if let Ok(mut sb) = scrollback_buf.lock() {
                                if let Some(buf) = sb.get_mut(&sid) {
                                    buf.extend_from_slice(&pending[..valid_up_to]);
                                    if buf.len() > MAX_SCROLLBACK_BYTES {
                                        let drain_to = buf.len() - MAX_SCROLLBACK_BYTES;
                                        buf.drain(..drain_to);
                                    }
                                }
                            }
                        }

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
