mod chat;
mod commands;
mod env;
mod github;
mod state;
mod sync;
mod uninstall;
mod usage;
mod watcher;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let item = |id: &str, label: &str, accel: Option<&str>| MenuItem::with_id(app, id, label, true, accel);
    let app_menu = Submenu::with_items(app, "Folio", true, &[
        &PredefinedMenuItem::about(app, Some("About Folio"), Some(AboutMetadata::default()))?,
        &PredefinedMenuItem::separator(app)?,
        &item("settings", "Settings…", Some("CmdOrCtrl+,"))?,
        &PredefinedMenuItem::separator(app)?,
        &item("uninstall", "Uninstall Folio…", None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::hide(app, None)?,
        &PredefinedMenuItem::hide_others(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::quit(app, None)?,
    ])?;
    let file = Submenu::with_items(app, "File", true, &[
        &item("new-project", "New Project…", Some("CmdOrCtrl+Shift+N"))?,
        &item("import-zip", "Import ZIP…", Some("CmdOrCtrl+Shift+O"))?,
        &item("clone-repo", "Clone from GitHub…", None)?,
        &PredefinedMenuItem::separator(app)?,
        &item("new-file", "New File", Some("CmdOrCtrl+N"))?,
        &item("save", "Save", Some("CmdOrCtrl+S"))?,
        &PredefinedMenuItem::separator(app)?,
        &item("export-zip", "Export as ZIP…", None)?,
        &item("download-pdf", "Download PDF…", Some("CmdOrCtrl+Shift+S"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::close_window(app, None)?,
    ])?;
    let edit = Submenu::with_items(app, "Edit", true, &[
        &PredefinedMenuItem::undo(app, None)?,
        &PredefinedMenuItem::redo(app, None)?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
        &PredefinedMenuItem::select_all(app, None)?,
    ])?;
    let view = Submenu::with_items(app, "View", true, &[
        &item("command-palette", "Command Palette", Some("CmdOrCtrl+K"))?,
        &item("toggle-sidebar", "Toggle Sidebar", Some("CmdOrCtrl+B"))?,
        &item("toggle-pdf", "Toggle PDF", Some("CmdOrCtrl+Shift+P"))?,
        &item("toggle-chat", "Toggle AI Assistant", Some("CmdOrCtrl+J"))?,
        &item("toggle-git", "Source Control", Some("CmdOrCtrl+Shift+G"))?,
        &PredefinedMenuItem::separator(app)?,
        &item("compile", "Compile", Some("CmdOrCtrl+Enter"))?,
        &PredefinedMenuItem::separator(app)?,
        &PredefinedMenuItem::fullscreen(app, None)?,
    ])?;
    let window = Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::maximize(app, None)?,
    ])?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env::fix_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(watcher::WatcherHolder::default())
        .manage(chat::ChatProcesses::default())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(state::AppState::init(&handle)?);
            // A menu bar inside the window looks foreign on Windows/Linux; the
            // frontend handles shortcuts there instead.
            #[cfg(target_os = "macos")]
            app.set_menu(build_menu(&handle)?)?;
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
            // Fill the monitor's work area (below the menu bar, clear of the Dock)
            // explicitly: `maximized` in the config leaves the window offset.
            if let Ok(Some(monitor)) = window.current_monitor() {
                let area = monitor.work_area();
                let _ = window.set_position(tauri::PhysicalPosition::new(area.position.x, area.position.y));
                let _ = window.set_size(tauri::PhysicalSize::new(area.size.width, area.size.height));
            }

            watcher::restart(&handle);
            sync::start(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::save_settings,
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
            chat::mcp_register,
            chat::mcp_unregister,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Folio");
}
