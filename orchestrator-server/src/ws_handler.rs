use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use orchestrator_core::{commands, ServerEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tokio::sync::broadcast;

use crate::AppState;

// ── JSON-RPC types ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

#[derive(Serialize)]
struct JsonRpcNotification {
    jsonrpc: &'static str,
    method: &'static str,
    params: EventParams,
}

/// Each push notification carries the Tauri event name and its raw payload
/// (the same value that Tauri would pass as `event.payload` in `listen()`).
#[derive(Serialize)]
struct EventParams {
    /// Reconstructed Tauri event name, e.g. "agent-message-<sid>".
    event: String,
    /// The raw payload value — mirrors what Tauri's `app_handle.emit()` sends.
    payload: Value,
}

fn ok_response(id: &Value, result: Value) -> String {
    let r = JsonRpcResponse { jsonrpc: "2.0", id: id.clone(), result: Some(result), error: None };
    serde_json::to_string(&r).unwrap()
}

fn err_response(id: &Value, message: String) -> String {
    let r = JsonRpcResponse {
        jsonrpc: "2.0",
        id: id.clone(),
        result: None,
        error: Some(JsonRpcError { code: -32000, message }),
    };
    serde_json::to_string(&r).unwrap()
}

fn event_notification(event_name: String, payload: Value) -> String {
    let n = JsonRpcNotification {
        jsonrpc: "2.0",
        method: "event",
        params: EventParams { event: event_name, payload },
    };
    serde_json::to_string(&n).unwrap()
}

// ── Socket handler ──────────────────────────────────────────────────────────

pub async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let event_rx = state.event_tx.subscribe();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Task A: read incoming messages → dispatch concurrently → send response via tx
    let state_clone = state.clone();
    let tx_clone = tx.clone();
    let read_task = tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(_) => break,
            };
            let text = match msg {
                Message::Text(t) => t.to_string(),
                Message::Close(_) => break,
                _ => continue,
            };
            // Spawn each command concurrently so slow commands don't block fast ones
            let s = state_clone.clone();
            let tx = tx_clone.clone();
            tokio::spawn(async move {
                let response = dispatch(&text, &s).await;
                let _ = tx.send(response);
            });
        }
    });

    // Task B: subscribe to event bus → send notifications via tx
    let tx_clone = tx.clone();
    let event_task = tokio::spawn(async move {
        let mut rx = event_rx;
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let msg = server_event_to_notification(event);
                    if tx_clone.send(msg).is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[ws] Event bus lagged, dropped {} events", n);
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Drain tx → sink
    let write_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = read_task => {}
        _ = event_task => {}
        _ = write_task => {}
    }
}

// ── Event → notification ────────────────────────────────────────────────────

