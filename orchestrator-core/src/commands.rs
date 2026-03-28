use crate::{
    ConversationCacheEntry, IncrementalUsageEntry, JsonlCache,
    PricingConfig, ServerState, SessionMeta, SessionUsage,
};
use crate::db;
use crate::utils::{expand_tilde, find_git_root, civil_date_from_epoch, gh_command, gh_in_dir, git_command, resolve_bin, shell_path, shell_env_var, is_tcc_protected};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

// ---------------------------------------------------------------------------
// Local types — command return types NOT in lib.rs
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    pub source: String,
}

#[derive(Serialize, Clone)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    #[serde(rename = "isMain")]
    pub is_main: bool,
}

#[derive(Serialize, Clone)]
pub struct GitFileEntry {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Serialize, Clone)]
pub struct GitStatusResult {
    pub branch: String,
    pub files: Vec<GitFileEntry>,
    #[serde(rename = "isGitRepo")]
    pub is_git_repo: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GhPrAuthor {
    pub login: String,
}

#[derive(Deserialize)]
pub(crate) struct GhPrReview {
    pub(crate) author: GhPrAuthor,
    pub(crate) state: String,
}

#[derive(Deserialize)]
pub(crate) struct GhCheckRun {
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) context: Option<String>,
    #[serde(default)]
    pub(crate) status: Option<String>,
    #[serde(default)]
    pub(crate) conclusion: Option<String>,
    #[serde(default)]
    pub(crate) state: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct GhPr {
    pub(crate) number: u32,
    pub(crate) title: String,
    pub(crate) url: String,
    pub(crate) state: String,
    #[serde(rename = "isDraft")]
    pub(crate) is_draft: bool,
    #[serde(rename = "updatedAt")]
    pub(crate) updated_at: String,
    #[serde(rename = "headRefName")]
    pub(crate) head_ref_name: String,
    pub(crate) author: GhPrAuthor,
    #[serde(default)]
    pub(crate) reviews: Vec<GhPrReview>,
    #[serde(rename = "statusCheckRollup", default)]
    pub(crate) status_check_rollup: Vec<GhCheckRun>,
}

#[derive(Serialize, Clone)]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub state: String,
    #[serde(rename = "isDraft")]
    pub is_draft: bool,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "headRefName")]
    pub head_ref_name: String,
    pub author: String,
    #[serde(rename = "authorAvatar")]
    pub author_avatar: String,
    #[serde(rename = "hasMyApproval")]
    pub has_my_approval: bool,
    #[serde(rename = "hasMyComment")]
    pub has_my_comment: bool,
    #[serde(rename = "checksTotal")]
    pub checks_total: usize,
    #[serde(rename = "checksPassing")]
    pub checks_passing: usize,
    #[serde(rename = "checksFailing")]
    pub checks_failing: usize,
    #[serde(rename = "checksPending")]
    pub checks_pending: usize,
    pub checks: Vec<CheckInfo>,
}

#[derive(Serialize, Clone)]
pub struct CheckInfo {
    pub name: String,
    pub status: String,
}

#[derive(Serialize)]
pub struct PullRequestsResult {
    #[serde(rename = "reviewRequested")]
    pub review_requested: Vec<PullRequest>,
    #[serde(rename = "myPrs")]
    pub my_prs: Vec<PullRequest>,
    #[serde(rename = "ghAvailable")]
    pub gh_available: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct TodayUsageSummary {
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
}

#[derive(Serialize, Clone)]
pub struct DailyUsage {
    pub date: String,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
    #[serde(rename = "inputTokens")]
    pub input_tokens: u64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u64,
}

#[derive(Serialize, Clone)]
pub struct ProjectUsage {
    pub directory: String,
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
    #[serde(rename = "sessionCount")]
    pub session_count: u32,
}

#[derive(Serialize, Clone)]
pub struct UsageDashboard {
    pub history: Vec<DailyUsage>,
    pub projects: Vec<ProjectUsage>,
}

#[derive(Serialize, Clone)]
pub struct BranchDiffFile {
    pub path: String,
    pub status: String,
}

#[derive(Serialize, Clone)]
pub struct BranchDiffResult {
    pub files: Vec<BranchDiffFile>,
}

#[derive(Serialize, Clone)]
pub struct BranchCommit {
    pub hash: String,
    pub short_hash: String,
    pub author_email: String,
    pub author_name: String,
    pub subject: String,
    pub is_mine: bool,
    pub files: Vec<BranchDiffFile>,
}

#[derive(Serialize, Clone)]
pub struct BranchCommitsResult {
    pub commits: Vec<BranchCommit>,
    pub user_email: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct GhPrComment {
    pub(crate) id: u64,
    pub(crate) path: Option<String>,
    pub(crate) line: Option<u32>,
    pub(crate) body: String,
    pub(crate) body_html: Option<String>,
    pub(crate) user: GhPrAuthor,
    pub(crate) created_at: String,
}

#[derive(Serialize, Clone)]
pub struct PrComment {
    pub id: u64,
    pub path: String,
    pub line: u32,
    pub body: String,
    #[serde(rename = "bodyHtml")]
    pub body_html: String,
    pub user: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Serialize, Clone)]
pub struct PrDiffResult {
    pub files: Vec<PrFileEntry>,
    #[serde(rename = "fullDiff")]
    pub full_diff: String,
}

#[derive(Serialize, Clone)]
pub struct PrFileEntry {
    pub path: String,
    pub status: String,
}

#[derive(Serialize)]
pub struct ConversationTailResult {
    pub lines: Vec<String>,
    pub total: usize,
}

#[derive(Deserialize)]
pub struct SearchableSession {
    #[serde(rename = "claudeSessionId")]
    pub claude_session_id: String,
    pub directory: String,
}

// ---------------------------------------------------------------------------
// PullRequest::from_gh
// ---------------------------------------------------------------------------

impl PullRequest {
    pub(crate) fn from_gh(pr: GhPr, current_user: &str) -> Self {
        let has_my_approval = pr.reviews.iter().any(|r| {
            r.author.login.eq_ignore_ascii_case(current_user) && r.state == "APPROVED"
        });
        let has_my_comment = pr.reviews.iter().any(|r| {
            r.author.login.eq_ignore_ascii_case(current_user)
                && (r.state == "COMMENTED" || r.state == "CHANGES_REQUESTED")
        });
        let checks: Vec<CheckInfo> = pr.status_check_rollup.iter().map(|c| {
            let name = c.name.clone().or_else(|| c.context.clone()).unwrap_or_else(|| "unknown".to_string());
            let conclusion = c.conclusion.as_deref().or(c.state.as_deref()).unwrap_or("");
            let status_field = c.status.as_deref().unwrap_or("");
            let status = if conclusion.eq_ignore_ascii_case("SUCCESS")
                || conclusion.eq_ignore_ascii_case("NEUTRAL")
                || conclusion.eq_ignore_ascii_case("SKIPPED")
            {
                "pass"
            } else if conclusion.eq_ignore_ascii_case("FAILURE")
                || conclusion.eq_ignore_ascii_case("TIMED_OUT")
                || conclusion.eq_ignore_ascii_case("CANCELLED")
                || conclusion.eq_ignore_ascii_case("ERROR")
            {
                "fail"
            } else if status_field.eq_ignore_ascii_case("COMPLETED") {
                "pass"
            } else {
                "pending"
            };
            CheckInfo { name, status: status.to_string() }
        }).collect();

        let checks_total = checks.len();
        let checks_passing = checks.iter().filter(|c| c.status == "pass").count();
        let checks_failing = checks.iter().filter(|c| c.status == "fail").count();
        let checks_pending = checks.iter().filter(|c| c.status == "pending").count();

        Self {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            state: pr.state,
            is_draft: pr.is_draft,
            updated_at: pr.updated_at,
            head_ref_name: pr.head_ref_name,
            author_avatar: format!("https://github.com/{}.png?size=40", pr.author.login),
            author: pr.author.login,
            has_my_approval,
            has_my_comment,
            checks_total,
            checks_passing,
            checks_failing,
            checks_pending,
            checks,
        }
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// Resolve a JSONL path from session ID and directory.
pub(crate) fn jsonl_path_for(claude_session_id: &str, directory: &str) -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    let expanded_dir = expand_tilde(directory);
    let trimmed_dir = expanded_dir.trim_end_matches('/');
    let encoded_path = trimmed_dir.replace('/', "-").replace('.', "-");
    Ok(PathBuf::from(&home)
        .join(".claude")
        .join("projects")
        .join(&encoded_path)
        .join(format!("{}.jsonl", claude_session_id)))
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

fn extract_user_text(content: &serde_json::Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
}

fn parse_conversation_title(jsonl_path: &Path) -> Result<Option<String>, String> {
    let file = std::fs::File::open(jsonl_path)
        .map_err(|e| format!("Failed to open conversation file: {}", e))?;
    let reader = std::io::BufReader::new(file);

    let mut first_command: Option<String> = None;

    use std::io::BufRead;
    for line in reader.lines() {
        let line = line.map_err(|e| format!("Read error: {}", e))?;
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            if parsed.get("type").and_then(|t| t.as_str()) == Some("user") {
                if let Some(content) = parsed
                    .get("message")
                    .and_then(|m| m.get("content"))
                {
                    if let Some(text) = extract_user_text(content) {
                        if text.starts_with("<command-message>") {
                            if first_command.is_none() {
                                if let Some(start) = text.find("<command-name>") {
                                    let after = &text[start + 14..];
                                    if let Some(end) = after.find("</command-name>") {
                                        first_command = Some(after[..end].to_string());
                                    }
                                }
                            }
                            continue;
                        }
                        let title: String = text.chars().take(60).collect();
                        let title = if text.chars().count() > 60 {
                            format!("{}…", title.trim_end())
                        } else {
                            title
                        };
                        return Ok(Some(title));
                    }
                }
            }
        }
    }
    Ok(first_command)
}

fn is_session_busy(jsonl_path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = match std::fs::File::open(jsonl_path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return false,
    };
    if len == 0 {
        return false;
    }

    let start = if len > 65536 { len - 65536 } else { 0 };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return false;
    }

    for line in buf.lines().rev() {
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
            match parsed.get("type").and_then(|t| t.as_str()) {
                Some("user") => return true,
                Some("assistant") => {
                    // If the assistant message contains tool_use blocks, the agent is
                    // waiting for tool results → still busy
                    let has_tool_use = parsed
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_array())
                        .map(|arr| {
                            arr.iter().any(|b| {
                                b.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                            })
                        })
                        .unwrap_or(false);
                    return has_tool_use;
                }
                _ => continue,
            }
        }
    }
    false
}

fn parse_session_usage_incremental(
    jsonl_path: &Path,
    byte_offset: u64,
    base_usage: &SessionUsage,
    pricing: &PricingConfig,
) -> Result<(SessionUsage, u64), String> {
    use std::io::{BufRead, Seek, SeekFrom};

    let mut file = std::fs::File::open(jsonl_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let file_len = file.metadata()
        .map_err(|e| format!("Failed to get metadata: {}", e))?
        .len();

    if file_len <= byte_offset {
        return Ok((base_usage.clone(), byte_offset));
    }

    file.seek(SeekFrom::Start(byte_offset))
        .map_err(|e| format!("Seek error: {}", e))?;

    let reader = std::io::BufReader::new(file);
    let mut usage = base_usage.clone();

    for line in reader.lines() {
        let line = line.map_err(|e| format!("Read error: {}", e))?;
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            if parsed.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                let msg = parsed.get("message");
                let model = msg
                    .and_then(|m| m.get("model"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("");

                if let Some(u) = msg.and_then(|m| m.get("usage")) {
                    let inp = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let out = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let cc = u.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    let cr = u.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);

                    usage.input_tokens += inp;
                    usage.output_tokens += out;
                    usage.cache_creation_input_tokens += cc;
                    usage.cache_read_input_tokens += cr;
                    usage.context_tokens = inp + cc + cr;

                    let (ip, op, cp, rp) = pricing.lookup(model);
                    usage.cost_usd += (inp as f64 * ip
                        + out as f64 * op
                        + cc as f64 * cp
                        + cr as f64 * rp)
                        / 1_000_000.0;
                }
            }
        }
    }

    Ok((usage, file_len))
}

