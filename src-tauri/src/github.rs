//! GitHub through the user's own GitHub CLI (`gh`). QuillTex stores no token:
//! signing in runs `gh auth login --web`, which keeps it in gh's store.

use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use quilltex_core::{gh, git};

use crate::commands::CmdResult;
use crate::state::{AppState, GithubUser};

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    /// `gh` was found on this machine.
    installed: bool,
    user: Option<GithubUser>,
}

fn fetch_user() -> CmdResult<GithubUser> {
    let me = gh::api(&["user"]).map_err(err)?;
    let mut email = me["email"].as_str().unwrap_or_default().to_string();
    if email.is_empty() {
        // Needs the user:email scope; fine to skip without it.
        if let Ok(emails) = gh::api(&["user/emails"]) {
            email = emails
                .as_array()
                .and_then(|a| a.iter().find(|e| e["primary"].as_bool() == Some(true)))
                .and_then(|e| e["email"].as_str())
                .unwrap_or_default()
                .to_string();
        }
    }
    Ok(GithubUser {
        login: me["login"].as_str().unwrap_or_default().into(),
        name: me["name"].as_str().unwrap_or_default().into(),
        email,
        avatar_url: me["avatar_url"].as_str().unwrap_or_default().into(),
    })
}

fn cache_user(state: &AppState, user: Option<GithubUser>) -> CmdResult<()> {
    let mut s = state.settings();
    s.github_user = user;
    state.save_settings(s).map_err(err)
}

/// Whether gh is installed and who it is signed in as. Refreshes the cached
/// user in settings.
#[tauri::command]
pub async fn github_status(state: State<'_, AppState>) -> CmdResult<GithubStatus> {
    let (installed, user) = blocking(|| {
        let installed = gh::find().is_some();
        let user = if installed && gh::logged_in() { Some(fetch_user()?) } else { None };
        Ok((installed, user))
    })
    .await?;
    cache_user(&state, user.clone())?;
    Ok(GithubStatus { installed, user })
}

static LOGIN: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoginCode {
    user_code: String,
    verification_uri: String,
}

/// Runs `gh auth login --web`. Emits `github-login-code` once gh prints the
/// one-time code, then waits until the user approves it in the browser.
#[tauri::command]
pub async fn github_login(app: AppHandle, state: State<'_, AppState>) -> CmdResult<GithubUser> {
    let mut child = gh::command()
        .map_err(err)?
        .args(["auth", "login", "--web", "--hostname", gh::HOST, "--git-protocol", "https", "--skip-ssh-key", "--scopes", "user:email"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(err)?;
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    if let Some(mut old) = LOGIN.lock().unwrap().replace(child) {
        let _ = old.kill();
    }

    // gh prints the code and URL on stderr (stdout in some versions).
    let output = std::sync::Arc::new(Mutex::new(String::new()));
    let readers: Vec<Box<dyn std::io::Read + Send>> = [stdout.map(|s| Box::new(s) as _), stderr.map(|s| Box::new(s) as _)]
        .into_iter()
        .flatten()
        .collect();
    for r in readers {
        let (app, output) = (app.clone(), output.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(r).lines().map_while(Result::ok) {
                output.lock().unwrap().push_str(&line);
                output.lock().unwrap().push('\n');
                if let Some(user_code) = line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).find(|w| is_code(w)) {
                    let verification_uri = format!("https://{}/login/device", gh::HOST);
                    let _ = app.emit("github-login-code", LoginCode { user_code: user_code.into(), verification_uri });
                }
            }
        });
    }

    let ok = blocking(|| loop {
        std::thread::sleep(Duration::from_millis(300));
        let mut guard = LOGIN.lock().unwrap();
        let Some(child) = guard.as_mut() else { return Err("Sign-in was cancelled.".to_string()) };
        if let Some(status) = child.try_wait().map_err(err)? {
            guard.take();
            return Ok(status.success());
        }
    })
    .await?;
    if !ok {
        let text = output.lock().unwrap().clone();
        let last = text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("gh auth login failed");
        return Err(last.trim().to_string());
    }
    let user = blocking(fetch_user).await?;
    cache_user(&state, Some(user.clone()))?;
    Ok(user)
}

/// gh's one-time device codes look like `ABCD-1234`.
fn is_code(w: &str) -> bool {
    let b = w.as_bytes();
    b.len() == 9 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_uppercase() || c.is_ascii_digit())
}

#[tauri::command]
pub fn github_login_cancel() {
    if let Some(mut c) = LOGIN.lock().unwrap().take() {
        let _ = c.kill();
    }
}

/// Signs gh itself out of github.com (this affects the terminal too).
#[tauri::command]
pub async fn github_logout(state: State<'_, AppState>) -> CmdResult<()> {
    blocking(|| gh::run(&["auth", "logout", "--hostname", gh::HOST]).map_err(err)).await?;
    cache_user(&state, None)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    full_name: String,
    name: String,
    private: bool,
    clone_url: String,
    description: String,
    updated_at: String,
}

#[tauri::command]
pub async fn github_repos() -> CmdResult<Vec<Repo>> {
    let v: Value = blocking(|| {
        gh::api(&["user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member"]).map_err(err)
    })
    .await?;
    Ok(v.as_array()
        .map(|a| {
            a.iter()
                .map(|r| Repo {
                    full_name: r["full_name"].as_str().unwrap_or_default().into(),
                    name: r["name"].as_str().unwrap_or_default().into(),
                    private: r["private"].as_bool().unwrap_or(false),
                    clone_url: r["clone_url"].as_str().unwrap_or_default().into(),
                    description: r["description"].as_str().unwrap_or_default().into(),
                    updated_at: r["updated_at"].as_str().unwrap_or_default().into(),
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Create a GitHub repo for the project, set it as origin and push.
#[tauri::command]
pub async fn github_publish(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project: String,
    repo_name: String,
    private: bool,
) -> CmdResult<String> {
    let ws = state.ws();
    blocking(move || {
        let v = gh::api(&[
            "--method",
            "POST",
            "user/repos",
            "-f",
            &format!("name={repo_name}"),
            "-F",
            &format!("private={private}"),
            "-F",
            "auto_init=false",
        ])
        .map_err(err)?;
        let url = v["clone_url"].as_str().ok_or("GitHub did not return a clone URL")?.to_string();
        git::set_remote(&ws, &project, &url).map_err(err)?;
        let res = git::push(&ws, &project).map_err(err);
        crate::sync::emit_status(&app, &ws, &project, res.as_ref().err().cloned());
        res.map(|_| url)
    })
    .await
}
