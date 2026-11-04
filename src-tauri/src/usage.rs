//! Claude Code plan usage. The CLI reports each rate-limit window as a
//! utilization fraction (in its `rate_limit_event`) but never a token limit,
//! so the limit shown is estimated: tokens spent in the window / utilization.
//! Spent tokens come from Claude Code's own transcripts; the ones written by
//! QuillTex's chat (run from `chat-workspace`) are QuillTex's share.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::commands::CmdResult;
use crate::state::AppState;

const CACHE_FILE: &str = "usage.json";
const WINDOWS: [(&str, i64); 2] = [("five_hour", 5 * 3600), ("seven_day", 7 * 86400)];

#[derive(Serialize, Deserialize, Clone)]
pub struct Limit {
    kind: String,
    utilization: f64,
    #[serde(rename = "resetsAt")]
    resets_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowUsage {
    kind: String,
    /// 0..1 of the plan limit, as reported by Claude Code.
    utilization: f64,
    resets_at: i64,
    total_tokens: u64,
    quilltex_tokens: u64,
    /// Not reported by Claude Code; derived from `total_tokens / utilization`.
    estimated_limit: Option<u64>,
}

/// Pulls the per-window limits out of a stream-json `rate_limit_event`.
pub fn limits_from_event(event: &Value) -> Option<Vec<Limit>> {
    if event["type"] != "rate_limit_event" {
        return None;
    }
    let wins = event["rate_limit_info"]["unifiedWindows"].as_object()?;
    let limits: Vec<Limit> = WINDOWS
        .iter()
        .filter_map(|(kind, _)| {
            let w = wins.get(*kind)?;
            Some(Limit { kind: (*kind).into(), utilization: w["utilization"].as_f64()?, resets_at: w["resetsAt"].as_i64()? })
        })
        .collect();
    (!limits.is_empty()).then_some(limits)
}

pub fn remember(state: &AppState, event: &Value) {
    if let Some(limits) = limits_from_event(event) {
        let _ = std::fs::write(state.config_dir.join(CACHE_FILE), serde_json::to_string(&limits).unwrap_or_default());
    }
}

fn cached(state: &AppState) -> Option<Vec<Limit>> {
    let limits: Vec<Limit> = serde_json::from_str(&std::fs::read_to_string(state.config_dir.join(CACHE_FILE)).ok()?).ok()?;
    // A window that already reset says nothing about the current one.
    let now = chrono::Utc::now().timestamp();
    Some(limits.into_iter().filter(|l| l.resets_at > now).collect::<Vec<_>>()).filter(|l| !l.is_empty())
}

/// One tiny request, from a neutral folder and without a saved session, so
/// it neither counts as QuillTex's usage nor clutters the user's history.
fn probe(state: &AppState) -> CmdResult<Vec<Limit>> {
    let bin = crate::chat::claude_bin(state)?;
    let out = Command::new(bin)
        .args(["-p", "--output-format", "stream-json", "--verbose", "--model", "haiku"])
        .args(["--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--tools", ""])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .and_then(|mut child| {
            // Via stdin, so the variadic --tools flag can't swallow it.
            child.stdin.take().map(|mut i| i.write_all(b"hi"));
            child.wait_with_output()
        })
        .map_err(|e| e.to_string())?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find_map(|ev| limits_from_event(&ev))
        .ok_or_else(|| "Claude Code didn't report its usage limits. Make sure you're signed in with a Claude subscription.".into())
}

/// Claude Code names a project's transcript folder after its cwd, with every
/// non-alphanumeric character turned into `-`.
fn transcript_dir_name(cwd: &Path) -> String {
    cwd.display().to_string().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn jsonl_files(dir: &Path, since: std::time::SystemTime, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            jsonl_files(&p, since, out);
        } else if p.extension().is_some_and(|x| x == "jsonl") && e.metadata().and_then(|m| m.modified()).is_ok_and(|m| m >= since) {
            out.push(p);
        }
    }
}

/// Tokens that count towards the limit; cache reads are excluded as they are
/// cheap and would dwarf everything else.
fn billed(usage: &Value) -> u64 {
    ["input_tokens", "output_tokens", "cache_creation_input_tokens"].iter().filter_map(|k| usage[*k].as_u64()).sum()
}