fn usage_from_jsonl(path: &Path, today: &str, pricing: &PricingConfig) -> (f64, u64) {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (0.0, 0),
    };
    let reader = std::io::BufReader::new(file);
    let mut cost = 0.0;
    let mut tokens = 0u64;
    use std::io::BufRead;
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            if parsed.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            if let Some(ts) = parsed.get("timestamp").and_then(|t| t.as_str()) {
                if !ts.starts_with(today) {
                    continue;
                }
            } else {
                continue;
            }
            let msg = parsed.get("message");
            let model = msg
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
                .unwrap_or("");
            if let Some(u) = msg.and_then(|m| m.get("usage")) {
                let inp = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let out = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cc = u.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cr = u.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                tokens += inp + out + cc + cr;
                let (ip, op, cp, rp) = pricing.lookup(model);
                cost += (inp as f64 * ip + out as f64 * op + cc as f64 * cp + cr as f64 * rp)
                    / 1_000_000.0;
            }
        }
    }
    (cost, tokens)
}

fn usage_by_date_from_jsonl(
    path: &Path,
    pricing: &PricingConfig,
) -> HashMap<String, (f64, u64, u64)> {
    let mut buckets: HashMap<String, (f64, u64, u64)> = HashMap::new();
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return buckets,
    };
    let reader = std::io::BufReader::new(file);
    use std::io::BufRead;
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            if parsed.get("type").and_then(|t| t.as_str()) != Some("assistant") {
                continue;
            }
            let date = match parsed.get("timestamp").and_then(|t| t.as_str()) {
                Some(ts) if ts.len() >= 10 => ts[..10].to_string(),
                _ => continue,
            };
            let msg = parsed.get("message");
            let model = msg
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
                .unwrap_or("");
            if let Some(u) = msg.and_then(|m| m.get("usage")) {
                let inp = u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let out = u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cc = u.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cr = u.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let (ip, op, cp, rp) = pricing.lookup(model);
                let cost = (inp as f64 * ip + out as f64 * op + cc as f64 * cp + cr as f64 * rp)
                    / 1_000_000.0;
                let entry = buckets.entry(date).or_insert((0.0, 0, 0));
                entry.0 += cost;
                entry.1 += inp + cc + cr;
                entry.2 += out;
            }
        }
    }
    buckets
}

fn compute_usage_dashboard(days: u32, pricing: &PricingConfig) -> Result<UsageDashboard, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    let projects_dir = PathBuf::from(&home).join(".claude").join("projects");
    if !projects_dir.exists() {
        return Ok(UsageDashboard { history: vec![], projects: vec![] });
    }

    let max_age_secs = days as u64 * 86400;
    let mut date_map: HashMap<String, (f64, u64, u64)> = HashMap::new();
    let mut projects: Vec<ProjectUsage> = Vec::new();

    let project_entries = std::fs::read_dir(&projects_dir)
        .map_err(|e| format!("Read projects dir: {}", e))?;

    for project_entry in project_entries.flatten() {
        if !project_entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let folder_name = project_entry.file_name().to_string_lossy().to_string();
        let decoded_dir = if folder_name.starts_with('-') {
            folder_name.replacen('-', "/", 1).replace('-', "/")
        } else {
            folder_name.clone()
        };

        let mut project_cost = 0.0;
        let mut project_tokens = 0u64;
        let mut session_count = 0u32;

        let session_entries = match std::fs::read_dir(project_entry.path()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in session_entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            session_count += 1;

            let is_recent = entry.metadata().ok().and_then(|m| m.modified().ok()).map_or(false, |modified| {
                SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or_default()
                    .as_secs() <= max_age_secs
            });

            let buckets = usage_by_date_from_jsonl(&path, pricing);
            for (date, (cost, inp, out)) in &buckets {
                project_cost += cost;
                project_tokens += inp + out;
                if is_recent {
                    let entry = date_map.entry(date.clone()).or_insert((0.0, 0, 0));
                    entry.0 += cost;
                    entry.1 += inp;
                    entry.2 += out;
                }
            }
        }

        if session_count > 0 {
            projects.push(ProjectUsage {
                directory: decoded_dir,
                cost_usd: project_cost,
                total_tokens: project_tokens,
                session_count,
            });
        }
    }

    let mut repo_map: HashMap<String, ProjectUsage> = HashMap::new();
    for proj in projects {
        let repo_root = find_git_root(&proj.directory).unwrap_or_else(|| proj.directory.clone());
        match repo_map.get_mut(&repo_root) {
            Some(existing) => {
                existing.cost_usd += proj.cost_usd;
                existing.total_tokens += proj.total_tokens;
                existing.session_count += proj.session_count;
            }
            None => {
                repo_map.insert(repo_root.clone(), ProjectUsage {
                    directory: repo_root,
                    cost_usd: proj.cost_usd,
                    total_tokens: proj.total_tokens,
                    session_count: proj.session_count,
                });
            }
        }
    }
    let mut projects: Vec<ProjectUsage> = repo_map.into_values().collect();

    let now_secs = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let cutoff_date = civil_date_from_epoch(now_secs.saturating_sub(max_age_secs));
    let mut history: Vec<DailyUsage> = date_map
        .into_iter()
        .filter(|(date, _)| *date >= cutoff_date)
        .map(|(date, (cost, inp, out))| DailyUsage {
            date,
            cost_usd: cost,
            total_tokens: inp + out,
            input_tokens: inp,
            output_tokens: out,
        })
        .collect();
    history.sort_by(|a, b| a.date.cmp(&b.date));

    projects.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));

    Ok(UsageDashboard { history, projects })
}

fn is_image_path(line: &str) -> bool {
    let t = line.trim();
    let has_img_prefix = t.starts_with("/var/folders/")
        || t.starts_with("/tmp/")
        || t.starts_with("/var/tmp/");
    let has_img_ext = t.ends_with(".png")
        || t.ends_with(".jpg")
        || t.ends_with(".jpeg")
        || t.ends_with(".gif")
        || t.ends_with(".webp");
    has_img_prefix && has_img_ext
}

fn extract_first_user_message(claude_session_id: &str, directory: &str) -> Result<Option<serde_json::Value>, String> {
    let jsonl_path = jsonl_path_for(claude_session_id, directory)?;

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
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            let msg_type = parsed.get("type").and_then(|t| t.as_str());

            if msg_type == Some("user") {
                if let Some(content) = parsed
                    .get("message")
                    .and_then(|m| m.get("content"))
                {
                    let mut texts = Vec::new();
                    let mut has_images = false;

                    if let Some(s) = content.as_str() {
                        let filtered: Vec<&str> = s.lines()
                            .filter(|line| !is_image_path(line))
                            .collect();
                        let filtered_text = filtered.join("\n");
                        if !filtered_text.is_empty() {
                            texts.push(filtered_text);
                        } else if s.lines().any(is_image_path) {
                            has_images = true;
                        }
                    } else if let Some(arr) = content.as_array() {
                        for block in arr {
                            let block_type = block.get("type").and_then(|t| t.as_str());
                            if block_type == Some("text") {
                                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                    texts.push(text.to_string());
                                }
                            } else if block_type == Some("image") {
                                has_images = true;
                            }
                        }
                    }

                    let combined_text = texts.join("\n");
                    if combined_text.starts_with("<command-message>") {
                        continue;
                    }

                    let text = if combined_text.is_empty() {
                        if has_images { "[Image]".to_string() } else { continue; }
                    } else {
                        combined_text.chars().take(500).collect()
                    };

                    return Ok(Some(serde_json::json!({ "text": text })));
                }
            }
        }
    }

    Ok(None)
}

pub(crate) fn truncate_content_blocks(val: &mut serde_json::Value) {
    const MAX_TEXT: usize = 20_000;

    let content = val
        .pointer_mut("/message/content");

    if let Some(serde_json::Value::Array(blocks)) = content {
        for block in blocks.iter_mut() {
            if let Some(serde_json::Value::String(text)) = block.get_mut("text") {
                if text.len() > MAX_TEXT {
                    let end = text.char_indices()
                        .nth(MAX_TEXT)
                        .map(|(i, _)| i)
                        .unwrap_or(text.len());
                    text.truncate(end);
                    text.push_str("\n…[truncated]");
                }
            }
        }
    } else if let Some(serde_json::Value::String(text)) = val.pointer_mut("/message/content") {
        if text.len() > MAX_TEXT {
            let end = text.char_indices()
                .nth(MAX_TEXT)
                .map(|(i, _)| i)
                .unwrap_or(text.len());
            text.truncate(end);
            text.push_str("\n…[truncated]");
        }
    }
}

fn read_and_filter_jsonl_lines(path: &Path, byte_offset: u64) -> Result<(Vec<String>, u64), String> {
    use std::io::{BufRead, Seek, SeekFrom};

    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open conversation file: {}", e))?;

    let file_len = file.metadata()
        .map_err(|e| format!("Failed to get file metadata: {}", e))?
        .len();

    if byte_offset >= file_len {
        return Ok((vec![], byte_offset));
    }

    file.seek(SeekFrom::Start(byte_offset))
        .map_err(|e| format!("Failed to seek in file: {}", e))?;

    const WANTED: &[&str] = &[
        "\"type\":\"user\"", "\"type\": \"user\"",
        "\"type\":\"assistant\"", "\"type\": \"assistant\"",
        "\"type\":\"result\"", "\"type\": \"result\"",
        "\"type\":\"error\"", "\"type\": \"error\"",
    ];
    const TRUNCATE_THRESHOLD: usize = 30_000;

    let reader = std::io::BufReader::new(file);
    let mut new_offset = byte_offset;
    let mut lines = Vec::new();

    for line_result in reader.lines() {
        let l = line_result.map_err(|e| format!("Failed to read line: {}", e))?;
        new_offset += l.len() as u64 + 1;
        if l.is_empty() || !WANTED.iter().any(|w| l.contains(w)) {
            continue;
        }
        if l.len() <= TRUNCATE_THRESHOLD {
            lines.push(l);
        } else if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&l) {
            truncate_content_blocks(&mut val);
            lines.push(serde_json::to_string(&val).unwrap_or(l));
        } else {
            lines.push(l);
        }
    }

    Ok((lines, new_offset))
}

fn get_cached_conversation_lines(
    jsonl_path: &Path,
    cache: &Mutex<JsonlCache>,
) -> Result<Vec<String>, String> {
    let mtime = std::fs::metadata(jsonl_path)
        .map_err(|e| format!("Failed to get metadata: {}", e))?
        .modified()
        .map_err(|e| format!("Failed to get mtime: {}", e))?;

    {
        let guard = cache.lock().map_err(|e| format!("Cache lock error: {}", e))?;
        if let Some(entry) = guard.conversation.get(jsonl_path) {
            if entry.mtime == mtime {
                return Ok(entry.lines.clone());
            }
        }
    }

    let guard = cache.lock().map_err(|e| format!("Cache lock error: {}", e))?;
    let existing_offset = guard.conversation.get(jsonl_path)
        .filter(|e| e.mtime == mtime)
        .map(|e| e.byte_offset);

    if let Some(_offset) = existing_offset {
        return Ok(guard.conversation.get(jsonl_path).unwrap().lines.clone());
    }

    let start_offset = guard.conversation.get(jsonl_path)
        .filter(|e| {
            let file_len = std::fs::metadata(jsonl_path).map(|m| m.len()).unwrap_or(0);
            file_len >= e.byte_offset
        })
        .map(|e| e.byte_offset)
        .unwrap_or(0);

    let mut existing_lines = if start_offset > 0 {
        guard.conversation.get(jsonl_path).map(|e| e.lines.clone()).unwrap_or_default()
    } else {
        Vec::new()
    };

    drop(guard);

    let (new_lines, new_offset) = read_and_filter_jsonl_lines(jsonl_path, start_offset)?;
    existing_lines.extend(new_lines);

    let result = existing_lines.clone();

    let mut guard = cache.lock().map_err(|e| format!("Cache lock error: {}", e))?;
    guard.conversation.insert(jsonl_path.to_path_buf(), ConversationCacheEntry {
        byte_offset: new_offset,
        mtime,
        lines: existing_lines,
    });

    Ok(result)
}

fn list_directories_sync(partial: String) -> Result<Vec<String>, String> {
    let expanded = expand_tilde(&partial);

    let path = Path::new(&expanded);

    let (dir, prefix) = if path.is_dir() && expanded.ends_with('/') {
        (path.to_path_buf(), String::new())
    } else {
        let parent = path.parent().unwrap_or(Path::new("/"));
        let prefix = path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        (parent.to_path_buf(), prefix)
    };

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]),
    };

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

fn scan_commands_dir(dir: &Path, source: &str, commands: &mut Vec<SlashCommand>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    let description = std::fs::read_to_string(&path)
                        .ok()
                        .and_then(|content| {
                            content.lines().next().map(|line| {
                                line.trim().trim_start_matches('#').trim().to_string()
                            })
                        })
                        .unwrap_or_default();
                    commands.push(SlashCommand {
                        name: stem.to_string(),
                        description,
                        source: source.to_string(),
                    });
                }
            }
        }
    }
}

