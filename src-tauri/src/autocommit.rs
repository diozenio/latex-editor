use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use quilltex_core::git;

use crate::openrouter::AiFailure;
use crate::state::AppState;

const DIFF_BUDGET: usize = 60_000;
const FILE_BUDGET: usize = 6_000;

const SYSTEM: &str = "You keep the version history of a writing project (a LaTeX or Markdown document) in QuillTex. \
Reply with JSON only, no prose and no code fences.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoCommit {
    id: String,
    message: String,
    files: Vec<String>,
}

/// One planned commit: the paths it records and its message.
#[derive(Debug, PartialEq)]
struct Group {
    files: Vec<String>,
    message: String,
}

fn prompt(changes: &str, language: &str) -> String {
    format!(
        "These are the uncommitted changes of the project:\n\n{changes}\n\n\
         Group the files into commits. Files changed for the same purpose go together; split into several commits only \
         when the changes clearly have different scopes (for example a new chapter, bibliography fixes and a replaced figure). \
         A file moved or renamed shows up as a deleted path plus a new one: keep both in the same commit. \
         Every file must appear in exactly one commit.\n\n\
         Write each message in {language}, as one natural sentence describing what changed in the document, the way someone \
         reading its history would want to see it (like \"Expand the methodology with the survey design\"). \
         No prefixes such as \"feat:\", no file extensions unless they help, no trailing period, at most 72 characters.\n\n\
         Answer with {{\"commits\":[{{\"files\":[\"path\"],\"message\":\"…\"}}]}}, in the order they should be committed."
    )
}

fn describe(ws: &quilltex_core::Workspace, project: &str, files: &[git::FileStatus]) -> String {
    let mut out = String::new();
    for f in files {
        let mut diff = match f.kind.as_str() {
            "deleted" => "(file deleted)".to_string(),
            _ => git::diff_file(ws, project, &f.path).unwrap_or_default(),
        };
        if diff.len() > FILE_BUDGET {
            let cut = (0..=FILE_BUDGET).rev().find(|i| diff.is_char_boundary(*i)).unwrap_or(0);
            diff.truncate(cut);
            diff.push_str("\n… (truncated)");
        }
        let header = match &f.orig_path {
            Some(o) => format!("### {} (renamed from {o})\n", f.path),
            None => format!("### {} ({})\n", f.path, f.kind),
        };
        if out.len() + header.len() + diff.len() > DIFF_BUDGET {
            out.push_str(&header);
            out.push_str("(diff omitted)\n\n");
        } else {
            out.push_str(&header);
            out.push_str(&diff);
            out.push_str("\n\n");
        }
    }
    out
}

/// Reads the model's plan and makes it safe: unknown paths are dropped, each file lands in exactly one
/// commit, and files the model forgot go into the last commit.
fn plan(reply: &str, files: &[String]) -> Option<Vec<Group>> {
    let start = reply.find('{')?;
    let end = reply.rfind('}')?;
    let v: Value = serde_json::from_str(reply.get(start..=end)?).ok()?;
    let mut taken: Vec<&String> = Vec::new();
    let mut groups: Vec<Group> = Vec::new();
    for c in v["commits"].as_array()? {
        let message = c["message"].as_str().unwrap_or_default().trim().trim_end_matches('.').to_string();
        let mine: Vec<String> = c["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|p| files.iter().find(|f| f.as_str() == p))
            .filter(|f| !taken.contains(f))
            .cloned()
            .collect();
        if message.is_empty() || mine.is_empty() {
            continue;
        }
        taken.extend(files.iter().filter(|f| mine.contains(f)));
        groups.push(Group { files: mine, message });
    }
    let rest: Vec<String> = files.iter().filter(|f| !taken.contains(f)).cloned().collect();
    groups.last_mut()?.files.extend(rest);
    Some(groups)
}

fn ask(state: &AppState, prompt: &str) -> Result<String, AiFailure> {
    if state.settings().ai_provider == "openrouter" {
        Ok(crate::openrouter::complete(state, SYSTEM, prompt)?)
    } else {
        Ok(crate::chat::claude_complete(state, SYSTEM, prompt)?)
    }
}

#[tauri::command]
pub async fn ai_auto_commit(app: AppHandle, project: String, language: String) -> Result<Vec<AutoCommit>, AiFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let ws = state.ws();
        let status = git::status(&ws, &project).map_err(|e| e.to_string())?;
        if status.merging || status.files.iter().any(|f| f.kind == "conflicted") {
            return Err("Finish the merge before committing.".into());
        }
        let staged: Vec<_> = status.files.iter().filter(|f| f.staged).cloned().collect();
        let changes = if staged.is_empty() { status.files.clone() } else { staged };
        if changes.is_empty() {
            return Err("There is nothing to commit.".into());
        }
        let paths: Vec<String> = changes.iter().map(|f| f.path.clone()).collect();
        let reply = ask(&state, &prompt(&describe(&ws, &project, &changes), &language))?;
        let groups = plan(&reply, &paths).ok_or("The AI did not return a usable commit plan. Try again.")?;

        let (name, email) = crate::commands::identity(&state, &project);
        let _ = git::set_identity_for(&ws, &project, &name, &email);
        let mut done = Vec::new();
        for g in groups {
            let mut paths = g.files.clone();
            paths.extend(changes.iter().filter(|f| g.files.contains(&f.path)).filter_map(|f| f.orig_path.clone()));
            if let Some(id) = git::commit_paths(&ws, &project, &paths, &g.message).map_err(|e| e.to_string())? {
                done.push(AutoCommit { id, message: g.message, files: g.files });
            }
        }
        crate::sync::emit_status(&app, &ws, &project, None);
        Ok(done)
    })
    .await
    .map_err(|e| AiFailure::from(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_keeps_every_file_exactly_once() {
        let files: Vec<String> = ["intro.tex", "refs.bib", "fig.png"].map(String::from).to_vec();
        let reply = r#"Sure! {"commits":[
            {"files":["intro.tex","ghost.tex"],"message":"Rewrite the introduction."},
            {"files":["intro.tex","refs.bib"],"message":"Fix two citations"},
            {"files":[],"message":"Empty"}]}"#;
        assert_eq!(
            plan(reply, &files).unwrap(),
            vec![
                Group { files: vec!["intro.tex".into()], message: "Rewrite the introduction".into() },
                Group { files: vec!["refs.bib".into(), "fig.png".into()], message: "Fix two citations".into() },
            ]
        );
        assert!(plan("no json here", &files).is_none());
        assert!(plan(r#"{"commits":[]}"#, &files).is_none());
    }
}
