/// Resolve the full PATH from the user's login shell so that GUI-spawned
/// processes can find tools like `git` installed via Homebrew, nix, etc.
pub fn shell_path() -> &'static str {
    use std::sync::OnceLock;
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        std::process::Command::new(&shell)
            .args(["-lc", "echo $PATH"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    })
}

/// Read an environment variable from the user's login+interactive shell.
pub fn shell_env_var(name: &str) -> Option<String> {
    if let Ok(val) = std::env::var(name) {
        if !val.is_empty() {
            return Some(val);
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let script = format!("echo ${}", name);
    let val = std::process::Command::new(&shell)
        .args(["-ilc", &script])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())?;
    if val == name || val.starts_with('$') {
        None
    } else {
        Some(val)
    }
}

/// Resolve the absolute path of a binary using the shell PATH,
/// falling back to well-known install locations. Results are cached.
pub fn resolve_bin(name: &str) -> Option<String> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

    let mut map = cache.lock().ok()?;
    if let Some(cached) = map.get(name) {
        return cached.clone();
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let result = std::process::Command::new(&shell)
        .args(["-lc", &format!("which {}", name)])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let home = std::env::var("HOME").ok()?;
            let candidates = [
                format!("{home}/.{name}/bin/{name}"),
                format!("{home}/.local/bin/{name}"),
                format!("{home}/go/bin/{name}"),
                format!("{home}/.cargo/bin/{name}"),
                format!("/usr/local/bin/{name}"),
                format!("/opt/homebrew/bin/{name}"),
            ];
            candidates.into_iter().find(|p| std::path::Path::new(p).is_file())
        });

    map.insert(name.to_string(), result.clone());
    result
}

pub fn git_command(directory: &str) -> std::process::Command {
    let expanded = expand_tilde(directory);
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(&expanded);
    cmd.env("PATH", shell_path());
    cmd
}

pub fn gh_command() -> std::process::Command {
    let mut cmd = std::process::Command::new("gh");
    cmd.env("PATH", shell_path());
    cmd
}

pub fn gh_in_dir(directory: &str) -> std::process::Command {
    let expanded = expand_tilde(directory);
    let mut cmd = std::process::Command::new("gh");
    cmd.current_dir(&expanded);
    cmd.env("PATH", shell_path());
    cmd
}

pub fn expand_tilde(path: &str) -> String {
    if path.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            return path.replacen('~', &home, 1);
        }
    }
    path.to_string()
}

/// Walk up from `dir` to find a .git directory/file, returning the repo root.
pub fn find_git_root(dir: &str) -> Option<String> {
    let mut path = std::path::PathBuf::from(dir);
    loop {
        if path.join(".git").exists() {
            return Some(path.to_string_lossy().to_string());
        }
        if !path.pop() {
            return None;
        }
    }
}

/// Convert seconds since Unix epoch to a civil date string (YYYY-MM-DD).
pub fn civil_date_from_epoch(epoch_secs: u64) -> String {
    let days = epoch_secs / 86400;
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", year, m, d)
}

/// Check whether a path falls inside a macOS TCC-protected directory.
#[cfg(target_os = "macos")]
pub fn is_tcc_protected(expanded_path: &str) -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return false;
    }
    const PROTECTED: &[&str] = &[
        "Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures",
    ];
    for dir in PROTECTED {
        let prefix = format!("{}/{}", home, dir);
        if expanded_path == prefix || expanded_path.starts_with(&format!("{}/", prefix)) {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "macos"))]
pub fn is_tcc_protected(_expanded_path: &str) -> bool {
    false
}