fn list_slash_commands_sync(directory: String) -> Result<Vec<SlashCommand>, String> {
    let mut commands = Vec::new();

    let project_dir = Path::new(&directory).join(".claude").join("commands");
    if project_dir.is_dir() {
        scan_commands_dir(&project_dir, "project", &mut commands);
    }

    if let Ok(home) = std::env::var("HOME") {
        let user_dir = Path::new(&home).join(".claude").join("commands");
        if user_dir.is_dir() {
            scan_commands_dir(&user_dir, "user", &mut commands);
        }
    }

    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands.dedup_by(|b, a| a.name == b.name);
    Ok(commands)
}

fn list_worktrees_sync(directory: String) -> Result<Vec<WorktreeInfo>, String> {
    let expanded = expand_tilde(&directory);

    let output = std::process::Command::new("git")
        .current_dir(&expanded)
        .env("PATH", shell_path())
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let home = std::env::var("HOME").unwrap_or_default();

    let mut worktrees: Vec<WorktreeInfo> = Vec::new();
    let mut is_first = true;

    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in stdout.lines() {
        if line.is_empty() {
            if let Some(path) = current_path.take() {
                if !Path::new(&path).is_dir() {
                    current_branch = None;
                    is_first = false;
                    continue;
                }
                let branch = current_branch.take().unwrap_or_default();
                let display_path = if !home.is_empty() && path.starts_with(&home) {
                    format!("~{}", &path[home.len()..])
                } else {
                    path
                };
                worktrees.push(WorktreeInfo {
                    path: display_path,
                    branch,
                    is_main: is_first,
                });
                is_first = false;
            }
            current_branch = None;
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.to_string());
        } else if let Some(branch_ref) = line.strip_prefix("branch ") {
            current_branch = Some(
                branch_ref
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch_ref)
                    .to_string(),
            );
        }
    }
    if let Some(path) = current_path.take() {
        if Path::new(&path).is_dir() {
            let branch = current_branch.take().unwrap_or_default();
            let display_path = if !home.is_empty() && path.starts_with(&home) {
                format!("~{}", &path[home.len()..])
            } else {
                path
            };
            worktrees.push(WorktreeInfo {
                path: display_path,
                branch,
                is_main: is_first,
            });
        }
    }

    Ok(worktrees)
}

fn clone_heavy_dirs(source: &str, worktree: &str) {
    let find_output = std::process::Command::new("find")
        .current_dir(source)
        .args([
            ".",
            "-path", "./.worktrees", "-prune", "-o",
            "-path", "./.git", "-prune", "-o",
            "(", "-name", "node_modules",
                 "-o", "-name", ".venv",
                 "-o", "-name", "venv",
                 "-o", "-name", "vendor", ")",
            "-type", "d", "-print", "-prune",
        ])
        .output();

    let output = match find_output {
        Ok(o) if o.status.success() => o,
        _ => return,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    for rel_path in stdout.lines() {
        let rel_path = rel_path.trim_start_matches("./");
        if rel_path.is_empty() {
            continue;
        }
        let src = Path::new(source).join(rel_path);
        let dst = Path::new(worktree).join(rel_path);

        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let _ = std::process::Command::new("cp")
            .args(["-Rc", &src.to_string_lossy(), &dst.to_string_lossy()])
            .output();
    }
}

fn get_pull_requests_sync(directory: &str) -> PullRequestsResult {
    let auth_check = gh_command()
        .args(["auth", "status"])
        .output();

    match auth_check {
        Err(_) => {
            return PullRequestsResult {
                review_requested: vec![],
                my_prs: vec![],
                gh_available: false,
                error: Some("GitHub CLI (gh) is not installed. Install it from https://cli.github.com".to_string()),
            };
        }
        Ok(output) if !output.status.success() => {
            return PullRequestsResult {
                review_requested: vec![],
                my_prs: vec![],
                gh_available: false,
                error: Some("Not authenticated with GitHub CLI. Run `gh auth login` to authenticate.".to_string()),
            };
        }
        _ => {}
    }

    let current_user = gh_command()
        .args(["api", "user", "--jq", ".login"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    let json_fields = "number,title,url,state,isDraft,updatedAt,headRefName,author,reviews,statusCheckRollup";

    let review_prs = gh_in_dir(directory)
        .args(["pr", "list", "--search", "involves:@me -author:@me", "--state=open",
               &format!("--json={}", json_fields), "--limit=30"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                serde_json::from_slice::<Vec<GhPr>>(&o.stdout).ok()
            } else {
                None
            }
        })
        .unwrap_or_default()
        .into_iter()
        .map(|pr| PullRequest::from_gh(pr, &current_user))
        .collect();

    let my_prs = gh_in_dir(directory)
        .args(["pr", "list", "--author=@me", "--state=open",
               &format!("--json={}", json_fields), "--limit=30"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                serde_json::from_slice::<Vec<GhPr>>(&o.stdout).ok()
            } else {
                None
            }
        })
        .unwrap_or_default()
        .into_iter()
        .map(|pr| PullRequest::from_gh(pr, &current_user))
        .collect();

    PullRequestsResult {
        review_requested: review_prs,
        my_prs,
        gh_available: true,
        error: None,
    }
}

fn extract_file_diff(full_diff: &str, file_path: &str) -> String {
    let marker = format!("diff --git a/{} b/{}", file_path, file_path);
    let mut result = String::new();
    let mut in_section = false;
    for line in full_diff.lines() {
        if line.starts_with("diff --git ") {
            if in_section {
                break;
            }
            if line == marker {
                in_section = true;
            }
        }
        if in_section {
            result.push_str(line);
            result.push('\n');
        }
    }
    result
}

fn get_git_status_sync(directory: String) -> Result<GitStatusResult, String> {
    let output = git_command(&directory)
        .args(["status", "--porcelain", "-b"])
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not a git repository") {
            return Ok(GitStatusResult {
                branch: String::new(),
                files: vec![],
                is_git_repo: false,
            });
        }
        return Err(format!("git status failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();
    let mut branch = lines
        .next()
        .unwrap_or("")
        .strip_prefix("## ")
        .unwrap_or("")
        .split("...")
        .next()
        .unwrap_or("")
        .to_string();

    if branch == "HEAD (no branch)" || branch.is_empty() {
        if let Ok(branch_output) = git_command(&directory)
            .args(["branch", "--show-current"])
            .output()
        {
            let name = String::from_utf8_lossy(&branch_output.stdout).trim().to_string();
            if !name.is_empty() {
                branch = name;
            }
        }
    }

    let mut files = Vec::new();
    for line in lines {
        if line.len() < 4 {
            continue;
        }
        let index_status = line.chars().nth(0).unwrap_or(' ');
        let worktree_status = line.chars().nth(1).unwrap_or(' ');
        let path = line[3..].to_string();

        if index_status == '?' && worktree_status == '?' {
            files.push(GitFileEntry {
                path,
                status: "??".to_string(),
                staged: false,
            });
        } else {
            if index_status != ' ' && index_status != '?' {
                files.push(GitFileEntry {
                    path: path.clone(),
                    status: index_status.to_string(),
                    staged: true,
                });
            }
            if worktree_status != ' ' && worktree_status != '?' {
                files.push(GitFileEntry {
                    path,
                    status: worktree_status.to_string(),
                    staged: false,
                });
            }
        }
    }

    Ok(GitStatusResult {
        branch,
        files,
        is_git_repo: true,
    })
}

fn get_git_diff_sync(directory: String, file_path: String, staged: bool) -> Result<String, String> {
    let mut cmd = git_command(&directory);
    cmd.arg("diff");
    if staged {
        cmd.arg("--cached");
    }
    cmd.arg("--");
    cmd.arg(&file_path);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn get_message_count_sync(claude_session_id: String, directory: String) -> Result<u32, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;
    if !jsonl_path.exists() {
        return Ok(0);
    }
    let file = std::fs::File::open(&jsonl_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let reader = std::io::BufReader::new(file);
    let mut count = 0u32;
    use std::io::BufRead;
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.is_empty() {
            continue;
        }
        if line.contains("\"type\":\"user\"") || line.contains("\"type\": \"user\"") {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                if parsed.get("type").and_then(|t| t.as_str()) == Some("user") {
                    count += 1;
                }
            }
        }
    }
    Ok(count)
}

fn dirs_opencode_db() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".local/share/opencode/opencode.db"))
}

fn list_project_files(directory: &str) -> Vec<String> {
    use std::process::Command;

    let git_result = Command::new("git")
        .args(["ls-files"])
        .current_dir(directory)
        .output();

    match git_result {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|l| !l.is_empty())
                .map(|l| l.to_string())
                .collect()
        }
        _ => {
            let mut found = Vec::new();
            let base = Path::new(directory);
            walk_dir_recursive(base, base, &mut found, 0);
            found
        }
    }
}

fn fuzzy_score(query_chars: &[char], query: &str, path: &str, filename: &str) -> Option<i32> {
    let path_chars: Vec<char> = path.chars().collect();
    let mut qi = 0;
    let mut pi = 0;
    let mut score: i32 = 0;
    let mut prev_match_idx: Option<usize> = None;

    while qi < query_chars.len() && pi < path_chars.len() {
        if query_chars[qi] == path_chars[pi] {
            if let Some(prev) = prev_match_idx {
                if pi == prev + 1 {
                    score += 4;
                }
            }
            if pi == 0 || matches!(path_chars[pi - 1], '/' | '.' | '_' | '-') {
                score += 3;
            }
            prev_match_idx = Some(pi);
            qi += 1;
        }
        pi += 1;
    }

    if qi < query_chars.len() {
        return None;
    }

    if filename.contains(query) {
        score += 20;
    }
    if filename.starts_with(query) {
        score += 10;
    }
    score -= (path.len() as i32) / 20;

    Some(score)
}

fn walk_dir_recursive(base: &Path, dir: &Path, out: &mut Vec<String>, depth: u32) {
    const SKIP_DIRS: &[&str] = &[
        "node_modules", "target", ".git", ".hg", ".svn", "dist", "build",
        "__pycache__", ".next", ".nuxt", "vendor", ".worktrees",
    ];
    if depth > 12 { return; }
    let Ok(entries) = std::fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') && depth == 0 && name_str != ".github" { continue; }
        if let Ok(ft) = entry.file_type() {
            if ft.is_dir() {
                if SKIP_DIRS.contains(&name_str.as_ref()) { continue; }
                if name_str.starts_with('.') { continue; }
                walk_dir_recursive(base, &entry.path(), out, depth + 1);
            } else if ft.is_file() {
                if let Ok(rel) = entry.path().strip_prefix(base) {
                    out.push(rel.to_string_lossy().to_string());
                }
            }
        }
        if out.len() > 5000 { return; }
    }
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(CHARS[b0 >> 2] as char);
        out.push(CHARS[((b0 & 3) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 { CHARS[((b1 & 15) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[b2 & 63] as char } else { '=' });
    }
    out
}

fn save_image_from_base64(base64_data: &str) -> Result<String, String> {
    use base64::Engine;

    let tmp_dir = std::env::temp_dir().join("claude-orchestrator-images");
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let id = uuid::Uuid::new_v4().to_string();
    let file_path = tmp_dir.join(format!("{}.png", id));

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    std::fs::write(&file_path, bytes)
        .map_err(|e| format!("Failed to write image: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

/// Call the warm title server with a user message and return the generated title.
async fn call_title_server(port: u16, body: String) -> Result<Option<String>, String> {
    let response = tokio::task::spawn_blocking(move || {
        let client = std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| format!("Failed to connect to title server: {}", e))?;
        client.set_read_timeout(Some(std::time::Duration::from_secs(30))).ok();
        client.set_write_timeout(Some(std::time::Duration::from_secs(5))).ok();

        use std::io::{Read, Write};
        let mut stream = client;
        let request = format!(
            "POST / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            port,
            body.len(),
            body
        );
        stream.write_all(request.as_bytes())
            .map_err(|e| format!("Failed to send request: {}", e))?;

        let mut response = String::new();
        stream.read_to_string(&mut response)
            .map_err(|e| format!("Failed to read response: {}", e))?;

        Ok::<String, String>(response)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let body = response.split("\r\n\r\n").nth(1).unwrap_or("");
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(title) = parsed.get("title").and_then(|t| t.as_str()) {
            let title = title.trim().to_string();
            if !title.is_empty() {
                return Ok(Some(title));
            }
        }
        if let Some(error) = parsed.get("error").and_then(|e| e.as_str()) {
            return Err(format!("Title server error: {}", error));
        }
    }

    Ok(None)
}

/// Call the title server's /classify endpoint.
async fn call_classify_server(port: u16, user_msg: String) -> Result<String, String> {
    let body = serde_json::json!({ "message": user_msg }).to_string();

    let response = tokio::task::spawn_blocking(move || {
        let client = std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| format!("Failed to connect to classify server: {}", e))?;
        client.set_read_timeout(Some(std::time::Duration::from_secs(15))).ok();
        client.set_write_timeout(Some(std::time::Duration::from_secs(5))).ok();

        use std::io::{Read, Write};
        let mut stream = client;
        let request = format!(
            "POST /classify HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            port,
            body.len(),
            body
        );
        stream.write_all(request.as_bytes())
            .map_err(|e| format!("Failed to send request: {}", e))?;

        let mut response = String::new();
        stream.read_to_string(&mut response)
            .map_err(|e| format!("Failed to read response: {}", e))?;

        Ok::<String, String>(response)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let body = response.split("\r\n\r\n").nth(1).unwrap_or("");
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(classification) = parsed.get("classification").and_then(|c| c.as_str()) {
            return Ok(classification.to_string());
        }
    }

    Ok("complex".to_string())
}
// (imports in part 1)

pub fn save_sessions(
    sessions: Vec<SessionMeta>,
    state: &Arc<ServerState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::db_save_sessions(&conn, &sessions).map_err(|e| format!("DB write error: {}", e))?;
    state.event_tx.emit(crate::ServerEvent::SessionsChanged);
    Ok(())
}

pub fn load_sessions(state: &Arc<ServerState>) -> Result<Vec<SessionMeta>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::db_load_sessions(&conn).map_err(|e| format!("DB read error: {}", e))
}

pub fn load_sessions_paged(limit: usize, offset: usize, state: &Arc<ServerState>) -> Result<Vec<SessionMeta>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::db_load_sessions_paged(&conn, limit, offset).map_err(|e| format!("DB read error: {}", e))
}

pub fn write_to_pty(session_id: String, data: String, state: &Arc<ServerState>) -> Result<(), String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.write_to_session(&session_id, &data)
}

pub fn resize_pty(
    session_id: String,
    cols: u16,
    rows: u16,
    state: &Arc<ServerState>,
) -> Result<(), String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.resize_session(&session_id, cols, rows)
}

pub fn create_shell_pty_session(
    session_id: String,
    directory: String,
    state: &Arc<ServerState>,
) -> Result<(), String> {
    // Use saved CWD if available, falling back to the session's workspace directory
    let effective_dir = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::db_load_terminal_cwd(&conn, &session_id)
            .ok()
            .flatten()
            .unwrap_or(directory)
    };
    eprintln!("[create_shell_pty_session] session_id={}, directory={:?}", session_id, effective_dir);
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.create_shell_session(&session_id, state.event_tx.clone(), effective_dir)
}