/// (total, quilltex) tokens spent at or after `since`, de-duplicating the
/// repeated lines Claude Code writes for one streamed message.
fn spent(home: &Path, quilltex_dir: &str, since: i64) -> (u64, u64) {
    let cutoff = std::time::UNIX_EPOCH + std::time::Duration::from_secs(since.max(0) as u64);
    let mut files = Vec::new();
    jsonl_files(&home.join("projects"), cutoff, &mut files);
    let mut seen: HashMap<String, (u64, bool)> = HashMap::new();
    for f in files {
        let is_quilltex = f.strip_prefix(home.join("projects")).ok().and_then(|p| p.components().next()).is_some_and(|c| c.as_os_str() == quilltex_dir);
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        for line in text.lines() {
            if !line.contains("\"usage\"") {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            let Some(ts) = v["timestamp"].as_str().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()) else { continue };
            if ts.timestamp() < since {
                continue;
            }
            let key = format!("{}:{}", v["message"]["id"].as_str().unwrap_or(""), v["requestId"].as_str().unwrap_or(""));
            let n = billed(&v["message"]["usage"]);
            if key.len() > 1 {
                seen.insert(key, (n, is_quilltex));
            } else {
                seen.insert(format!("{}:{}", f.display(), v["uuid"]), (n, is_quilltex));
            }
        }
    }
    seen.values().fold((0, 0), |(t, f), (n, quilltex)| (t + n, f + if *quilltex { *n } else { 0 }))
}

fn compute(state: &AppState, limits: Vec<Limit>) -> CmdResult<Vec<WindowUsage>> {
    let home = dirs::home_dir().ok_or("no home directory")?.join(".claude");
    let cwd = state.config_dir.join("chat-workspace");
    let quilltex_dir = transcript_dir_name(&cwd.canonicalize().unwrap_or(cwd));
    Ok(limits
        .into_iter()
        .map(|l| {
            let secs = WINDOWS.iter().find(|(k, _)| *k == l.kind).map_or(0, |(_, s)| *s);
            let (total, quilltex) = spent(&home, &quilltex_dir, l.resets_at - secs);
            let estimated_limit = (l.utilization > 0.0 && total > 0).then(|| (total as f64 / l.utilization).round() as u64);
            WindowUsage { kind: l.kind, utilization: l.utilization, resets_at: l.resets_at, total_tokens: total, quilltex_tokens: quilltex, estimated_limit }
        })
        .collect())
}

/// `refresh` forces a new probe; otherwise the last limits seen (by the chat
/// or a previous probe) are used, and a probe only runs if there are none.
#[tauri::command]
pub async fn claude_usage(app: AppHandle, refresh: bool) -> CmdResult<Vec<WindowUsage>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let state = &*state;
        let limits = match (refresh, cached(state)) {
            (false, Some(l)) => l,
            _ => {
                let l = probe(state)?;
                let _ = std::fs::write(state.config_dir.join(CACHE_FILE), serde_json::to_string(&l).unwrap_or_default());
                l
            }
        };
        compute(state, limits)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_dir_matches_claude_code_naming() {
        let p = Path::new("/Users/x/Library/Application Support/dev.quilltex.app/chat-workspace");
        assert_eq!(transcript_dir_name(p), "-Users-x-Library-Application-Support-dev-quilltex-app-chat-workspace");
    }

    #[test]
    fn reads_limits_and_dedupes_streamed_lines() {
        let ev = serde_json::json!({"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{
            "five_hour":{"utilization":0.25,"resetsAt":100},"seven_day":{"utilization":0.5,"resetsAt":200}}}});
        assert_eq!(limits_from_event(&ev).unwrap().len(), 2);

        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects");
        std::fs::create_dir_all(proj.join("quilltex")).unwrap();
        std::fs::create_dir_all(proj.join("other")).unwrap();
        let line = |id: &str, out: u64| {
            format!(r#"{{"timestamp":"2030-01-01T00:00:00Z","requestId":"r{id}","message":{{"id":"m{id}","usage":{{"input_tokens":10,"output_tokens":{out},"cache_creation_input_tokens":0,"cache_read_input_tokens":999}}}}}}"#)
        };
        std::fs::write(proj.join("quilltex/a.jsonl"), format!("{}\n{}\n", line("1", 5), line("1", 20))).unwrap();
        std::fs::write(proj.join("other/b.jsonl"), line("2", 40) + "\n").unwrap();
        let (total, quilltex) = spent(tmp.path(), "quilltex", 0);
        assert_eq!((total, quilltex), (30 + 50, 30));
    }
}
