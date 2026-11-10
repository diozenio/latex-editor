use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};

use quilltex_core::{
    archive, compile, files, gh, git, project,
    texlive,
    synctex::{PdfSpot, SourceSpot, SyncTex},
    templates,
};

use crate::state::{AppState, Settings};

pub type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    platform: String,
    projects_root: String,
    tectonic: bool,
    texlive: bool,
    texlive_bundled: bool,
    claude: Option<String>,
    gh_installed: bool,
    github_connected: bool,
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<AppState>) -> AppInfo {
    let tc = state.toolchain.read().unwrap().clone();
    let s = state.settings();
    AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.into(),
        projects_root: state.ws().root().display().to_string(),
        tectonic: tc.tectonic.is_some(),
        texlive: tc.texlive.as_deref().is_some_and(texlive::is_installed),
        texlive_bundled: tc.texlive_archive.is_some(),
        claude: crate::env::find_claude(&s.claude_path).map(|p| p.display().to_string()),
        gh_installed: gh::find().is_some(),
        github_connected: gh::logged_in(),
    }
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> CmdResult<Settings> {
    let old = state.settings();
    if old.projects_root != settings.projects_root {
        let ws = quilltex_core::Workspace::new(&settings.projects_root).map_err(err)?;
        *state.ws.write().unwrap() = ws;
        crate::watcher::restart(&app);
    }
    state.save_settings(settings.clone()).map_err(err)?;
    if old.projects_root != settings.projects_root && settings.mcp_registered {
        let _ = crate::chat::register_mcp(&state);
    }
    Ok(settings)
}

#[tauri::command]
pub fn set_menu_accelerators(
    app: AppHandle,
    accels: std::collections::HashMap<String, String>,
    labels: std::collections::HashMap<String, String>,
) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    crate::apply_menu_accelerators(&app, &accels, &labels).map_err(err)?;
    #[cfg(not(target_os = "macos"))]
    let _ = (app, accels, labels);
    Ok(())
}

#[tauri::command]
pub fn list_projects(state: State<AppState>) -> CmdResult<Vec<project::ProjectSummary>> {
    project::list(&state.ws()).map_err(err)
}

#[tauri::command]
pub fn list_templates() -> Vec<(&'static str, &'static str)> {
    templates::TEMPLATES.to_vec()
}

#[tauri::command]
pub fn unique_project_name(state: State<AppState>, base: String) -> String {
    project::unique_name(&state.ws(), &base)
}

#[tauri::command]
pub fn create_project(state: State<AppState>, name: String, template: String) -> CmdResult<project::ProjectSummary> {
    project::create(&state.ws(), name.trim(), &template).map_err(err)
}

#[tauri::command]
pub fn project_summary(state: State<AppState>, name: String) -> CmdResult<project::ProjectSummary> {
    let ws = state.ws();
    project::ensure_scaffold(&ws, &name).map_err(err)?;
    project::summary(&ws, &name).map_err(err)
}

#[tauri::command]
pub fn set_project_meta(state: State<AppState>, name: String, meta: project::ProjectMeta) -> CmdResult<()> {
    project::write_meta(&state.ws(), &name, &meta).map_err(err)
}

#[tauri::command]
pub fn rename_project(state: State<AppState>, from: String, to: String) -> CmdResult<project::ProjectSummary> {
    project::rename(&state.ws(), &from, to.trim()).map_err(err)
}

#[tauri::command]
pub fn duplicate_project(state: State<AppState>, from: String, to: String) -> CmdResult<project::ProjectSummary> {
    project::duplicate(&state.ws(), &from, to.trim()).map_err(err)
}

#[tauri::command]
pub fn delete_project(state: State<AppState>, name: String) -> CmdResult<()> {
    project::delete(&state.ws(), &name).map_err(err)
}

