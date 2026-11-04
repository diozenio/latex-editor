//! In-app uninstall (macOS/Linux; Windows uses the NSIS uninstaller, which
//! we launch). Removes everything Folio created outside the projects
//! folder, and the projects too if asked. GitHub sign-in belongs to the
//! user's GitHub CLI and is left alone.

use tauri::{AppHandle, Manager};

use crate::state::AppState;

pub fn run(app: &AppHandle, state: &AppState, delete_projects: bool) -> anyhow::Result<String> {
    if state.settings().mcp_registered {
        let _ = crate::chat::unregister_mcp(state);
    }

    #[cfg(windows)]
    {
        // Hand over to the NSIS uninstaller (it has its own checkboxes).
        let uninstaller = state.bin_dir.join("uninstall.exe");
        if uninstaller.is_file() {
            std::process::Command::new(uninstaller).spawn()?;
            app.exit(0);
            return Ok("Launching uninstaller".into());
        }
    }

    if delete_projects {
        let root = state.ws().root().to_path_buf();
        if root.exists() {
            folio_core::trash::delete(&root).map_err(|e| anyhow::anyhow!(e.to_string()))?;
        }
    }
    let paths = app.path();
    for dir in [paths.app_config_dir(), paths.app_cache_dir(), paths.app_data_dir(), paths.app_local_data_dir(), paths.app_log_dir()]
        .into_iter()
        .flatten()
    {
        let _ = std::fs::remove_dir_all(dir);
    }
    // WebView storage on macOS lives under ~/Library/WebKit/<identifier>.
    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        let id = &app.config().identifier;
        let _ = std::fs::remove_dir_all(home.join("Library/WebKit").join(id));
        let _ = std::fs::remove_dir_all(home.join("Library/Caches").join(id));
        let _ = std::fs::remove_file(home.join("Library/Preferences").join(format!("{id}.plist")));
        let _ = std::fs::remove_dir_all(home.join("Library/Saved Application State").join(format!("{id}.savedState")));
    }

    #[cfg(target_os = "macos")]
    {
        // .../Folio.app/Contents/MacOS/folio → move Folio.app to the Trash.
        let exe = std::env::current_exe()?;
        if let Some(bundle) = exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")) {
            folio_core::trash::delete(bundle).map_err(|e| anyhow::anyhow!(e.to_string()))?;
        }
        app.exit(0);
        return Ok("Folio was moved to the Trash".into());
    }

    #[allow(unreachable_code)]
    Ok("App data removed. Finish by removing the package, e.g. `sudo apt remove folio` or deleting the AppImage.".into())
}
