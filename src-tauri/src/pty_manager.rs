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

    pub fn create_session(
        &self,
        session_id: &str,
        app_handle: AppHandle,
        directory: String,
        claude_session_id: Option<String>,
        resume: bool,
        dangerously_skip_permissions: bool,
        mcp_script_path: Option<String>,
        extra_system_prompt: Option<String>,
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
                     5. After switch_workspace returns, run: cd <worktree-path>\n\
                     6. Dependency directories (node_modules, .venv, venv, vendor) are automatically cloned into new worktrees via APFS clonefile, so npm install / pip install is usually not needed.\n\n\
                     When working on a PR branch, use the `checkout_pr_worktree` MCP tool instead of manually creating worktrees. \
                     It fetches the PR branch, creates a worktree at .worktrees/pr-<number>, clones dependencies, and signals the orchestrator — all in one step. \
                     After it returns, you MUST run `cd <path>` to change your working directory."
                        .to_string(),
                );

                // Append extra context (e.g. PR review instructions) to the system prompt
                if let Some(ref extra) = extra_system_prompt {
                    claude_args.push("--append-system-prompt".to_string());
                    claude_args.push(extra.clone());
                }
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

        let child = pair.slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn claude: {}", e))?;

        let child_pid = child.process_id();

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

        // Spawn a thread to read PTY output and emit events to the frontend.
        // Uses time-based batching to avoid flooding the event queue during
        // high-throughput output (e.g. large command output, cat of big files).
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            // Buffer for incomplete UTF-8 sequences split across reads
            let mut pending = Vec::new();
            // Accumulator for batching emissions
            let mut emit_buf = Vec::new();
            let mut last_emit = std::time::Instant::now();
            const BATCH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(8);
            const BATCH_MAX_BYTES: usize = 32 * 1024;

            let flush = |emit_buf: &mut Vec<u8>, scrollback_buf: &std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>, app_handle: &tauri::AppHandle, sid: &str| {
                if emit_buf.is_empty() { return; }
                let data = unsafe { std::str::from_utf8_unchecked(emit_buf) };
                let _ = app_handle.emit(&format!("pty-output-{}", sid), data.to_string());
                if let Ok(mut sb) = scrollback_buf.lock() {
                    if let Some(sb_buf) = sb.get_mut(sid) {
                        sb_buf.extend_from_slice(emit_buf);
                        if sb_buf.len() > MAX_SCROLLBACK_BYTES {
                            let drain_to = sb_buf.len() - MAX_SCROLLBACK_BYTES;
                            sb_buf.drain(..drain_to);
                        }
                    }
                }
                emit_buf.clear();
            };

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // Flush batched data
                        flush(&mut emit_buf, &scrollback_buf, &app_handle, &sid);
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
                            emit_buf.extend_from_slice(&pending[..valid_up_to]);
                        }

                        // Keep any trailing incomplete bytes for the next read
                        if valid_up_to < pending.len() {
                            let remaining = pending[valid_up_to..].to_vec();
                            pending.clear();
                            pending.extend_from_slice(&remaining);
                        } else {
                            pending.clear();
                        }

                        // Flush if batch interval elapsed or buffer is large enough
                        let now = std::time::Instant::now();
                        if now.duration_since(last_emit) >= BATCH_INTERVAL || emit_buf.len() >= BATCH_MAX_BYTES {
                            flush(&mut emit_buf, &scrollback_buf, &app_handle, &sid);
                            last_emit = now;
                        }
                    }
                    Err(_) => {
                        flush(&mut emit_buf, &scrollback_buf, &app_handle, &sid);
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