pub fn save_terminal_cwd(
    session_id: String,
    state: &Arc<ServerState>,
) -> Result<(), String> {
    let cwd = {
        let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
        manager.get_session_cwd(&session_id)?
    };
    if let Some(cwd) = cwd {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::db_save_terminal_cwd(&conn, &session_id, &cwd)
            .map_err(|e| format!("DB write error: {}", e))?;
    }
    Ok(())
}

pub fn pty_has_child_process(
    session_id: String,
    state: &Arc<ServerState>,
) -> Result<bool, String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.has_child_process(&session_id)
}

pub fn pty_foreground_command(
    session_id: String,
    state: &Arc<ServerState>,
) -> Result<Option<String>, String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    manager.foreground_command(&session_id)
}

pub fn directory_exists(path: String) -> bool {
    let expanded = expand_tilde(&path);
    if is_tcc_protected(&expanded) {
        return true;
    }
    std::path::Path::new(&expanded).is_dir()
}

pub fn get_pty_scrollback(session_id: String, state: &Arc<ServerState>) -> Result<String, String> {
    let manager = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let data = manager.get_scrollback(&session_id)?;
    eprintln!("[get_pty_scrollback] session_id={}, scrollback_len={}", session_id, data.len());
    Ok(data)
}

// ── Agent session commands ──────────────────────────────────────────

