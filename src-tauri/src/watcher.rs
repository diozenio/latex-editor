//! Watches the projects folder so edits made outside the app (Finder, git,
//! Claude via MCP) show up live. Emits `fs-changed` { project, paths }.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

#[derive(Default)]
pub struct WatcherHolder(Mutex<Option<notify::RecommendedWatcher>>);

#[derive(Serialize, Clone)]
struct FsChanged {
    project: String,
    paths: Vec<String>,
}

pub fn restart(app: &AppHandle) {
    let holder = app.state::<WatcherHolder>();
    let mut slot = holder.0.lock().unwrap();
    *slot = None; // drop the old watcher first
    let root = app.state::<AppState>().ws().root().to_path_buf();

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let Ok(mut watcher) = notify::recommended_watcher(tx) else { return };
    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
        return;
    }
    *slot = Some(watcher);

    let app = app.clone();
    std::thread::spawn(move || {
        // Batch bursts (saves, checkouts) into one event per project.
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            while let Ok(ev) = rx.recv_timeout(Duration::from_millis(150)) {
                batch.push(ev);
            }
            let mut by_project: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
            for ev in batch.into_iter().flatten() {
                for path in ev.paths {
                    let Ok(rel) = path.strip_prefix(&root) else { continue };
                    let mut comps = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string());
                    let Some(project) = comps.next() else { continue };
                    let rest: Vec<String> = comps.collect();
                    let rel_path = rest.join("/");
                    let internal = rel_path.starts_with(".git/")
                        || rel_path.starts_with(".quilltex/build")
                        || rel_path.ends_with(".quilltex-tmp");
                    // Git ref changes matter for the sync badge; mark them specially.
                    if rel_path.starts_with(".git/") {
                        if rel_path == ".git/HEAD" || rel_path.starts_with(".git/refs") || rel_path == ".git/index" {
                            by_project.entry(project).or_default().insert(".git".into());
                        }
                        continue;
                    }
                    if !internal {
                        by_project.entry(project).or_default().insert(rel_path);
                    }
                }
            }
            for (project, paths) in by_project {
                let _ = app.emit("fs-changed", FsChanged { project, paths: paths.into_iter().collect() });
            }
        }
    });
}
