mod chat;
mod commands;
mod env;
mod github;
mod state;
mod storage;
mod sync;
mod uninstall;
mod usage;
mod watcher;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_menu(
    app: &tauri::AppHandle,
    accels: &std::collections::HashMap<String, String>,
    labels: &std::collections::HashMap<String, String>,
) -> tauri::Result<Menu<tauri::Wry>> {
    let l = |id: &str, default: &'static str| -> String { labels.get(id).cloned().unwrap_or_else(|| default.to_string()) };
    let item = |id: &str, default: &'static str, accel: Option<String>| MenuItem::with_id(app, id, l(&format!("menu.{id}"), default), true, accel);
    let acc = |id: &str, default: &str| -> Option<String> {
        match accels.get(id) {
            Some(v) if v.is_empty() => None,
            Some(v) => Some(v.clone()),
            None => Some(default.to_string()),
        }
    };
    let app_menu = Submenu::with_items(app, l("menu.app", "QuillTex"), true, &[
        &PredefinedMenuItem::about(app, Some(&l("menu.about", "About QuillTex")), Some(AboutMetadata::default()))?,
        &PredefinedMenuItem::separator(app)?,
        &item("settings", "Settings…", acc("settings", "CmdOrCtrl+,"))?,
        &PredefinedMenuItem::separator(app)?,
        &item("storage", "Storage…", None)?,
        &item("uninstall", "Uninstall QuillTex…", None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, Some(&l("menu.hide", "Hide QuillTex")))?,
        &PredefinedMenuItem::hide_others(app, Some(&l("menu.hideOthers", "Hide Others")))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::quit(app, Some(&l("menu.quit", "Quit QuillTex")))?,
    ])?;
    let file = Submenu::with_items(app, l("menu.file", "File"), true, &[
        &item("new-project", "New Project…", acc("new-project", "CmdOrCtrl+Shift+N"))?,
        &item("import-zip", "Import ZIP…", acc("import-zip", "CmdOrCtrl+Shift+O"))?,
        &item("clone-repo", "Clone from GitHub…", None)?,
        &PredefinedMenuItem::separator(app)?,
        &item("new-file", "New File", acc("new-file", "CmdOrCtrl+N"))?,
        &item("save", "Save", acc("save", "CmdOrCtrl+S"))?,
        &PredefinedMenuItem::separator(app)?,
        &item("export-zip", "Export as ZIP…", None)?,
        &item("download-pdf", "Download PDF…", acc("download-pdf", "CmdOrCtrl+Shift+S"))?,
        &PredefinedMenuItem::separator(app)?,
        &item("close-file", "Close File", acc("close-file", "CmdOrCtrl+W"))?,
    ])?;
    let edit = Submenu::with_items(app, l("menu.edit", "Edit"), true, &[
        &PredefinedMenuItem::undo(app, Some(&l("menu.undo", "Undo")))?,
        &PredefinedMenuItem::redo(app, Some(&l("menu.redo", "Redo")))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::cut(app, Some(&l("menu.cut", "Cut")))?,
        &PredefinedMenuItem::copy(app, Some(&l("menu.copy", "Copy")))?,
        &PredefinedMenuItem::paste(app, Some(&l("menu.paste", "Paste")))?,
        &PredefinedMenuItem::select_all(app, Some(&l("menu.selectAll", "Select All")))?,
    ])?;
    let view = Submenu::with_items(app, l("menu.view", "View"), true, &[
        &item("command-palette", "Command Palette", acc("command-palette", "CmdOrCtrl+K"))?,
        &item("toggle-sidebar", "Toggle Sidebar", acc("toggle-sidebar", "CmdOrCtrl+B"))?,
        &item("toggle-pdf", "Toggle PDF", acc("toggle-pdf", "CmdOrCtrl+Shift+P"))?,
        &item("toggle-chat", "Toggle AI Assistant", acc("toggle-chat", "CmdOrCtrl+J"))?,
        &item("toggle-git", "Source Control", acc("toggle-git", "CmdOrCtrl+Shift+G"))?,
        &PredefinedMenuItem::separator(app)?,
        &item("compile", "Compile", acc("compile", "CmdOrCtrl+Enter"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::fullscreen(app, Some(&l("menu.fullscreen", "Enter Full Screen")))?,
    ])?;
    let window = Submenu::with_items(app, l("menu.window", "Window"), true, &[
        &PredefinedMenuItem::minimize(app, Some(&l("menu.minimize", "Minimize")))?,
        &PredefinedMenuItem::maximize(app, Some(&l("menu.maximize", "Zoom")))?,
    ])?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

fn prepare_engines(app: &tauri::AppHandle) {
    let state = app.state::<state::AppState>();
    let tc = state.toolchain.read().unwrap().clone();
    let seed = state.tectonic_seed.clone();
    std::thread::spawn(move || {
        if let (Some(seed), Some(cache)) = (seed, &tc.tectonic_cache) {
            if let Err(e) = quilltex_core::compile::seed_tectonic_cache(&seed, cache) {
                eprintln!("quilltex: could not seed the Tectonic cache: {e}");
            }
        }
        if let (Some(root), Some(archive)) = (&tc.texlive, &tc.texlive_archive) {
            if !quilltex_core::texlive::is_installed(root) && !quilltex_core::texlive::was_removed(root) {
                if let Err(e) = quilltex_core::texlive::install(root, Some(archive), &|_| {}) {
                    eprintln!("quilltex: could not set up TeX Live: {e}");
                }
            }
        }
    });
}

#[cfg(target_os = "macos")]
pub fn apply_menu_accelerators(
    app: &tauri::AppHandle,
    accels: &std::collections::HashMap<String, String>,
    labels: &std::collections::HashMap<String, String>,
) -> tauri::Result<()> {
    app.set_menu(build_menu(app, accels, labels)?)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env::fix_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(watcher::WatcherHolder::default())
        .manage(chat::ChatProcesses::default())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(state::AppState::init(&handle)?);
            #[cfg(target_os = "macos")]
            app.set_menu(build_menu(&handle, &Default::default(), &Default::default())?)?;
            app.on_menu_event(|app, event| {
                let _ = app.emit("menu", event.id().as_ref());
            });

            let window = app.get_webview_window("main").unwrap();
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                let _ = apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, Some(NSVisualEffectState::FollowsWindowActiveState), Some(12.0));
            }
            #[cfg(windows)]
            {
                if window_vibrancy::apply_mica(&window, None).is_err() {
                    let _ = window_vibrancy::apply_acrylic(&window, Some((18, 18, 18, 125)));
                }
            }
            if let Ok(Some(monitor)) = window.current_monitor() {
                let area = monitor.work_area();
                let _ = window.set_position(tauri::PhysicalPosition::new(area.position.x, area.position.y));
                let _ = window.set_size(tauri::PhysicalSize::new(area.size.width, area.size.height));
            }

            watcher::restart(&handle);
            prepare_engines(&handle);
            sync::start(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::save_settings,
            commands::set_menu_accelerators,
            commands::list_projects,
            commands::list_templates,
            commands::unique_project_name,
            commands::create_project,
            commands::project_summary,
            commands::set_project_meta,
            commands::rename_project,
            commands::duplicate_project,
            commands::delete_project,
            commands::project_path,
            commands::import_zip,
            commands::export_zip,
            commands::file_tree,
            commands::read_text,
            commands::read_binary,
            commands::write_text,
            commands::create_dir,
            commands::rename_path,
            commands::delete_path,
            commands::import_files,
            commands::compile_project,
            commands::install_texlive,
            commands::remove_texlive,
            commands::relaunch_app,
            commands::clean_build,
            commands::save_pdf_as,
            commands::synctex_forward,
            commands::synctex_inverse,
            commands::git_status,
            commands::git_init,
            commands::git_stage,
            commands::git_stage_all,
            commands::git_unstage,
            commands::git_discard,
            commands::git_commit,
            commands::git_commit_paths,
            commands::git_log,
            commands::git_diff,
            commands::git_commit_files,
            commands::git_commit_diff,
            commands::git_restore_version,
            commands::git_revert_commit,
            commands::git_reset_to,
            commands::git_delete_commit,
            commands::git_branches,
            commands::git_create_branch,
            commands::git_checkout,
            commands::git_delete_branch,
            commands::git_merge,
            commands::git_resolve,
            commands::git_abort_merge,
            commands::git_set_remote,
            commands::git_fetch,
            commands::git_pull,
            commands::git_push,
            commands::git_clone,
            commands::sync_now,
            commands::uninstall,
            github::github_status,
            github::github_login,
            github::github_login_cancel,
            github::github_logout,
            github::github_repos,
            github::github_publish,
            chat::chat_send,
            chat::chat_cancel,
            chat::chat_load,
            chat::chat_save,
            usage::claude_usage,
            storage::storage_usage,
            storage::installed_components,
            storage::clear_tectonic_cache,
            storage::remove_tex_package,
            chat::mcp_register,
            chat::mcp_unregister,
        ])
        .run(tauri::generate_context!())
        .expect("error while running QuillTex");
}