pub async fn create_agent_session(
    session_id: String,
    directory: String,
    claude_session_id: Option<String>,
    resume: bool,
    system_prompt: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    state: Arc<ServerState>,
) -> Result<(), String> {
    let agent_script_paths = state.agent_script_paths.clone();
    let mcp_script = state.mcp_script_path.clone();
    let agent_manager = state.agent_manager.clone();
    let event_tx = state.event_tx.clone();
    let db = state.db.clone();

    tokio::task::spawn_blocking(move || {
        let provider = provider.unwrap_or_else(|| "claude-code".to_string());

        // Expand leading ~ to $HOME (shells expand ~ but programmatic callers don't)
        let home = std::env::var("HOME")
            .unwrap_or_else(|_| format!("/Users/{}", std::env::var("USER").unwrap_or_default()));
        let directory = if directory.starts_with("~/") {
            format!("{}/{}", home, &directory[2..])
        } else if directory == "~" {
            home
        } else {
            directory
        };

        // Resolve git root so the agent always spawns from the project root.
        // This lets Claude see the root CLAUDE.md / .claude/ even for worktree sessions.
        let agent_cwd = find_git_root(&directory).unwrap_or_else(|| directory.clone());

        // On fresh sessions where the selected dir differs from the git root (e.g. a worktree),
        // prepend a cd instruction so Claude immediately navigates to the right directory.
        let system_prompt = if !resume && agent_cwd != directory {
            let cd_prefix = format!(
                "Your working directory for this session is `{dir}`. \
                 Start by running `cd {dir}` before doing any file work.",
                dir = directory
            );
            match system_prompt {
                Some(ref existing) if !existing.is_empty() => {
                    Some(format!("{}\n\n{}", cd_prefix, existing))
                }
                _ => Some(cd_prefix),
            }
        } else {
            system_prompt
        };

        // Shadow directory with git root — the agent bridge will use this as cwd.
        let directory = agent_cwd;

        eprintln!("[create_agent_session] session_id={}, directory={:?}, claude_session_id={:?}, resume={}, provider={}", session_id, directory, claude_session_id, resume, provider);

        let agent_script = agent_script_paths
            .get(&provider)
            .ok_or_else(|| format!("Agent bridge script not found for provider '{}'. Run `pnpm build` to build it.", provider))?
            .clone();

        let config = if provider == "claude-code" {
            // Build MCP servers config: start with the orchestrator's own MCP server
            let mut mcp_servers = if let Some(ref mcp_path) = mcp_script {
                serde_json::json!({
                    "orchestrator": {
                        "command": "node",
                        "args": [mcp_path],
                        "env": {
                            "ORCHESTRATOR_SESSION_ID": &session_id,
                            "ORCHESTRATOR_SIGNAL_DIR": if cfg!(debug_assertions) { "/tmp/orchestrator-signals-dev" } else { "/tmp/orchestrator-signals" }
                        }
                    }
                })
            } else {
                serde_json::json!({})
            };

            // Merge project-level MCP servers from .claude/mcp.json
            let mcp_json_path = Path::new(&directory).join(".claude/mcp.json");
            if mcp_json_path.exists() {
                if let Ok(contents) = std::fs::read_to_string(&mcp_json_path) {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) {
                        if let Some(servers) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
                            if let Some(obj) = mcp_servers.as_object_mut() {
                                for (name, server_config) in servers {
                                    obj.insert(name.clone(), server_config.clone());
                                }
                            }
                        }
                    }
                }
            }

            // Also check ~/.claude/mcp.json for user-global MCP servers
            if let Ok(home) = std::env::var("HOME") {
                let global_mcp_path = Path::new(&home).join(".claude/mcp.json");
                if global_mcp_path.exists() {
                    if let Ok(contents) = std::fs::read_to_string(&global_mcp_path) {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) {
                            if let Some(servers) = parsed.get("mcpServers").and_then(|v| v.as_object()) {
                                if let Some(obj) = mcp_servers.as_object_mut() {
                                    for (name, server_config) in servers {
                                        // Project-level takes precedence; don't overwrite
                                        if !obj.contains_key(name) {
                                            obj.insert(name.clone(), server_config.clone());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Resolve the `claude` CLI so the Agent SDK can find it inside the app bundle
            let claude_cli = resolve_bin("claude");

            serde_json::json!({
                "sessionId": &session_id,
                "cwd": &directory,
                "resume": if resume { claude_session_id.as_deref() } else { None::<&str> },
                "mcpServers": mcp_servers,
                "systemPrompt": system_prompt,
                "claudeCliPath": claude_cli,
                "permissionMode": permission_mode,
            })
        } else {
            // Generic config for other providers (opencode, codex, etc.)
            serde_json::json!({
                "sessionId": &session_id,
                "cwd": &directory,
                "systemPrompt": system_prompt,
                "model": model,
                "permissionMode": permission_mode,
                "ocSessionId": if resume { claude_session_id.as_deref() } else { None::<&str> },
                // codex bridge expects `codexThreadId` (not `ocSessionId`) for thread resume
                "codexThreadId": if resume && provider == "codex" { claude_session_id.as_deref() } else { None::<&str> },
            })
        };
        let config_json = config.to_string();

        let manager = agent_manager.lock().map_err(|e| e.to_string())?;
        manager.create_session(
            &session_id,
            event_tx,
            &agent_script,
            &config_json,
            Some(db),
            claude_session_id.clone(),
            Some(directory.clone()),
        )
    }).await.map_err(|e| e.to_string())?
}

pub fn send_agent_message(session_id: String, message: String, state: &Arc<ServerState>) -> Result<(), String> {
    // Broadcast user messages to all connected frontends so multi-client UIs stay in sync.
    // The sending frontend already has the message optimistically; the user_history handler
    // in useAgentEvents deduplicates by text content.
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&message) {
        if parsed.get("type").and_then(|t| t.as_str()) == Some("user") {
            if let Some(msg_obj) = parsed.get("message") {
                let history_line = serde_json::json!({
                    "type": "user_history",
                    "message": msg_obj,
                }).to_string();
                state.event_tx.emit(crate::ServerEvent::AgentMessage {
                    session_id: session_id.clone(),
                    line: history_line,
                });
            }
        }
    }
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    manager.send_message(&session_id, &message)
}

pub fn abort_agent(session_id: String, state: &Arc<ServerState>) -> Result<(), String> {
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    manager.abort(&session_id)
}

pub fn set_agent_cwd(session_id: String, cwd: String, state: &Arc<ServerState>) -> Result<(), String> {
    // Expand ~ to absolute path (agent bridge needs absolute paths)
    let home = std::env::var("HOME")
        .unwrap_or_else(|_| format!("/Users/{}", std::env::var("USER").unwrap_or_default()));
    let abs_cwd = if cwd.starts_with("~/") {
        format!("{}/{}", home, &cwd[2..])
    } else if cwd == "~" {
        home
    } else {
        cwd
    };
    let msg = serde_json::json!({"type": "set_cwd", "cwd": abs_cwd}).to_string();
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    manager.send_message(&session_id, &msg)
}

pub fn destroy_agent_session(session_id: String, state: &Arc<ServerState>) -> Result<(), String> {
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    manager.destroy_session(&session_id)
}

pub fn get_agent_history(session_id: String, state: &Arc<ServerState>) -> Result<Vec<String>, String> {
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    manager.get_history(&session_id)
}

pub fn get_busy_sessions(state: &Arc<ServerState>) -> Result<Vec<String>, String> {
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    Ok(manager.get_busy_sessions())
}

/// Spawn the opencode bridge in list-models mode and return the JSON array of models.
pub async fn fetch_opencode_models(state: Arc<ServerState>) -> Result<String, String> {
    let bridge_path = state
        .agent_script_paths
        .get("opencode")
        .ok_or_else(|| "OpenCode bridge script not found".to_string())?
        .clone();

    let result: Result<String, String> = tokio::task::spawn_blocking(move || {
        let node_bin = resolve_bin("node")
            .ok_or_else(|| "Could not find `node` binary".to_string())?;
        let path_env = shell_path();
        let home = std::env::var("HOME")
            .unwrap_or_else(|_| format!("/Users/{}", std::env::var("USER").unwrap_or_default()));
        let config_json = r#"{"mode":"list-models"}"#;

        let output = std::process::Command::new(&node_bin)
            .arg(&bridge_path)
            .arg(config_json)
            .env("PATH", path_env)
            .env("HOME", &home)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("Failed to spawn opencode bridge: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return Ok("[]".to_string());
        }
        let first_line = stdout.lines().next().unwrap_or("[]");
        Ok(first_line.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    result
}

/// Spawn the codex bridge in list-models mode and return the JSON array of models.
pub async fn fetch_codex_models(state: Arc<ServerState>) -> Result<String, String> {
    let bridge_path = state
        .agent_script_paths
        .get("codex")
        .ok_or_else(|| "Codex bridge script not found".to_string())?
        .clone();

    let result: Result<String, String> = tokio::task::spawn_blocking(move || {
        let node_bin = resolve_bin("node")
            .ok_or_else(|| "Could not find `node` binary".to_string())?;
        let path_env = shell_path();
        let home = std::env::var("HOME")
            .unwrap_or_else(|_| format!("/Users/{}", std::env::var("USER").unwrap_or_default()));
        let openai_api_key = shell_env_var("OPENAI_API_KEY");
        let config_json = r#"{"mode":"list-models"}"#;

        let mut cmd = std::process::Command::new(&node_bin);
        cmd.arg(&bridge_path)
            .arg(config_json)
            .env("PATH", path_env)
            .env("HOME", &home)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(key) = openai_api_key {
            cmd.env("OPENAI_API_KEY", key);
        }

        let output = cmd.output()
            .map_err(|e| format!("Failed to spawn codex bridge: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return Ok("[]".to_string());
        }
        let first_line = stdout.lines().next().unwrap_or("[]");
        Ok(first_line.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    result
}

/// Check which agent providers have their CLI available on the system.
/// Returns a JSON object like {"claude-code": true, "opencode": false}.
pub fn check_providers() -> HashMap<String, bool> {
    let mut result = HashMap::new();
    result.insert("claude-code".to_string(), resolve_bin("claude").is_some());
    result.insert("opencode".to_string(), resolve_bin("opencode").is_some());
    result.insert("codex".to_string(), resolve_bin("codex").is_some());
    result
}

pub async fn list_directories(partial: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || list_directories_sync(partial))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn list_slash_commands(directory: String) -> Result<Vec<SlashCommand>, String> {
    tokio::task::spawn_blocking(move || list_slash_commands_sync(directory))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn list_worktrees(directory: String) -> Result<Vec<WorktreeInfo>, String> {
    tokio::task::spawn_blocking(move || list_worktrees_sync(directory))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

pub fn create_worktree(
    directory: String,
    branch_name: String,
    worktree_name: Option<String>,
) -> Result<String, String> {
    let expanded = expand_tilde(&directory);

    let name = worktree_name.unwrap_or_else(|| branch_name.replace('/', "-"));
    let worktree_path = std::path::Path::new(&expanded)
        .join(".worktrees")
        .join(&name);

    // Create .worktrees directory if needed
    let worktrees_dir = std::path::Path::new(&expanded).join(".worktrees");
    std::fs::create_dir_all(&worktrees_dir)
        .map_err(|e| format!("Failed to create .worktrees dir: {}", e))?;

    // Try creating with a new branch first
    let output = std::process::Command::new("git")
        .current_dir(&expanded)
        .env("PATH", shell_path())
        .args([
            "worktree",
            "add",
            &worktree_path.to_string_lossy(),
            "-b",
            &branch_name,
        ])
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        // Branch might already exist, try without -b
        let output2 = std::process::Command::new("git")
            .current_dir(&expanded)
            .env("PATH", shell_path())
            .args([
                "worktree",
                "add",
                &worktree_path.to_string_lossy(),
                &branch_name,
            ])
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output2.status.success() {
            let err = String::from_utf8_lossy(&output2.stderr);
            return Err(format!("git worktree add failed: {}", err.trim()));
        }
    }

    // Clone heavy gitignored dirs (node_modules, .venv, etc.) via APFS clonefile
    clone_heavy_dirs(&expanded, &worktree_path.to_string_lossy());

    let home = std::env::var("HOME").unwrap_or_default();
    let result = worktree_path.to_string_lossy().to_string();
    if !home.is_empty() && result.starts_with(&home) {
        Ok(format!("~{}", &result[home.len()..]))
    } else {
        Ok(result)
    }
}

pub fn remove_worktree(path: String) -> Result<(), String> {
    let expanded = expand_tilde(&path);

    let output = std::process::Command::new("git")
        .current_dir(&expanded)
        .env("PATH", shell_path())
        .args(["worktree", "remove", &expanded, "--force"])
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree remove failed: {}", err.trim()));
    }

    Ok(())
}

pub fn get_conversation_title(
    claude_session_id: String,
    directory: String,
    state: &Arc<ServerState>,
) -> Result<Option<String>, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;

    let mtime = match file_mtime(&jsonl_path) {
        Some(t) => t,
        None => return Ok(None),
    };

    // Check cache
    {
        let cache = state.jsonl_cache.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = cache.title.get(&jsonl_path) {
            if entry.mtime == mtime {
                return Ok(entry.value.clone());
            }
        }
    }

    let result = parse_conversation_title(&jsonl_path)?;

    // Update cache
    {
        let mut cache = state.jsonl_cache.lock().map_err(|e| e.to_string())?;
        cache.title.insert(jsonl_path, crate::CachedEntry { mtime, value: result.clone() });
    }

    Ok(result)
}

/// Query the OpenCode SQLite database for the latest session title matching a directory.
/// OpenCode stores its DB at ~/.local/share/opencode/opencode.db with a `session` table.
pub fn get_opencode_session_title(directory: String) -> Result<Option<String>, String> {
    let expanded_dir = expand_tilde(&directory);

    let db_path = dirs_opencode_db();
    let db_path = match db_path {
        Some(p) if p.exists() => p,
        _ => return Ok(None),
    };

    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open opencode DB: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT title FROM session WHERE directory = ?1 ORDER BY time_updated DESC LIMIT 1")
        .map_err(|e| format!("SQL prepare error: {}", e))?;

    let title: Option<String> = stmt
        .query_row(rusqlite::params![expanded_dir], |row| row.get(0))
        .ok();

    Ok(title)
}

pub fn get_session_usage(
    claude_session_id: String,
    directory: String,
    state: &Arc<ServerState>,
) -> Result<SessionUsage, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;

    if !jsonl_path.exists() {
        return Ok(SessionUsage::default());
    }

    let jsonl_path_str = jsonl_path.to_string_lossy().to_string();

    // Get current mtime to detect file changes
    let current_mtime = jsonl_path
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Check in-memory cache first (acquire + release before touching any other lock)
    let cache_hit = {
        let cache = state.jsonl_cache.lock().map_err(|e| e.to_string())?;
        cache.usage.get(&jsonl_path).map(|entry| (entry.byte_offset, entry.value.clone()))
    };

    // Fall back to SQLite cache on a cache miss (no nested lock now)
    let (byte_offset, base_usage) = match cache_hit {
        Some(hit) => hit,
        None => {
            let db_conn = state.db.lock().map_err(|e| e.to_string())?;
            match db::db_get_usage_cache(&db_conn, &jsonl_path_str) {
                Ok(Some((offset, usage, stored_mtime)))
                    if stored_mtime == current_mtime || offset > 0 =>
                {
                    (offset, usage)
                }
                _ => (0, SessionUsage::default()),
            }
        }
    };

    let (mut usage, new_offset) = parse_session_usage_incremental(
        &jsonl_path,
        byte_offset,
        &base_usage,
        &state.pricing,
    )?;

    // Check if LLM is currently busy (last entry is not "assistant")
    usage.is_busy = is_session_busy(&jsonl_path);

    // Update in-memory cache and persist to SQLite when new data was parsed
    if new_offset != byte_offset {
        {
            let mut cache = state.jsonl_cache.lock().map_err(|e| e.to_string())?;
            cache.usage.insert(
                jsonl_path,
                IncrementalUsageEntry {
                    byte_offset: new_offset,
                    value: usage.clone(),
                },
            );
        }
        // Persist to SQLite (best-effort; don't fail the command on DB errors)
        if let Ok(db_conn) = state.db.lock() {
            let _ = db::db_set_usage_cache(
                &db_conn,
                &jsonl_path_str,
                new_offset,
                current_mtime,
                &usage,
            );
        }
    }

    Ok(usage)
}

pub fn get_total_usage_today(state: &Arc<ServerState>) -> Result<TodayUsageSummary, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    let projects_dir = std::path::PathBuf::from(&home)
        .join(".claude")
        .join("projects");

    if !projects_dir.exists() {
        return Ok(TodayUsageSummary { cost_usd: 0.0, total_tokens: 0 });
    }

    // Today's date in UTC (matching JSONL timestamp format)
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let today = civil_date_from_epoch(now_secs);

    let mut total_cost = 0.0;
    let mut total_tokens = 0u64;

    // Walk all project subdirectories
    let project_entries = std::fs::read_dir(&projects_dir)
        .map_err(|e| format!("Read projects dir: {}", e))?;

    for project_entry in project_entries.flatten() {
        if !project_entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let session_entries = match std::fs::read_dir(project_entry.path()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in session_entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // Skip files not modified today (quick filter before parsing)
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    let age = std::time::SystemTime::now()
                        .duration_since(modified)
                        .unwrap_or_default();
                    if age.as_secs() > 86400 {
                        continue;
                    }
                }
            }
            let (cost, tokens) = usage_from_jsonl(&path, &today, &state.pricing);
            total_cost += cost;
            total_tokens += tokens;
        }
    }

    Ok(TodayUsageSummary { cost_usd: total_cost, total_tokens })
}

pub async fn get_usage_dashboard(days: u32, state: Arc<ServerState>) -> Result<UsageDashboard, String> {
    let pricing = state.pricing.clone();
    tokio::task::spawn_blocking(move || {
        compute_usage_dashboard(days, &pricing)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn get_message_count(claude_session_id: String, directory: String) -> Result<u32, String> {
    tokio::task::spawn_blocking(move || get_message_count_sync(claude_session_id, directory))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn generate_smart_title(
    claude_session_id: String,
    directory: String,
    state: Arc<ServerState>,
) -> Result<Option<String>, String> {
    let port = state.title_server_port.load(std::sync::atomic::Ordering::Relaxed);
    if port == 0 {
        return Err("Title server not running".to_string());
    }

    // Extract user message from JSONL in a blocking task
    let user_msg = tokio::task::spawn_blocking(move || {
        extract_first_user_message(&claude_session_id, &directory)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let user_msg = match user_msg {
        Some(m) => m,
        None => return Ok(None),
    };

    let text = user_msg.get("text").and_then(|t| t.as_str()).unwrap_or("");
    let body = serde_json::json!({ "message": text }).to_string();
    call_title_server(port, body).await
}

pub async fn generate_title_from_text(
    message: String,
    state: Arc<ServerState>,
) -> Result<Option<String>, String> {
    let port = state.title_server_port.load(std::sync::atomic::Ordering::Relaxed);
    if port == 0 {
        return Err("Title server not running".to_string());
    }

    let truncated: String = message.chars().take(500).collect();
    let body = serde_json::json!({ "message": truncated }).to_string();
    call_title_server(port, body).await
}

pub async fn classify_prompt(
    message: String,
    state: Arc<ServerState>,
) -> Result<String, String> {
    let port = state.title_server_port.load(std::sync::atomic::Ordering::Relaxed);
    if port == 0 {
        return Ok("complex".to_string());
    }

    let truncated: String = message.chars().take(500).collect();
    call_classify_server(port, truncated).await
}

pub fn get_conversation_jsonl(
    claude_session_id: String,
    directory: String,
    state: &Arc<ServerState>,
) -> Result<Vec<String>, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;
    if !jsonl_path.exists() {
        return Ok(vec![]);
    }
    get_cached_conversation_lines(&jsonl_path, &state.jsonl_cache)
}

pub fn get_conversation_jsonl_tail(
    claude_session_id: String,
    directory: String,
    max_lines: usize,
    state: &Arc<ServerState>,
) -> Result<ConversationTailResult, String> {
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;
    if !jsonl_path.exists() {
        return Ok(ConversationTailResult { lines: vec![], total: 0 });
    }

    let all_lines = get_cached_conversation_lines(&jsonl_path, &state.jsonl_cache)?;
    let total = all_lines.len();
    let tail = if total <= max_lines {
        all_lines
    } else {
        all_lines[total - max_lines..].to_vec()
    };

    Ok(ConversationTailResult { lines: tail, total })
}

// ── DB-backed conversation message commands ───────────────────────────────

#[derive(Serialize)]
pub struct ConversationMessagesResult {
    pub messages: Vec<crate::db::ChatMessageRow>,
    pub total: usize,
}

/// Get all conversation messages from the DB (with lazy ingest fallback).
pub fn get_conversation_messages(
    claude_session_id: String,
    directory: String,
    state: &Arc<ServerState>,
) -> Result<Vec<crate::db::ChatMessageRow>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock error: {}", e))?;

    // Try DB first
    let messages = crate::db::db_get_conversation_messages(&conn, &claude_session_id)
        .map_err(|e| format!("DB query error: {}", e))?;

    if !messages.is_empty() {
        return Ok(messages);
    }

    // Lazy ingest: if DB is empty but JSONL exists, ingest now
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;
    if jsonl_path.exists() {
        let n = crate::ingest::ingest_jsonl_to_db(&conn, &claude_session_id, &directory)?;
        if n > 0 {
            return crate::db::db_get_conversation_messages(&conn, &claude_session_id)
                .map_err(|e| format!("DB query error: {}", e));
        }
    }

    Ok(vec![])
}

/// Get the last N messages + total from the DB (with lazy ingest fallback).
pub fn get_conversation_messages_tail(
    claude_session_id: String,
    directory: String,
    max_messages: usize,
    state: &Arc<ServerState>,
) -> Result<ConversationMessagesResult, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock error: {}", e))?;

    // Check total count first
    let total: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM conversation_messages WHERE claude_session_id = ?1",
            rusqlite::params![claude_session_id],
            |row| row.get::<_, usize>(0),
        )
        .unwrap_or(0);

    if total > 0 {
        let (messages, total) =
            crate::db::db_get_conversation_messages_tail(&conn, &claude_session_id, max_messages)
                .map_err(|e| format!("DB query error: {}", e))?;
        return Ok(ConversationMessagesResult { messages, total });
    }

    // Lazy ingest fallback
    let jsonl_path = jsonl_path_for(&claude_session_id, &directory)?;
    if jsonl_path.exists() {
        let n = crate::ingest::ingest_jsonl_to_db(&conn, &claude_session_id, &directory)?;
        if n > 0 {
            let (messages, total) = crate::db::db_get_conversation_messages_tail(
                &conn,
                &claude_session_id,
                max_messages,
            )
            .map_err(|e| format!("DB query error: {}", e))?;
            return Ok(ConversationMessagesResult { messages, total });
        }
    }

    Ok(ConversationMessagesResult {
        messages: vec![],
        total: 0,
    })
}

pub fn search_session_content(
    sessions: Vec<SearchableSession>,
    query: String,
) -> Result<Vec<String>, String> {
    use grep_regex::RegexMatcherBuilder;
    use grep_searcher::sinks::UTF8;
    use grep_searcher::SearcherBuilder;

    let pattern = regex::escape(&query);
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(true)
        .build(&pattern)
        .map_err(|e| format!("Invalid search pattern: {}", e))?;

    let mut matched_ids = Vec::new();

    for session in &sessions {
        let jsonl_path = match jsonl_path_for(&session.claude_session_id, &session.directory) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !jsonl_path.exists() {
            continue;
        }

        let mut found = false;
        let mut searcher = SearcherBuilder::new().build();
        let _ = searcher.search_path(
            &matcher,
            &jsonl_path,
            UTF8(|_line_num, _line| {
                found = true;
                Ok(false) // stop after first match
            }),
        );

        if found {
            matched_ids.push(session.claude_session_id.clone());
        }
    }

    Ok(matched_ids)
}

pub fn watch_jsonl(
    claude_session_id: String,
    directory: String,
    state: &Arc<ServerState>,
) -> Result<(), String> {
    let path = jsonl_path_for(&claude_session_id, &directory)?;
    let mut watcher = state.file_watcher.lock().map_err(|e| e.to_string())?;
    watcher.watch(path)
}
pub fn unwatch_jsonl(
    claude_session_id: String,
    directory: String,
    state: &Arc<ServerState>,
) -> Result<(), String> {
    let path = jsonl_path_for(&claude_session_id, &directory)?;
    let mut watcher = state.file_watcher.lock().map_err(|e| e.to_string())?;
    watcher.unwatch(&path)
}

pub async fn get_git_status(directory: String) -> Result<GitStatusResult, String> {
    tokio::task::spawn_blocking(move || get_git_status_sync(directory))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn get_git_diff(directory: String, file_path: String, staged: bool) -> Result<String, String> {
    tokio::task::spawn_blocking(move || get_git_diff_sync(directory, file_path, staged))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn get_git_numstat(directory: String, staged: bool) -> Result<HashMap<String, (u32, u32)>, String> {
    tokio::task::spawn_blocking(move || {
        let mut cmd = git_command(&directory);
        cmd.arg("diff").arg("--numstat");
        if staged {
            cmd.arg("--cached");
        }
        let output = cmd.output().map_err(|e| format!("Failed to run git diff --numstat: {}", e))?;
        let mut map = HashMap::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() == 3 {
                let added = parts[0].parse::<u32>().unwrap_or(0);
                let removed = parts[1].parse::<u32>().unwrap_or(0);
                map.insert(parts[2].to_string(), (added, removed));
            }
        }
        Ok(map)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub fn read_file_content(directory: String, file_path: String) -> Result<String, String> {
    let expanded = expand_tilde(&directory);
    let full_path = std::path::PathBuf::from(&expanded).join(&file_path);
    std::fs::read_to_string(&full_path)
        .map_err(|e| format!("Failed to read file: {}", e))
}

pub fn read_file(file_path: String) -> Result<String, String> {
    let expanded = expand_tilde(&file_path);
    let meta = std::fs::metadata(&expanded).map_err(|e| format!("Failed to stat file: {}", e))?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("File too large (>10MB)".into());
    }
    std::fs::read_to_string(&expanded).map_err(|e| format!("Failed to read file: {}", e))
}

pub fn read_file_base64(file_path: String) -> Result<String, String> {
    use std::io::Read;
    let expanded = expand_tilde(&file_path);
    let meta = std::fs::metadata(&expanded).map_err(|e| format!("Failed to stat file: {}", e))?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("File too large (>10MB)".into());
    }
    let mut buf = Vec::new();
    std::fs::File::open(&expanded)
        .map_err(|e| format!("Failed to open file: {}", e))?
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(base64_encode(&buf))
}

pub fn write_file(file_path: String, content: String) -> Result<(), String> {
    let expanded = expand_tilde(&file_path);
    if content.len() > 10 * 1024 * 1024 {
        return Err("Content too large (>10MB)".into());
    }
    std::fs::write(&expanded, &content).map_err(|e| format!("Failed to write file: {}", e))
}

pub fn resolve_path(file_path: String) -> Result<String, String> {
    let expanded = expand_tilde(&file_path);
    std::fs::canonicalize(&expanded)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("Failed to resolve path: {}", e))
}

pub fn list_files(partial: String) -> Result<Vec<(String, bool)>, String> {
    let expanded = expand_tilde(&partial);

    let (dir, prefix) = if expanded.ends_with('/') {
        (std::path::PathBuf::from(&expanded), String::new())
    } else {
        let p = std::path::PathBuf::from(&expanded);
        let parent = p.parent().unwrap_or(std::path::Path::new("/"));
        let prefix = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        (parent.to_path_buf(), prefix)
    };

    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Failed to read dir: {}", e))?;
    let mut results: Vec<(String, bool)> = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if !prefix.is_empty() && !name.to_lowercase().starts_with(&prefix.to_lowercase()) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let display = if partial.starts_with('~') {
            let home = std::env::var("HOME").unwrap_or_default();
            let full = dir.join(&name).to_string_lossy().to_string();
            full.replacen(&home, "~", 1)
        } else {
            dir.join(&name).to_string_lossy().to_string()
        };
        results.push((display, is_dir));
    }

    results.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    results.truncate(50);
    Ok(results)
}

pub async fn search_project_files(directory: String, query: String, state: Arc<ServerState>) -> Result<Vec<String>, String> {
    use std::time::Instant;

    let directory = expand_tilde(&directory);

    const CACHE_TTL_SECS: u64 = 30;

    // Check cache on the blocking pool to avoid holding std::sync::Mutex on async runtime
    let state_c = state.clone();
    let dir_c = directory.clone();
    let cached = tokio::task::spawn_blocking(move || {
        let cache = state_c.file_list_cache.lock().map_err(|e| e.to_string())?;
        Ok::<_, String>(cache.entries.get(&dir_c).and_then(|(cached_at, cached_files)| {
            if cached_at.elapsed().as_secs() < CACHE_TTL_SECS {
                Some(cached_files.clone())
            } else {
                None
            }
        }))
    }).await.map_err(|e| e.to_string())??;

    let files: Vec<String> = if let Some(files) = cached {
        files
    } else {
        let dir = directory.clone();
        let files = tokio::task::spawn_blocking(move || list_project_files(&dir))
            .await
            .map_err(|e| e.to_string())?;
        // Update cache on the blocking pool
        let state_c = state.clone();
        let dir_c = directory.clone();
        let files_c = files.clone();
        tokio::task::spawn_blocking(move || {
            if let Ok(mut cache) = state_c.file_list_cache.lock() {
                cache.entries.insert(dir_c, (Instant::now(), files_c));
            }
        }).await.map_err(|e| e.to_string())?;
        files
    };

    let query_lower = query.to_lowercase();

    if query_lower.is_empty() {
        let mut results: Vec<String> = files.into_iter().take(20).collect();
        results.sort();
        return Ok(results);
    }

    let query_chars: Vec<char> = query_lower.chars().collect();
    let mut results: Vec<(String, i32)> = Vec::new();

    for line in files.iter() {
        let line: &String = line;
        if line.is_empty() {
            continue;
        }
        let line_lower = line.to_lowercase();
        let filename = line.rsplit('/').next().unwrap_or(line).to_lowercase();

        if let Some(score) = fuzzy_score(&query_chars, &query_lower, &line_lower, &filename) {
            results.push((line.to_string(), score));
        }
    }

    results.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    results.truncate(20);

    Ok(results.into_iter().map(|(path, _)| path).collect())
}

pub async fn get_pull_requests(directory: String) -> PullRequestsResult {
    tokio::task::spawn_blocking(move || get_pull_requests_sync(&directory)).await.unwrap_or_else(|_| PullRequestsResult {
        review_requested: vec![],
        my_prs: vec![],
        gh_available: false,
        error: Some("Internal error".to_string()),
    })
}

pub async fn checkout_pr(directory: String, pr_number: u32) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output = gh_in_dir(&directory)
            .args(["pr", "checkout", &pr_number.to_string()])
            .output()
            .map_err(|e| format!("Failed to run gh: {}", e))?;
        if output.status.success() {
            let msg = String::from_utf8_lossy(&output.stderr);
            Ok(msg.trim().to_string())
        } else {
            let err = String::from_utf8_lossy(&output.stderr);
            Err(err.trim().to_string())
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn checkout_pr_worktree(
    directory: String,
    pr_number: u32,
    head_ref_name: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let expanded = expand_tilde(&directory);
        let dir_path = std::path::Path::new(&expanded);
        let worktree_name = format!("pr-{}", pr_number);
        let worktree_path = dir_path
            .join(".worktrees")
            .join(&worktree_name);

        let worktrees_dir = dir_path.join(".worktrees");
        std::fs::create_dir_all(&worktrees_dir)
            .map_err(|e| format!("Failed to create .worktrees dir: {}", e))?;

        let fetch = std::process::Command::new("git")
            .current_dir(&expanded)
            .env("PATH", shell_path())
            .args(["fetch", "origin", &head_ref_name])
            .output()
            .map_err(|e| format!("Failed to run git fetch: {}", e))?;
        if !fetch.status.success() {
            let err = String::from_utf8_lossy(&fetch.stderr);
            return Err(format!("git fetch failed: {}", err.trim()));
        }

        let wt = std::process::Command::new("git")
            .current_dir(&expanded)
            .env("PATH", shell_path())
            .args([
                "worktree",
                "add",
                "-b",
                &head_ref_name,
                &worktree_path.to_string_lossy(),
                &format!("origin/{}", head_ref_name),
            ])
            .output()
            .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

        if !wt.status.success() {
            let err_str = String::from_utf8_lossy(&wt.stderr);
            if err_str.contains("already exists") {
                let wt2 = std::process::Command::new("git")
                    .current_dir(&expanded)
                    .env("PATH", shell_path())
                    .args([
                        "worktree",
                        "add",
                        &worktree_path.to_string_lossy(),
                        &head_ref_name,
                    ])
                    .output()
                    .map_err(|e| format!("Failed to run git worktree add: {}", e))?;
                if !wt2.status.success() {
                    let err2 = String::from_utf8_lossy(&wt2.stderr);
                    return Err(format!("git worktree add failed: {}", err2.trim()));
                }
            } else {
                return Err(format!("git worktree add failed: {}", err_str.trim()));
            }
        }

        clone_heavy_dirs(&expanded, &worktree_path.to_string_lossy());

        Ok(worktree_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub fn list_branches(directory: String) -> Result<Vec<String>, String> {
    let output = git_command(&directory)
        .args(["branch", "--sort=-committerdate", "--format=%(refname:short)"])
        .output()
        .map_err(|e| format!("Failed to run git branch: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

pub fn switch_branch(directory: String, branch: String) -> Result<(), String> {
    let output = git_command(&directory)
        .args(["switch", &branch])
        .output()
        .map_err(|e| format!("Failed to run git switch: {}", e))?;
    if !output.status.success() {
        let output = git_command(&directory)
            .args(["checkout", &branch])
            .output()
            .map_err(|e| format!("Failed to run git checkout: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }
    Ok(())
}

pub fn get_branch_diff(directory: String, base: String, compare: String) -> Result<BranchDiffResult, String> {
    let output = git_command(&directory)
        .args(["diff", "--name-status", &format!("{}...{}", base, compare)])
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let files = stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(2, '\t').collect();
            if parts.len() == 2 {
                Some(BranchDiffFile {
                    status: parts[0].to_string(),
                    path: parts[1].to_string(),
                })
            } else {
                None
            }
        })
        .collect();
    Ok(BranchDiffResult { files })
}

pub fn get_branch_file_diff(directory: String, base: String, compare: String, file_path: String) -> Result<String, String> {
    let output = git_command(&directory)
        .args(["diff", &format!("{}...{}", base, compare), "--", &file_path])
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn get_branch_commits(directory: String, base: String, compare: String) -> Result<BranchCommitsResult, String> {
    let email_output = git_command(&directory)
        .args(["config", "user.email"])
        .output()
        .map_err(|e| format!("Failed to get user email: {}", e))?;
    let user_email = String::from_utf8_lossy(&email_output.stdout).trim().to_string();

    let output = git_command(&directory)
        .args([
            "log",
            "--pretty=format:COMMIT_START%n%H%n%h%n%ae%n%an%n%s",
            "--name-status",
            &format!("{}..{}", base, compare),
        ])
        .output()
        .map_err(|e| format!("Failed to run git log: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut commits: Vec<BranchCommit> = Vec::new();

    for block in stdout.split("COMMIT_START\n").filter(|b| !b.trim().is_empty()) {
        let lines: Vec<&str> = block.lines().collect();
        if lines.len() < 5 {
            continue;
        }
        let hash = lines[0].to_string();
        let short_hash = lines[1].to_string();
        let author_email = lines[2].to_string();
        let author_name = lines[3].to_string();
        let subject = lines[4].to_string();

        let files: Vec<BranchDiffFile> = lines[5..]
            .iter()
            .filter_map(|line| {
                let line = line.trim();
                if line.is_empty() { return None; }
                let parts: Vec<&str> = line.splitn(2, '\t').collect();
                if parts.len() == 2 {
                    Some(BranchDiffFile {
                        status: parts[0].to_string(),
                        path: parts[1].to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();

        let is_mine = !user_email.is_empty()
            && author_email.to_lowercase() == user_email.to_lowercase();

        commits.push(BranchCommit {
            hash,
            short_hash,
            author_email,
            author_name,
            subject,
            is_mine,
            files,
        });
    }

    Ok(BranchCommitsResult { commits, user_email })
}

pub async fn get_pr_diff(directory: String, pr_number: u32) -> Result<PrDiffResult, String> {
    tokio::task::spawn_blocking(move || {
        let diff_output = gh_in_dir(&directory)
            .args(["pr", "diff", &pr_number.to_string()])
            .output()
            .map_err(|e| format!("Failed to run gh pr diff: {}", e))?;
        if !diff_output.status.success() {
            return Err(String::from_utf8_lossy(&diff_output.stderr).to_string());
        }
        let full_diff = String::from_utf8_lossy(&diff_output.stdout).to_string();

        let mut files: Vec<PrFileEntry> = Vec::new();
        let mut current_file: Option<String> = None;
        let mut current_status = "M";
        for line in full_diff.lines() {
            if line.starts_with("diff --git a/") {
                if let Some(path) = current_file.take() {
                    files.push(PrFileEntry { path, status: current_status.to_string() });
                }
                if let Some(b_part) = line.split(" b/").last() {
                    current_file = Some(b_part.to_string());
                }
                current_status = "M";
            } else if line.starts_with("new file mode") {
                current_status = "A";
            } else if line.starts_with("deleted file mode") {
                current_status = "D";
            } else if line.starts_with("rename from") {
                current_status = "R";
            }
        }
        if let Some(path) = current_file {
            files.push(PrFileEntry { path, status: current_status.to_string() });
        }

        Ok(PrDiffResult { files, full_diff })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn get_pr_file_diff(directory: String, pr_number: u32, file_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let diff_output = gh_in_dir(&directory)
            .args(["pr", "diff", &pr_number.to_string()])
            .output()
            .map_err(|e| format!("Failed to run gh pr diff: {}", e))?;
        let full_diff = String::from_utf8_lossy(&diff_output.stdout);
        Ok(extract_file_diff(&full_diff, &file_path))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn post_pr_comment(
    directory: String,
    pr_number: u32,
    body: String,
    path: String,
    line: u32,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let repo_output = gh_in_dir(&directory)
            .args(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
            .output()
            .map_err(|e| format!("Failed to get repo info: {}", e))?;
        let repo = String::from_utf8_lossy(&repo_output.stdout).trim().to_string();
        if repo.is_empty() {
            return Err("Could not determine repository".to_string());
        }

        let pr_output = gh_in_dir(&directory)
            .args(["pr", "view", &pr_number.to_string(), "--json", "headRefOid", "-q", ".headRefOid"])
            .output()
            .map_err(|e| format!("Failed to get PR info: {}", e))?;
        let commit_id = String::from_utf8_lossy(&pr_output.stdout).trim().to_string();

        let output = gh_in_dir(&directory)
            .args([
                "api",
                &format!("repos/{}/pulls/{}/comments", repo, pr_number),
                "--method", "POST",
                "-f", &format!("body={}", body),
                "-f", &format!("path={}", path),
                "-F", &format!("line={}", line),
                "-f", &format!("commit_id={}", commit_id),
            ])
            .output()
            .map_err(|e| format!("Failed to post comment: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn get_pr_comments(directory: String, pr_number: u32) -> Result<Vec<PrComment>, String> {
    tokio::task::spawn_blocking(move || {
        let repo_output = gh_in_dir(&directory)
            .args(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
            .output()
            .map_err(|e| format!("Failed to get repo info: {}", e))?;
        let repo = String::from_utf8_lossy(&repo_output.stdout).trim().to_string();
        if repo.is_empty() {
            return Err("Could not determine repository".to_string());
        }

        let output = gh_in_dir(&directory)
            .args([
                "api",
                "-H", "Accept: application/vnd.github.full+json",
                &format!("repos/{}/pulls/{}/comments", repo, pr_number),
            ])
            .output()
            .map_err(|e| format!("Failed to get comments: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        let comments: Vec<GhPrComment> = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("Failed to parse comments: {}", e))?;

        Ok(comments
            .into_iter()
            .map(|c| PrComment {
                id: c.id,
                path: c.path.unwrap_or_default(),
                line: c.line.unwrap_or(0),
                body_html: c.body_html.unwrap_or_else(|| c.body.clone()),
                body: c.body,
                user: c.user.login,
                created_at: c.created_at,
            })
            .collect())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn get_pr_viewed_files(directory: String, pr_number: u32) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let repo_output = gh_in_dir(&directory)
            .args(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
            .output()
            .map_err(|e| format!("Failed to get repo info: {}", e))?;
        let repo = String::from_utf8_lossy(&repo_output.stdout).trim().to_string();
        if repo.is_empty() {
            return Err("Could not determine repository".to_string());
        }
        let parts: Vec<&str> = repo.splitn(2, '/').collect();
        if parts.len() != 2 {
            return Err("Invalid repository format".to_string());
        }
        let (owner, name) = (parts[0], parts[1]);

        let query = format!(
            r#"query {{ repository(owner: "{}", name: "{}") {{ pullRequest(number: {}) {{ files(first: 100) {{ nodes {{ path viewerViewedState }} }} }} }} }}"#,
            owner, name, pr_number
        );

        let output = gh_in_dir(&directory)
            .args(["api", "graphql", "-f", &format!("query={}", query)])
            .output()
            .map_err(|e| format!("Failed to query GraphQL: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        let json: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        let mut viewed = Vec::new();
        if let Some(nodes) = json
            .pointer("/data/repository/pullRequest/files/nodes")
            .and_then(|n| n.as_array())
        {
            for node in nodes {
                if node.get("viewerViewedState").and_then(|v| v.as_str()) == Some("VIEWED") {
                    if let Some(path) = node.get("path").and_then(|p| p.as_str()) {
                        viewed.push(path.to_string());
                    }
                }
            }
        }
        Ok(viewed)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn set_pr_file_viewed(directory: String, pr_number: u32, path: String, viewed: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let repo_output = gh_in_dir(&directory)
            .args(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
            .output()
            .map_err(|e| format!("Failed to get repo info: {}", e))?;
        let repo = String::from_utf8_lossy(&repo_output.stdout).trim().to_string();
        if repo.is_empty() {
            return Err("Could not determine repository".to_string());
        }
        let parts: Vec<&str> = repo.splitn(2, '/').collect();
        if parts.len() != 2 {
            return Err("Invalid repository format".to_string());
        }
        let (owner, name) = (parts[0], parts[1]);

        let id_query = format!(
            r#"query {{ repository(owner: "{}", name: "{}") {{ pullRequest(number: {}) {{ id }} }} }}"#,
            owner, name, pr_number
        );
        let id_output = gh_in_dir(&directory)
            .args(["api", "graphql", "-f", &format!("query={}", id_query)])
            .output()
            .map_err(|e| format!("Failed to query GraphQL: {}", e))?;
        if !id_output.status.success() {
            return Err(String::from_utf8_lossy(&id_output.stderr).to_string());
        }
        let id_json: serde_json::Value = serde_json::from_slice(&id_output.stdout)
            .map_err(|e| format!("Failed to parse response: {}", e))?;
        let pr_id = id_json
            .pointer("/data/repository/pullRequest/id")
            .and_then(|v| v.as_str())
            .ok_or("Could not get PR node ID")?
            .to_string();

        let mutation = if viewed {
            format!(
                r#"mutation {{ markFileAsViewed(input: {{ pullRequestId: "{}", path: "{}" }}) {{ clientMutationId }} }}"#,
                pr_id, path
            )
        } else {
            format!(
                r#"mutation {{ unmarkFileAsViewed(input: {{ pullRequestId: "{}", path: "{}" }}) {{ clientMutationId }} }}"#,
                pr_id, path
            )
        };

        let output = gh_in_dir(&directory)
            .args(["api", "graphql", "-f", &format!("query={}", mutation)])
            .output()
            .map_err(|e| format!("Failed to run mutation: {}", e))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub fn set_dock_badge(label: Option<String>) {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSApplication;
        use objc2_foundation::{MainThreadMarker, NSString};
        if let Some(mtm) = MainThreadMarker::new() {
            let app = NSApplication::sharedApplication(mtm);
            let tile = app.dockTile();
            match label {
                Some(text) => {
                    let ns_str = NSString::from_str(&text);
                    tile.setBadgeLabel(Some(&ns_str));
                }
                None => {
                    tile.setBadgeLabel(None);
                }
            }
        }
    }
}

pub fn open_in_editor(editor: String, file_path: String) -> Result<(), String> {
    let expanded = expand_tilde(&file_path);
    if let Some(app_name) = editor.strip_prefix("app:") {
        std::process::Command::new("open")
            .args(["-a", app_name, &expanded])
            .spawn()
            .map_err(|e| format!("Failed to open app '{}': {}", app_name, e))?;
    } else {
        std::process::Command::new(&editor)
            .arg(&expanded)
            .env("PATH", shell_path())
            .spawn()
            .map_err(|e| format!("Failed to open editor '{}': {}", editor, e))?;
    }
    Ok(())
}

pub fn save_clipboard_image(base64_data: String) -> Result<String, String> {
    save_image_from_base64(&base64_data)
}

pub fn get_clipboard_file_paths() -> Vec<String> {
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(r#"
            use framework "AppKit"
            set pb to current application's NSPasteboard's generalPasteboard()
            set urlClass to current application's NSURL
            set urls to pb's readObjectsForClasses:{urlClass} options:(missing value)
            if urls is missing value then return ""
            set paths to {}
            repeat with u in urls
                set end of paths to (u's |path|() as text)
            end repeat
            return (paths as list) as text
        "#)
        .output();

    match output {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if text.is_empty() {
                vec![]
            } else {
                text.split(", ").map(|s| s.to_string()).collect()
            }
        }
        Err(_) => vec![],
    }
}

/// Detect repo-specific commit message format/conventions from well-known config files.
/// Returns the content of the first matching file found, or None.
fn detect_commit_format(directory: &str) -> Option<String> {
    let dir = std::path::Path::new(directory);

    // Dedicated commit skill/command files — use entire content
    let dedicated_paths = [
        ".claude/skills/commit/SKILL.md",
        ".claude/commands/commit.md",
    ];
    for rel in &dedicated_paths {
        let path = dir.join(rel);
        if let Ok(content) = std::fs::read_to_string(&path) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    // Generic config files — extract commit-related lines with context
    let generic_paths = [
        "CLAUDE.md",
        ".cursorrules",
        ".github/copilot-instructions.md",
    ];
    for rel in &generic_paths {
        let path = dir.join(rel);
        if let Ok(content) = std::fs::read_to_string(&path) {
            let extracted = extract_commit_section(&content);
            if let Some(section) = extracted {
                return Some(section);
            }
        }
    }

    None
}

/// Extract commit-related sections from a generic config file.
/// Looks for markdown headings or paragraphs containing commit-related keywords.
fn extract_commit_section(content: &str) -> Option<String> {
    let lines: Vec<&str> = content.lines().collect();
    let mut result = Vec::new();
    let mut in_section = false;
    let mut section_level = 0;

    for (i, line) in lines.iter().enumerate() {
        let lower = line.to_lowercase();

        // Check if this is a heading that mentions commits
        if line.starts_with('#') {
            let level = line.chars().take_while(|c| *c == '#').count();
            if lower.contains("commit") {
                in_section = true;
                section_level = level;
                result.push(*line);
                continue;
            } else if in_section && level <= section_level {
                // We've left the commit section
                break;
            }
        }

        if in_section {
            result.push(*line);
        } else if lower.contains("commit message") || lower.contains("commit format") || lower.contains("commit convention") {
            // Grab this line and a few lines of context
            let start = if i >= 2 { i - 2 } else { 0 };
            let end = std::cmp::min(i + 5, lines.len());
            for j in start..end {
                result.push(lines[j]);
            }
            break;
        }
    }

    if result.is_empty() {
        None
    } else {
        let joined = result.join("\n").trim().to_string();
        if joined.is_empty() { None } else { Some(joined) }
    }
}

pub async fn generate_commit_message(
    directory: String,
    model: Option<String>,
    provider: Option<String>,
    files: Option<Vec<String>>,
    state: Arc<ServerState>,
) -> Result<String, String> {
    let port = state.title_server_port.load(std::sync::atomic::Ordering::Relaxed);
    if port == 0 {
        return Err("Title server not running".to_string());
    }

    let dir_clone = directory.clone();
    let dir_clone2 = directory.clone();
    let diff = tokio::task::spawn_blocking(move || {
        let mut cmd = git_command(&dir_clone);
        cmd.args(["diff", "HEAD"]);
        if let Some(ref paths) = files {
            if !paths.is_empty() {
                cmd.arg("--");
                cmd.args(paths);
            }
        }
        let output = cmd.output()
            .map_err(|e| format!("Failed to run git diff HEAD: {}", e))?;
        if output.status.success() && !output.stdout.is_empty() {
            return Ok::<String, String>(String::from_utf8_lossy(&output.stdout).to_string());
        }
        // Fall back to staged diff for repos with no commits
        let mut cmd2 = git_command(&dir_clone);
        cmd2.args(["diff", "--staged"]);
        if let Some(ref paths) = files {
            if !paths.is_empty() {
                cmd2.arg("--");
                cmd2.args(paths);
            }
        }
        let staged = cmd2.output()
            .map_err(|e| format!("Failed to run git diff --staged: {}", e))?;
        Ok(String::from_utf8_lossy(&staged.stdout).to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    if diff.trim().is_empty() {
        return Ok(String::new());
    }

    // Detect repo-specific commit format
    let commit_format = detect_commit_format(&directory);

    // Fetch recent commit messages as style examples
    let recent_commits = tokio::task::spawn_blocking(move || {
        let output = git_command(&dir_clone2)
            .args(["log", "--format=%s", "-n", "15"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        output
    })
    .await
    .unwrap_or_default();

    let mut json_body = serde_json::json!({ "diff": diff });
    if let Some(ref m) = model {
        json_body["model"] = serde_json::json!(m);
    }
    if let Some(ref p) = provider {
        json_body["provider"] = serde_json::json!(p);
    }
    if let Some(ref fmt) = commit_format {
        // Limit to 4000 chars to avoid bloating the request
        let truncated = if fmt.len() > 4000 { &fmt[..4000] } else { fmt.as_str() };
        json_body["commitFormat"] = serde_json::json!(truncated);
    }
    if !recent_commits.is_empty() {
        json_body["recentCommits"] = serde_json::json!(recent_commits);
    }
    let body = json_body.to_string();
    let response = tokio::task::spawn_blocking(move || {
        let client = std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| format!("Failed to connect to title server: {}", e))?;
        client.set_read_timeout(Some(std::time::Duration::from_secs(60))).ok();
        client.set_write_timeout(Some(std::time::Duration::from_secs(5))).ok();

        use std::io::{Read, Write};
        let mut stream = client;
        let request = format!(
            "POST /commit-message HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            port,
            body.len(),
            body
        );
        stream.write_all(request.as_bytes())
            .map_err(|e| format!("Failed to send request: {}", e))?;

        let mut response = String::new();
        stream.read_to_string(&mut response)
            .map_err(|e| format!("Failed to read response: {}", e))?;

        Ok::<String, String>(response)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let body = response.split("\r\n\r\n").nth(1).unwrap_or("");
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(msg) = parsed.get("message").and_then(|m| m.as_str()) {
            return Ok(msg.trim().to_string());
        }
        if let Some(error) = parsed.get("error").and_then(|e| e.as_str()) {
            return Err(format!("Server error: {}", error));
        }
    }

    Ok(String::new())
}

pub async fn git_commit_and_push(directory: String, message: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let commit = git_command(&directory)
            .args(["commit", "-m", &message])
            .output()
            .map_err(|e| format!("Failed to run git commit: {}", e))?;
        if !commit.status.success() {
            return Err(format!(
                "git commit failed: {}",
                String::from_utf8_lossy(&commit.stderr)
            ));
        }

        let push = git_command(&directory)
            .args(["push"])
            .output()
            .map_err(|e| format!("Failed to run git push: {}", e))?;

        if !push.status.success() {
            let stderr = String::from_utf8_lossy(&push.stderr);
            if stderr.contains("no upstream") || stderr.contains("has no upstream") || stderr.contains("--set-upstream") {
                let branch_out = git_command(&directory)
                    .args(["branch", "--show-current"])
                    .output()
                    .map_err(|e| format!("Failed to get branch: {}", e))?;
                let branch = String::from_utf8_lossy(&branch_out.stdout).trim().to_string();

                let push2 = git_command(&directory)
                    .args(["push", "--set-upstream", "origin", &branch])
                    .output()
                    .map_err(|e| format!("Failed to run git push --set-upstream: {}", e))?;
                if !push2.status.success() {
                    return Err(format!(
                        "git push failed: {}",
                        String::from_utf8_lossy(&push2.stderr)
                    ));
                }
            } else {
                return Err(format!("git push failed: {}", stderr));
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn gh_open_pr_create(directory: String, base: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut cmd = gh_in_dir(&directory);
        cmd.args(["pr", "create", "--web"]);
        if let Some(ref b) = base {
            cmd.args(["--base", b]);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run gh pr create: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "gh pr create --web failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn generate_pr_description(
    directory: String,
    model: Option<String>,
    provider: Option<String>,
    base: Option<String>,
    state: Arc<ServerState>,
) -> Result<String, String> {
    let port = state.title_server_port.load(std::sync::atomic::Ordering::Relaxed);
    if port == 0 {
        return Err("Title server not running".to_string());
    }

    let dir = directory.clone();
    let base_branch = base.clone();
    let (branch_name, commits, diff) = tokio::task::spawn_blocking(move || {
        // Get current branch name
        let branch_out = git_command(&dir)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .map_err(|e| format!("Failed to get branch: {}", e))?;
        let branch = String::from_utf8_lossy(&branch_out.stdout).trim().to_string();

        // Determine base branch
        let base = base_branch.unwrap_or_else(|| {
            for candidate in &["main", "master", "develop"] {
                let check = git_command(&dir)
                    .args(["rev-parse", "--verify", candidate])
                    .output();
                if let Ok(out) = check {
                    if out.status.success() {
                        return candidate.to_string();
                    }
                }
            }
            "main".to_string()
        });

        // Get commit log since branching from base
        let log_out = git_command(&dir)
            .args(["log", &format!("{}..HEAD", base), "--oneline", "--no-decorate"])
            .output()
            .map_err(|e| format!("Failed to get git log: {}", e))?;
        let commits = String::from_utf8_lossy(&log_out.stdout).to_string();

        // Get diff against base
        let diff_out = git_command(&dir)
            .args(["diff", &format!("{}...HEAD", base)])
            .output()
            .map_err(|e| format!("Failed to get diff: {}", e))?;
        let diff = String::from_utf8_lossy(&diff_out.stdout).to_string();

        Ok::<(String, String, String), String>((branch, commits, diff))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Call title server /pr-description endpoint
    let mut json_body = serde_json::json!({
        "branchName": branch_name,
        "commits": commits,
        "diff": diff,
    });
    if let Some(ref m) = model {
        json_body["model"] = serde_json::json!(m);
    }
    if let Some(ref p) = provider {
        json_body["provider"] = serde_json::json!(p);
    }
    let body = json_body.to_string();

    let response = tokio::task::spawn_blocking(move || {
        let client = std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            std::time::Duration::from_secs(5),
        )
        .map_err(|e| format!("Failed to connect to title server: {}", e))?;
        client.set_read_timeout(Some(std::time::Duration::from_secs(90))).ok();
        client.set_write_timeout(Some(std::time::Duration::from_secs(5))).ok();

        use std::io::{Read, Write};
        let mut stream = client;
        let request = format!(
            "POST /pr-description HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            port,
            body.len(),
            body
        );
        stream.write_all(request.as_bytes())
            .map_err(|e| format!("Failed to send request: {}", e))?;

        let mut response = String::new();
        stream.read_to_string(&mut response)
            .map_err(|e| format!("Failed to read response: {}", e))?;

        Ok::<String, String>(response)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    // Parse HTTP response body (skip headers)
    let body = response.split("\r\n\r\n").nth(1).unwrap_or("{}");
    Ok(body.to_string())
}

pub async fn gh_create_pr(
    directory: String,
    title: String,
    body: String,
    base: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut cmd = gh_in_dir(&directory);
        cmd.args(["pr", "create", "--title", &title, "--body", &body, "--assignee", "@me"]);
        if let Some(ref b) = base {
            cmd.args(["--base", b]);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run gh pr create: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "gh pr create failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn git_checkout_new_branch(directory: String, branch_name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = git_command(&directory)
            .args(["checkout", "-b", &branch_name])
            .output()
            .map_err(|e| format!("Failed to run git checkout -b: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "git checkout -b failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn git_checkout_branch(directory: String, branch_name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = git_command(&directory)
            .args(["checkout", &branch_name])
            .output()
            .map_err(|e| format!("Failed to run git checkout: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "git checkout failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn git_unstage_all(directory: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = git_command(&directory)
            .args(["restore", "--staged", "."])
            .output()
            .map_err(|e| format!("Failed to run git restore: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "git restore --staged failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn git_stage_files(directory: String, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    tokio::task::spawn_blocking(move || {
        let mut cmd = git_command(&directory);
        cmd.args(["add", "--"]);
        for f in &files {
            cmd.arg(f);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git add: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "git add failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

pub async fn git_unstage_files(directory: String, files: Vec<String>) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    tokio::task::spawn_blocking(move || {
        let mut cmd = git_command(&directory);
        cmd.args(["restore", "--staged", "--"]);
        for f in &files {
            cmd.arg(f);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run git restore: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "git restore --staged failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// ---------------------------------------------------------------------------
// App config (external access toggle)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct AppConfig {
    #[serde(default)]
    external_access: bool,
}

fn app_config_path(s: &Arc<ServerState>) -> PathBuf {
    s.data_dir.join("app_config.json")
}

fn read_app_config(s: &Arc<ServerState>) -> AppConfig {
    let path = app_config_path(s);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Read the external_access setting directly from data_dir (usable before ServerState is created).
pub fn read_external_access(data_dir: &Path) -> bool {
    let path = data_dir.join("app_config.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<AppConfig>(&text).ok())
        .map(|c| c.external_access)
        .unwrap_or(false)
}

pub fn get_external_access(s: &Arc<ServerState>) -> Result<bool, String> {
    Ok(read_app_config(s).external_access)
}

pub fn set_external_access(enabled: bool, s: &Arc<ServerState>) -> Result<(), String> {
    let config = AppConfig { external_access: enabled };
    let path = app_config_path(s);
    let text = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Failed to write app config: {}", e))
}
