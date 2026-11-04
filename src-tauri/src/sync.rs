//! Periodically fetches every project with an `origin` remote and emits
//! `sync-status` so badges stay current.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use quilltex_core::{git, project, Workspace};

use crate::state::AppState;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub project: String,
    pub status: Option<git::RepoStatus>,
    pub error: Option<String>,
    pub checked_at: i64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn emit_status(app: &AppHandle, ws: &Workspace, project: &str, error: Option<String>) {
    let status = git::status(ws, project).ok();
    let _ = app.emit("sync-status", SyncStatus { project: project.into(), status, error, checked_at: now_ms() });
}

fn fetch_and_emit(app: &AppHandle, ws: &Workspace, name: &str) {
    let has_remote = git::status(ws, name).map(|s| s.remote_url.is_some()).unwrap_or(false);
    let error = if has_remote {
        git::fetch(ws, name).err().map(|e| e.to_string())
    } else {
        None
    };
    emit_status(app, ws, name, error);
}

pub fn check_one(app: AppHandle, ws: Workspace, project: String) {
    tauri::async_runtime::spawn_blocking(move || fetch_and_emit(&app, &ws, &project));
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let state = app.state::<AppState>();
            let interval = state.settings().sync_interval_secs.max(30);
            let ws = state.ws();
            let app2 = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                for p in project::list(&ws).unwrap_or_default().into_iter().filter(|p| p.has_git) {
                    fetch_and_emit(&app2, &ws, &p.name);
                }
            })
            .await;
            tokio::time::sleep(Duration::from_secs(interval)).await;
        }
    });
}
