use base64::Engine;
use std::fs;
use std::path::PathBuf;

pub fn save_image_from_base64(base64_data: &str) -> Result<String, String> {
    let tmp_dir = std::env::temp_dir().join("claude-orchestrator-images");
    fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let id = uuid::Uuid::new_v4().to_string();
    let file_path: PathBuf = tmp_dir.join(format!("{}.png", id));

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    fs::write(&file_path, bytes)
        .map_err(|e| format!("Failed to write image: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}