fn server_event_to_notification(event: ServerEvent) -> String {
    match event {
        ServerEvent::AgentMessage { session_id, line } => {
            // Frontend: const msg = JSON.parse(event.payload)
            event_notification(
                format!("agent-message-{}", session_id),
                Value::String(line),
            )
        }
        ServerEvent::AgentExit { session_id, code } => {
            // Frontend: parseInt(event.payload, 10)
            event_notification(
                format!("agent-exit-{}", session_id),
                Value::String(code.to_string()),
            )
        }
        ServerEvent::PtyOutput { session_id, data } => {
            // Frontend: term.write(event.payload)
            event_notification(
                format!("pty-output-{}", session_id),
                Value::String(data),
            )
        }
        ServerEvent::PtyExit { session_id } => {
            event_notification(
                format!("pty-exit-{}", session_id),
                Value::Null,
            )
        }
        ServerEvent::JsonlChanged { path } => {
            // Frontend: event.payload is the path string
            event_notification(
                "jsonl-changed".to_string(),
                Value::String(path),
            )
        }
        ServerEvent::MessagesIngested { claude_session_id } => {
            event_notification(
                "messages-ingested".to_string(),
                Value::String(claude_session_id),
            )
        }
        ServerEvent::OrchestratorSignal { signal } => {
            event_notification(
                "orchestrator-signal".to_string(),
                serde_json::to_value(signal).unwrap_or(Value::Null),
            )
        }
        ServerEvent::SessionsChanged => {
            event_notification("sessions-changed".to_string(), Value::Null)
        }
        ServerEvent::SessionBusyChanged { session_id, is_busy } => {
            event_notification(
                "session-busy-changed".to_string(),
                serde_json::json!({ "sessionId": session_id, "isBusy": is_busy }),
            )
        }
    }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

async fn dispatch(text: &str, state: &AppState) -> String {
    let req: JsonRpcRequest = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => {
            return err_response(&Value::Null, format!("Parse error: {}", e));
        }
    };
    let id = req.id.unwrap_or(Value::Null);
    let p = req.params;
    let s = &state.server;

    macro_rules! field {
        ($p:expr, $key:literal) => {
            match $p.get($key) {
                Some(v) => v.clone(),
                None => {
                    return err_response(&id, format!("Missing param: {}", $key));
                }
            }
        };
    }
    macro_rules! str_field {
        ($p:expr, $key:literal) => {
            match $p.get($key).and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => {
                    return err_response(&id, format!("Missing or invalid string param: {}", $key));
                }
            }
        };
    }
    macro_rules! opt_str {
        ($p:expr, $key:literal) => {
            $p.get($key).and_then(|v| v.as_str()).map(|s| s.to_string())
        };
    }

    match req.method.as_str() {
        // ── Sessions ──────────────────────────────────────────────────────
        "load_sessions" => {
            respond(&id, commands::load_sessions(s))
        }
        "load_sessions_paged" => {
            let limit = p.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
            let offset = p.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            respond(&id, commands::load_sessions_paged(limit, offset, s))
        }
        "save_sessions" => {
            let sessions: Vec<orchestrator_core::SessionMeta> =
                match serde_json::from_value(field!(p, "sessions")) {
                    Ok(v) => v,
                    Err(e) => return err_response(&id, e.to_string()),
                };
            respond(&id, commands::save_sessions(sessions, s))
        }

        // ── PTY ───────────────────────────────────────────────────────────
        "write_to_pty" => {
            respond(&id, commands::write_to_pty(str_field!(p, "sessionId"), str_field!(p, "data"), s))
        }
        "resize_pty" => {
            let cols = p.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
            let rows = p.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
            respond(&id, commands::resize_pty(str_field!(p, "sessionId"), cols, rows, s))
        }
        "create_shell_pty_session" => {
            respond(&id, commands::create_shell_pty_session(
                str_field!(p, "sessionId"),
                str_field!(p, "directory"),
                s,
            ))
        }
        "pty_has_child_process" => {
            respond(&id, commands::pty_has_child_process(str_field!(p, "sessionId"), s))
        }
        "get_pty_scrollback" => {
            respond(&id, commands::get_pty_scrollback(str_field!(p, "sessionId"), s))
        }

        // ── Agent ─────────────────────────────────────────────────────────
        "create_agent_session" => {
            let state_clone = Arc::clone(s);
            let session_id = str_field!(p, "sessionId");
            let directory = str_field!(p, "directory");
            let claude_session_id = opt_str!(p, "claudeSessionId");
            let resume = p.get("resume").and_then(|v| v.as_bool()).unwrap_or(false);
            let system_prompt = opt_str!(p, "systemPrompt");
            let provider = opt_str!(p, "provider");
            let model = opt_str!(p, "model");
            let permission_mode = opt_str!(p, "permissionMode");
            match commands::create_agent_session(
                session_id, directory, claude_session_id, resume,
                system_prompt, provider, model, permission_mode, state_clone,
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "send_agent_message" => {
            respond(&id, commands::send_agent_message(str_field!(p, "sessionId"), str_field!(p, "message"), s))
        }
        "abort_agent" => {
            respond(&id, commands::abort_agent(str_field!(p, "sessionId"), s))
        }
        "set_agent_cwd" => {
            respond(&id, commands::set_agent_cwd(str_field!(p, "sessionId"), str_field!(p, "cwd"), s))
        }
        "destroy_agent_session" => {
            respond(&id, commands::destroy_agent_session(str_field!(p, "sessionId"), s))
        }
        "get_agent_history" => {
            respond(&id, commands::get_agent_history(str_field!(p, "sessionId"), s))
        }
        "get_busy_sessions" => {
            respond(&id, commands::get_busy_sessions(s))
        }
        "fetch_opencode_models" => {
            let state_clone = Arc::clone(s);
            match commands::fetch_opencode_models(state_clone).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "fetch_codex_models" => {
            let state_clone = Arc::clone(s);
            match commands::fetch_codex_models(state_clone).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }

        // ── Providers / misc ──────────────────────────────────────────────
        "check_providers" => {
            ok_response(&id, serde_json::to_value(commands::check_providers()).unwrap())
        }
        "directory_exists" => {
            ok_response(&id, serde_json::to_value(commands::directory_exists(str_field!(p, "path"))).unwrap())
        }

        // ── Directories / commands / worktrees ────────────────────────────
        "list_directories" => {
            match commands::list_directories(str_field!(p, "partial")).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "list_slash_commands" => {
            match commands::list_slash_commands(str_field!(p, "directory")).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "list_worktrees" => {
            match commands::list_worktrees(str_field!(p, "directory")).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "create_worktree" => {
            let repo_dir = str_field!(p, "repoDir");
            let branch_name = str_field!(p, "branchName");
            let worktree_name = opt_str!(p, "worktreeName");
            respond(&id, commands::create_worktree(repo_dir, branch_name, worktree_name))
        }
        "remove_worktree" => {
            respond(&id, commands::remove_worktree(str_field!(p, "path")))
        }

        // ── Conversation / usage ──────────────────────────────────────────
        "get_conversation_title" => {
            respond(&id, commands::get_conversation_title(
                str_field!(p, "claudeSessionId"),
                str_field!(p, "directory"),
                s,
            ))
        }
        "get_opencode_session_title" => {
            respond(&id, commands::get_opencode_session_title(str_field!(p, "directory")))
        }
        "get_session_usage" => {
            respond(&id, commands::get_session_usage(
                str_field!(p, "claudeSessionId"),
                str_field!(p, "directory"),
                s,
            ))
        }
        "get_total_usage_today" => {
            respond(&id, commands::get_total_usage_today(s))
        }
        "get_usage_dashboard" => {
            let days = p.get("days").and_then(|v| v.as_u64()).unwrap_or(30) as u32;
            let state_clone = Arc::clone(s);
            match commands::get_usage_dashboard(days, state_clone).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "get_message_count" => {
            match commands::get_message_count(
                str_field!(p, "claudeSessionId"),
                str_field!(p, "directory"),
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "generate_smart_title" => {
            let state_clone = Arc::clone(s);
            match commands::generate_smart_title(
                str_field!(p, "claudeSessionId"),
                str_field!(p, "directory"),
                state_clone,
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "generate_title_from_text" => {
            let state_clone = Arc::clone(s);
            match commands::generate_title_from_text(str_field!(p, "message"), state_clone).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "classify_prompt" => {
            let state_clone = Arc::clone(s);
            match commands::classify_prompt(str_field!(p, "message"), state_clone).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "get_conversation_jsonl" => {
            respond(&id, commands::get_conversation_jsonl(
                str_field!(p, "claudeSessionId"),
                str_field!(p, "directory"),
                s,
            ))
        }
        "get_conversation_jsonl_tail" => {
            let max_lines = p.get("maxLines").and_then(|v| v.as_u64()).unwrap_or(200) as usize;
            respond(&id, commands::get_conversation_jsonl_tail(
                str_field!(p, "claudeSessionId"),
                str_field!(p, "directory"),
                max_lines,
                s,
            ))
        }
        "get_conversation_messages" => {
            respond(&id, commands::get_conversation_messages(
                str_field!(p, "claudeSessionId"),
                str_field!(p, "directory"),
                s,
            ))
        }
        "get_conversation_messages_tail" => {
            let max_messages = p.get("maxMessages").and_then(|v| v.as_u64()).unwrap_or(300) as usize;
            respond(&id, commands::get_conversation_messages_tail(
                str_field!(p, "claudeSessionId"),
                str_field!(p, "directory"),
                max_messages,
                s,
            ))
        }
        "search_session_content" => {
            let sessions: Vec<commands::SearchableSession> =
                match serde_json::from_value(field!(p, "sessions")) {
                    Ok(v) => v,
                    Err(e) => return err_response(&id, e.to_string()),
                };
            respond(&id, commands::search_session_content(sessions, str_field!(p, "query")))
        }
        "watch_jsonl" => {
            respond(&id, commands::watch_jsonl(
                str_field!(p, "claudeSessionId"),
                str_field!(p, "directory"),
                s,
            ))
        }
        "unwatch_jsonl" => {
            respond(&id, commands::unwatch_jsonl(
                str_field!(p, "claudeSessionId"),
                str_field!(p, "directory"),
                s,
            ))
        }

        // ── Git ───────────────────────────────────────────────────────────
        "get_git_status" => {
            match commands::get_git_status(str_field!(p, "directory")).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "get_git_diff" => {
            let staged = p.get("staged").and_then(|v| v.as_bool()).unwrap_or(false);
            match commands::get_git_diff(
                str_field!(p, "directory"),
                str_field!(p, "filePath"),
                staged,
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "get_git_numstat" => {
            let staged = p.get("staged").and_then(|v| v.as_bool()).unwrap_or(false);
            match commands::get_git_numstat(str_field!(p, "directory"), staged).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "generate_commit_message" => {
            let state_clone = Arc::clone(s);
            match commands::generate_commit_message(str_field!(p, "directory"), state_clone).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "git_commit_and_push" => {
            match commands::git_commit_and_push(
                str_field!(p, "directory"),
                str_field!(p, "message"),
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "git_unstage_all" => {
            match commands::git_unstage_all(str_field!(p, "directory")).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "git_stage_files" => {
            let files: Vec<String> = match serde_json::from_value(field!(p, "files")) {
                Ok(v) => v,
                Err(e) => return err_response(&id, e.to_string()),
            };
            match commands::git_stage_files(str_field!(p, "directory"), files).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "git_unstage_files" => {
            let files: Vec<String> = match serde_json::from_value(field!(p, "files")) {
                Ok(v) => v,
                Err(e) => return err_response(&id, e.to_string()),
            };
            match commands::git_unstage_files(str_field!(p, "directory"), files).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "switch_branch" => {
            respond(&id, commands::switch_branch(str_field!(p, "directory"), str_field!(p, "branch")))
        }
        "list_branches" => {
            respond(&id, commands::list_branches(str_field!(p, "directory")))
        }
        "get_branch_diff" => {
            respond(&id, commands::get_branch_diff(
                str_field!(p, "directory"),
                str_field!(p, "base"),
                str_field!(p, "compare"),
            ))
        }
        "get_branch_file_diff" => {
            respond(&id, commands::get_branch_file_diff(
                str_field!(p, "directory"),
                str_field!(p, "base"),
                str_field!(p, "compare"),
                str_field!(p, "filePath"),
            ))
        }
        "get_branch_commits" => {
            respond(&id, commands::get_branch_commits(
                str_field!(p, "directory"),
                str_field!(p, "base"),
                str_field!(p, "compare"),
            ))
        }

        // ── Pull requests ─────────────────────────────────────────────────
        "get_pull_requests" => {
            let result = commands::get_pull_requests(str_field!(p, "directory")).await;
            ok_response(&id, serde_json::to_value(result).unwrap())
        }
        "checkout_pr" => {
            match commands::checkout_pr(str_field!(p, "directory"), p.get("prNumber").and_then(|v| v.as_u64()).unwrap_or(0) as u32).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "checkout_pr_worktree" => {
            match commands::checkout_pr_worktree(
                str_field!(p, "directory"),
                p.get("prNumber").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                str_field!(p, "headRefName"),
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "get_pr_diff" => {
            match commands::get_pr_diff(
                str_field!(p, "directory"),
                p.get("prNumber").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "get_pr_file_diff" => {
            match commands::get_pr_file_diff(
                str_field!(p, "directory"),
                p.get("prNumber").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                str_field!(p, "filePath"),
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "post_pr_comment" => {
            match commands::post_pr_comment(
                str_field!(p, "directory"),
                p.get("prNumber").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                str_field!(p, "body"),
                str_field!(p, "path"),
                p.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "get_pr_comments" => {
            match commands::get_pr_comments(
                str_field!(p, "directory"),
                p.get("prNumber").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "get_pr_viewed_files" => {
            match commands::get_pr_viewed_files(
                str_field!(p, "directory"),
                p.get("prNumber").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "set_pr_file_viewed" => {
            match commands::set_pr_file_viewed(
                str_field!(p, "directory"),
                p.get("prNumber").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                str_field!(p, "path"),
                p.get("viewed").and_then(|v| v.as_bool()).unwrap_or(false),
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }

        // ── Files ─────────────────────────────────────────────────────────
        "read_file_content" => {
            respond(&id, commands::read_file_content(str_field!(p, "directory"), str_field!(p, "filePath")))
        }
        "read_file" => {
            respond(&id, commands::read_file(str_field!(p, "filePath")))
        }
        "read_file_base64" => {
            respond(&id, commands::read_file_base64(str_field!(p, "filePath")))
        }
        "write_file" => {
            respond(&id, commands::write_file(str_field!(p, "filePath"), str_field!(p, "content")))
        }
        "list_files" => {
            respond(&id, commands::list_files(str_field!(p, "partial")))
        }
        "search_project_files" => {
            let state_clone = Arc::clone(s);
            match commands::search_project_files(
                str_field!(p, "directory"),
                str_field!(p, "query"),
                state_clone,
            ).await {
                Ok(v) => ok_response(&id, serde_json::to_value(v).unwrap()),
                Err(e) => err_response(&id, e),
            }
        }
        "resolve_path" => {
            respond(&id, commands::resolve_path(str_field!(p, "filePath")))
        }
        "open_in_editor" => {
            respond(&id, commands::open_in_editor(str_field!(p, "editor"), str_field!(p, "filePath")))
        }

        // ── Clipboard / dock (no-ops in server mode) ──────────────────────
        "save_clipboard_image" => {
            respond(&id, commands::save_clipboard_image(str_field!(p, "base64Data")))
        }
        "get_clipboard_file_paths" => {
            ok_response(&id, serde_json::to_value(commands::get_clipboard_file_paths()).unwrap())
        }
        "set_dock_badge" => {
            let label = opt_str!(p, "label");
            commands::set_dock_badge(label);
            ok_response(&id, Value::Null)
        }

        // ── App config ────────────────────────────────────────────────────
        "get_external_access" => {
            respond(&id, commands::get_external_access(s))
        }
        "set_external_access" => {
            let enabled = p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
            let result = commands::set_external_access(enabled, s);
            if result.is_ok() {
                state.external_access.store(enabled, Ordering::Relaxed);
            }
            respond(&id, result)
        }

        _ => err_response(&id, format!("Unknown method: {}", req.method)),
    }
}

// ── Helper: serialize Result<T, String> ─────────────────────────────────────

fn respond<T: serde::Serialize>(id: &Value, result: Result<T, String>) -> String {
    match result {
        Ok(v) => ok_response(id, serde_json::to_value(v).unwrap()),
        Err(e) => err_response(id, e),
    }
}