#[tauri::command]
pub fn project_path(state: State<AppState>, name: String, rel: Option<String>) -> CmdResult<String> {
    let ws = state.ws();
    let p = match rel {
        Some(r) if !r.is_empty() => ws.resolve(&name, &r).map_err(err)?,
        _ => ws.project_dir(&name).map_err(err)?,
    };
    Ok(p.display().to_string())
}

#[tauri::command]
pub async fn import_zip(state: State<'_, AppState>, zip_path: String, name: Option<String>) -> CmdResult<project::ProjectSummary> {
    let ws = state.ws();
    blocking(move || {
        let path = PathBuf::from(&zip_path);
        let name = name.unwrap_or_else(|| {
            project::unique_name(&ws, &path.file_stem().unwrap_or_default().to_string_lossy())
        });
        archive::import_zip(&ws, &path, &name).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn export_zip(state: State<'_, AppState>, name: String, dest: String, include_git: bool) -> CmdResult<()> {
    let ws = state.ws();
    blocking(move || archive::export_zip(&ws, &name, Path::new(&dest), include_git).map_err(err)).await
}

#[tauri::command]
pub fn file_tree(state: State<AppState>, project: String) -> CmdResult<Vec<files::FileNode>> {
    files::tree(&state.ws(), &project).map_err(err)
}

#[tauri::command]
pub fn read_text(state: State<AppState>, project: String, path: String) -> CmdResult<String> {
    files::read_text(&state.ws(), &project, &path).map_err(err)
}

#[tauri::command]
pub fn read_binary(state: State<AppState>, project: String, path: String) -> CmdResult<Response> {
    Ok(Response::new(files::read_bytes(&state.ws(), &project, &path).map_err(err)?))
}

#[tauri::command]
pub fn write_text(state: State<AppState>, project: String, path: String, content: String) -> CmdResult<()> {
    files::write_text(&state.ws(), &project, &path, &content).map_err(err)
}

#[tauri::command]
pub fn create_dir(state: State<AppState>, project: String, path: String) -> CmdResult<()> {
    files::create_dir(&state.ws(), &project, &path).map_err(err)
}

#[tauri::command]
pub fn rename_path(state: State<AppState>, project: String, from: String, to: String) -> CmdResult<()> {
    files::rename(&state.ws(), &project, &from, &to).map_err(err)
}

#[tauri::command]
pub fn delete_path(state: State<AppState>, project: String, path: String) -> CmdResult<()> {
    files::delete(&state.ws(), &project, &path).map_err(err)
}

#[tauri::command]
pub fn import_files(state: State<AppState>, project: String, paths: Vec<String>, dest_dir: String) -> CmdResult<Vec<String>> {
    let ws = state.ws();
    paths
        .iter()
        .map(|p| files::import_file(&ws, &project, Path::new(p), &dest_dir).map_err(err))
        .collect()
}

#[tauri::command]
pub async fn compile_project(app: AppHandle, state: State<'_, AppState>, project: String) -> CmdResult<compile::CompileResult> {
    let ws = state.ws();
    let tc = state.toolchain.read().unwrap().clone();
    blocking(move || {
        let status = |message: &str| {
            let _ = app.emit("compile-status", serde_json::json!({ "project": project, "message": message }));
        };
        compile::compile_with(&ws, &project, &tc, &status).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn install_texlive(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let tc = state.toolchain.read().unwrap().clone();
    let root = tc.texlive.ok_or("TeX Live is not available")?;
    blocking(move || {
        let status = |message: &str| {
            let _ = app.emit("texlive-status", message);
        };
        texlive::install(&root, tc.texlive_archive.as_deref(), &status).map_err(err)
    })
    .await
}

#[tauri::command]
pub fn relaunch_app(app: AppHandle) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().map_err(err)?;
        let bundle = exe.ancestors().nth(3).filter(|p| p.extension().is_some_and(|e| e == "app"));
        if let Some(bundle) = bundle {
            let script = format!(
                "while kill -0 {} 2>/dev/null; do sleep 0.1; done; open \"$1\"",
                std::process::id()
            );
            std::process::Command::new("/bin/sh")
                .args(["-c", &script, "sh"])
                .arg(bundle)
                .spawn()
                .map_err(err)?;
            app.exit(0);
            return Ok(());
        }
    }
    app.restart()
}

#[tauri::command]
pub async fn remove_texlive(state: State<'_, AppState>) -> CmdResult<()> {
    let root = state.toolchain.read().unwrap().texlive.clone().ok_or("TeX Live is not available")?;
    blocking(move || texlive::remove(&root).map_err(err)).await
}

#[tauri::command]
pub fn clean_build(state: State<AppState>, project: String) -> CmdResult<()> {
    compile::clean(&state.ws(), &project).map_err(err)
}

#[tauri::command]
pub fn save_pdf_as(state: State<AppState>, project: String, dest: String) -> CmdResult<()> {
    let pdf = compile::pdf_path(&state.ws(), &project).map_err(err)?.ok_or("compile the project first")?;
    std::fs::copy(pdf, dest).map_err(err)?;
    Ok(())
}

fn synctex_for(state: &AppState, project: &str) -> CmdResult<SyncTex> {
    let ws = state.ws();
    let meta = project::read_meta(&ws, project).map_err(err)?;
    let stem = Path::new(&meta.main_file).file_stem().unwrap_or_default().to_string_lossy().to_string();
    let dir = ws.project_dir(project).map_err(err)?;
    SyncTex::load(&dir.join(project::BUILD_DIR).join(format!("{stem}.synctex.gz")), &dir).map_err(err)
}

#[tauri::command]
pub fn synctex_forward(state: State<AppState>, project: String, file: String, line: u32) -> CmdResult<Vec<PdfSpot>> {
    Ok(synctex_for(&state, &project)?.forward(&file, line))
}

#[tauri::command]
pub fn synctex_inverse(state: State<AppState>, project: String, page: u32, x: f64, y: f64) -> CmdResult<Option<SourceSpot>> {
    Ok(synctex_for(&state, &project)?.inverse(page, x, y))
}

pub(crate) fn identity(state: &AppState, project: &str) -> (String, String) {
    let s = state.settings();
    let (cfg_name, cfg_email) = git::configured_identity(&state.ws(), project);
    let gh = s.github_user.unwrap_or_default();
    let name = if !s.git_name.is_empty() {
        s.git_name
    } else if cfg_name.is_some() {
        String::new()
    } else if !gh.name.is_empty() {
        gh.name
    } else {
        gh.login.clone()
    };
    let email = if !s.git_email.is_empty() {
        s.git_email
    } else if cfg_email.is_some() {
        String::new()
    } else if !gh.email.is_empty() {
        gh.email
    } else if !gh.login.is_empty() {
        format!("{}@users.noreply.github.com", gh.login)
    } else {
        String::new()
    };
    (name, email)
}

#[tauri::command]
pub fn git_status(state: State<AppState>, project: String) -> CmdResult<git::RepoStatus> {
    git::status(&state.ws(), &project).map_err(err)
}

#[tauri::command]
pub fn git_init(state: State<AppState>, project: String) -> CmdResult<()> {
    let ws = state.ws();
    project::ensure_scaffold(&ws, &project).map_err(err)?;
    let (name, email) = identity(&state, &project);
    git::init(&ws, &project, &name, &email).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn git_stage(state: State<AppState>, project: String, paths: Vec<String>) -> CmdResult<()> {
    git::stage(&state.ws(), &project, &paths).map_err(err)
}

#[tauri::command]
pub fn git_stage_all(state: State<AppState>, project: String) -> CmdResult<()> {
    git::stage_all(&state.ws(), &project).map_err(err)
}

#[tauri::command]
pub fn git_unstage(state: State<AppState>, project: String, paths: Vec<String>) -> CmdResult<()> {
    git::unstage(&state.ws(), &project, &paths).map_err(err)
}

#[tauri::command]
pub fn git_discard(state: State<AppState>, project: String, paths: Vec<String>) -> CmdResult<()> {
    git::discard(&state.ws(), &project, &paths).map_err(err)
}

#[tauri::command]
pub fn git_commit(app: AppHandle, state: State<AppState>, project: String, message: String) -> CmdResult<String> {
    let ws = state.ws();
    let (name, email) = identity(&state, &project);
    let _ = git::set_identity_for(&ws, &project, &name, &email);
    let id = git::commit(&ws, &project, &message).map_err(err)?;
    crate::sync::emit_status(&app, &ws, &project, None);
    Ok(id)
}

#[tauri::command]
pub fn git_log(state: State<AppState>, project: String) -> CmdResult<Vec<git::Commit>> {
    git::log(&state.ws(), &project, 100).map_err(err)
}

#[tauri::command]
pub fn git_commit_paths(app: AppHandle, state: State<AppState>, project: String, paths: Vec<String>, message: String) -> CmdResult<Option<String>> {
    let ws = state.ws();
    let (name, email) = identity(&state, &project);
    let _ = git::set_identity_for(&ws, &project, &name, &email);
    let id = git::commit_paths(&ws, &project, &paths, &message).map_err(err)?;
    if id.is_some() {
        crate::sync::emit_status(&app, &ws, &project, None);
    }
    Ok(id)
}

#[tauri::command]
pub fn git_commit_files(state: State<AppState>, project: String, id: String) -> CmdResult<Vec<git::CommitFile>> {
    git::commit_files(&state.ws(), &project, &id).map_err(err)
}

#[tauri::command]
pub fn git_commit_diff(state: State<AppState>, project: String, id: String, path: String) -> CmdResult<String> {
    git::commit_diff(&state.ws(), &project, &id, &path).map_err(err)
}

#[tauri::command]
pub fn git_restore_version(app: AppHandle, state: State<AppState>, project: String, id: String) -> CmdResult<String> {
    let ws = state.ws();
    let (name, email) = identity(&state, &project);
    let _ = git::set_identity_for(&ws, &project, &name, &email);
    let out = git::restore_version(&ws, &project, &id).map_err(err)?;
    crate::sync::emit_status(&app, &ws, &project, None);
    Ok(out)
}

#[tauri::command]
pub fn git_revert_commit(app: AppHandle, state: State<AppState>, project: String, id: String) -> CmdResult<String> {
    let ws = state.ws();
    let (name, email) = identity(&state, &project);
    let _ = git::set_identity_for(&ws, &project, &name, &email);
    let out = git::revert_commit(&ws, &project, &id).map_err(err)?;
    crate::sync::emit_status(&app, &ws, &project, None);
    Ok(out)
}

#[tauri::command]
pub fn git_reset_to(app: AppHandle, state: State<AppState>, project: String, id: String) -> CmdResult<()> {
    let ws = state.ws();
    git::reset_to(&ws, &project, &id).map_err(err)?;
    crate::sync::emit_status(&app, &ws, &project, None);
    Ok(())
}

#[tauri::command]
pub fn git_delete_commit(app: AppHandle, state: State<AppState>, project: String, id: String) -> CmdResult<()> {
    let ws = state.ws();
    git::delete_commit(&ws, &project, &id).map_err(err)?;
    crate::sync::emit_status(&app, &ws, &project, None);
    Ok(())
}

#[tauri::command]
pub fn git_diff(state: State<AppState>, project: String, path: String) -> CmdResult<String> {
    git::diff_file(&state.ws(), &project, &path).map_err(err)
}

#[tauri::command]
pub fn git_branches(state: State<AppState>, project: String) -> CmdResult<Vec<git::Branch>> {
    git::branches(&state.ws(), &project).map_err(err)
}

#[tauri::command]
pub fn git_create_branch(state: State<AppState>, project: String, name: String) -> CmdResult<()> {
    git::create_branch(&state.ws(), &project, name.trim(), true).map_err(err)
}

#[tauri::command]
pub fn git_checkout(app: AppHandle, state: State<AppState>, project: String, name: String) -> CmdResult<()> {
    let ws = state.ws();
    git::checkout_branch(&ws, &project, &name).map_err(err)?;
    crate::sync::emit_status(&app, &ws, &project, None);
    Ok(())
}

#[tauri::command]
pub fn git_delete_branch(state: State<AppState>, project: String, name: String) -> CmdResult<()> {
    git::delete_branch(&state.ws(), &project, &name).map_err(err)
}

#[tauri::command]
pub fn git_merge(app: AppHandle, state: State<AppState>, project: String, from: String) -> CmdResult<git::MergeOutcome> {
    let ws = state.ws();
    let out = git::merge(&ws, &project, &from).map_err(err)?;
    crate::sync::emit_status(&app, &ws, &project, None);
    Ok(out)
}

#[tauri::command]
pub fn git_resolve(state: State<AppState>, project: String, path: String) -> CmdResult<()> {
    git::resolve(&state.ws(), &project, &path).map_err(err)
}

#[tauri::command]
pub fn git_abort_merge(state: State<AppState>, project: String) -> CmdResult<()> {
    git::abort_merge(&state.ws(), &project).map_err(err)
}

#[tauri::command]
pub fn git_set_remote(state: State<AppState>, project: String, url: String) -> CmdResult<()> {
    git::set_remote(&state.ws(), &project, url.trim()).map_err(err)
}

#[tauri::command]
pub async fn git_fetch(app: AppHandle, state: State<'_, AppState>, project: String) -> CmdResult<git::RepoStatus> {
    let ws = state.ws();
    blocking(move || {
        let res = git::fetch(&ws, &project);
        let e = res.as_ref().err().map(|e| e.to_string());
        crate::sync::emit_status(&app, &ws, &project, e.clone());
        res.map_err(err)?;
        git::status(&ws, &project).map_err(err)
    })
    .await
}

#[tauri::command]
pub async fn git_pull(app: AppHandle, state: State<'_, AppState>, project: String) -> CmdResult<git::MergeOutcome> {
    let ws = state.ws();
    blocking(move || {
        let out = git::pull(&ws, &project).map_err(err);
        crate::sync::emit_status(&app, &ws, &project, out.as_ref().err().cloned());
        out
    })
    .await
}

#[tauri::command]
pub async fn git_push(app: AppHandle, state: State<'_, AppState>, project: String) -> CmdResult<()> {
    let ws = state.ws();
    blocking(move || {
        let out = git::push(&ws, &project).map_err(err);
        crate::sync::emit_status(&app, &ws, &project, out.as_ref().err().cloned());
        out
    })
    .await
}

#[tauri::command]
pub async fn git_clone(app: AppHandle, state: State<'_, AppState>, url: String, name: String) -> CmdResult<project::ProjectSummary> {
    let ws = state.ws();
    blocking(move || {
        git::clone(&ws, url.trim(), name.trim()).map_err(err)?;
        let (uname, email) = identity(&app.state::<AppState>(), name.trim());
        let _ = git::set_identity_for(&ws, name.trim(), &uname, &email);
        project::ensure_scaffold(&ws, name.trim()).map_err(err)?;
        project::summary(&ws, name.trim()).map_err(err)
    })
    .await
}

#[tauri::command]
pub fn sync_now(app: AppHandle, state: State<AppState>, project: String) {
    crate::sync::check_one(app, state.ws(), project);
}

#[tauri::command]
pub fn uninstall(app: AppHandle, state: State<AppState>, delete_projects: bool) -> CmdResult<String> {
    crate::uninstall::run(&app, &state, delete_projects).map_err(err)
}
