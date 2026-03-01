mod clipboard_image;
mod pty_manager;

use pty_manager::PtyManager;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

struct AppState {
    pty_manager: Mutex<PtyManager>,
}

#[derive(Serialize, Deserialize, Clone)]
struct SessionMeta {
    id: String,
    name: String,
    #[serde(rename = "createdAt")]
    created_at: f64,
    #[serde(rename = "lastActiveAt")]
    last_active_at: f64,
    #[serde(default)]
    directory: String,
    #[serde(default, rename = "claudeSessionId", skip_serializing_if = "Option::is_none")]
    claude_session_id: Option<String>,
    #[serde(default, rename = "dangerouslySkipPermissions")]
    dangerously_skip_permissions: bool,
}

fn sessions_path(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    Ok(dir.join("sessions.json"))
}

#[tauri::command]
fn save_sessions(app_handle: AppHandle, sessions: Vec<SessionMeta>) -> Result<(), String> {
    let path = sessions_path(&app_handle)?;
    let json = serde_json::to_string_pretty(&sessions)
        .map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(path, json).map_err(|e| format!("Write error: {}", e))?;
    Ok(())
}

#[tauri::command]
fn load_sessions(app_handle: AppHandle) -> Result<Vec<SessionMeta>, String> {
    let path = sessions_path(&app_handle)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    let sessions: Vec<SessionMeta> =
        serde_json::from_str(&data).map_err(|e| format!("Parse error: {}", e))?;
    Ok(sessions)
}

#[tauri::command]
fn create_pty_session(
    session_id: String,
    directory: String,
    claude_session_id: Option<String>,
    resume: bool,
    #[allow(non_snake_case)] dangerouslySkipPermissions: Option<bool>,
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let skip_perms = dangerouslySkipPermissions.unwrap_or(false);
    eprintln!("[create_pty_session] session_id={}, directory={:?}, claude_session_id={:?}, resume={}, skip_permissions={}", session_id, directory, claude_session_id, resume, skip_perms);
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.create_session(&session_id, app_handle, directory, claude_session_id, resume, skip_perms)
}

#[tauri::command]
fn write_to_pty(session_id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.write_to_session(&session_id, &data)
}

#[tauri::command]
fn resize_pty(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.resize_session(&session_id, cols, rows)
}

#[tauri::command]
fn destroy_pty_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.destroy_session(&session_id)
}

#[tauri::command]
fn list_directories(partial: String) -> Result<Vec<String>, String> {
    let expanded = if partial.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            partial.replacen('~', &home, 1)
        } else {
            partial.clone()
        }
    } else {
        partial.clone()
    };

    let path = std::path::Path::new(&expanded);

    // Determine the parent to list and the prefix to filter by
    let (dir, prefix) = if path.is_dir() && expanded.ends_with('/') {
        (path.to_path_buf(), String::new())
    } else {
        let parent = path.parent().unwrap_or(std::path::Path::new("/"));
        let prefix = path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        (parent.to_path_buf(), prefix)
    };

    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Read dir error: {}", e))?;

    let home = std::env::var("HOME").unwrap_or_default();
    let mut results: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().map(|ft| ft.is_dir()).unwrap_or(false)
                && !e
                    .file_name()
                    .to_string_lossy()
                    .starts_with('.')
        })
        .filter(|e| {
            prefix.is_empty()
                || e.file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with(&prefix.to_lowercase())
        })
        .map(|e| {
            let full = e.path().to_string_lossy().to_string();
            if !home.is_empty() && full.starts_with(&home) {
                format!("~{}", &full[home.len()..])
            } else {
                full
            }
        })
        .collect();

    results.sort();
    results.truncate(50);
    Ok(results)
}

#[tauri::command]
fn get_conversation_title(claude_session_id: String, directory: String) -> Result<Option<String>, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;

    // Expand ~ in directory
    let expanded_dir = if directory.starts_with('~') {
        directory.replacen('~', &home, 1)
    } else {
        directory.clone()
    };

    // Build the Claude projects path: ~/.claude/projects/<encoded-path>/<session-id>.jsonl
    let encoded_path = expanded_dir.replace('/', "-");
    let jsonl_path = std::path::PathBuf::from(&home)
        .join(".claude")
        .join("projects")
        .join(&encoded_path)
        .join(format!("{}.jsonl", claude_session_id));

    if !jsonl_path.exists() {
        return Ok(None);
    }

    let file = std::fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open conversation file: {}", e))?;
    let reader = std::io::BufReader::new(file);

    use std::io::BufRead;
    for line in reader.lines() {
        let line = line.map_err(|e| format!("Read error: {}", e))?;
        if line.is_empty() {
            continue;
        }
        // Parse JSON and look for first user message
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            if parsed.get("type").and_then(|t| t.as_str()) == Some("user") {
                if let Some(content) = parsed
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                {
                    // Skip command messages like /review
                    if content.starts_with("<command-message>") {
                        continue;
                    }
                    // Truncate to ~60 chars
                    let title: String = content.chars().take(60).collect();
                    let title = if content.chars().count() > 60 {
                        format!("{}…", title.trim_end())
                    } else {
                        title
                    };
                    return Ok(Some(title));
                }
            }
        }
    }

    Ok(None)
}

#[tauri::command]
fn save_clipboard_image(base64_data: String) -> Result<String, String> {
    clipboard_image::save_image_from_base64(&base64_data)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            pty_manager: Mutex::new(PtyManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            create_pty_session,
            write_to_pty,
            resize_pty,
            destroy_pty_session,
            save_clipboard_image,
            save_sessions,
            load_sessions,
            list_directories,
            get_conversation_title,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
