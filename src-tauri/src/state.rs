use std::path::PathBuf;
use std::sync::{Mutex, RwLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use folio_core::{compile::Toolchain, Workspace};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GithubUser {
    pub login: String,
    pub name: String,
    pub email: String,
    pub avatar_url: String,
}

impl Default for GithubUser {
    fn default() -> Self {
        Self { login: String::new(), name: String::new(), email: String::new(), avatar_url: String::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub projects_root: String,
    /// Cached from `gh api user`; gh owns the actual sign-in.
    pub github_user: Option<GithubUser>,
    pub git_name: String,
    pub git_email: String,
    pub sync_interval_secs: u64,
    pub mcp_registered: bool,
    /// Optional override for the `claude` executable.
    pub claude_path: String,
    pub editor_font_size: u32,
    pub theme: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            projects_root: Workspace::default_root().display().to_string(),
            github_user: None,
            git_name: String::new(),
            git_email: String::new(),
            sync_interval_secs: 120,
            mcp_registered: false,
            claude_path: String::new(),
            editor_font_size: 13,
            theme: "system".into(),
        }
    }
}

pub struct AppState {
    pub ws: RwLock<Workspace>,
    pub settings: Mutex<Settings>,
    pub config_dir: PathBuf,
    pub toolchain: RwLock<Toolchain>,
    /// Directory holding the bundled sidecars (next to the main executable).
    pub bin_dir: PathBuf,
}

impl AppState {
    pub fn init(app: &AppHandle) -> anyhow::Result<Self> {
        let config_dir = app.path().app_config_dir()?;
        let cache_dir = app.path().app_cache_dir()?;
        std::fs::create_dir_all(&config_dir)?;
        std::fs::create_dir_all(&cache_dir)?;
        let settings: Settings = std::fs::read_to_string(config_dir.join("settings.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let ws = Workspace::new(&settings.projects_root)?;
        let bin_dir = std::env::current_exe()?.parent().unwrap().to_path_buf();
        let toolchain = Toolchain {
            tectonic: Some(bin_dir.join(exe("tectonic"))).filter(|p| p.is_file()),
            tectonic_cache: Some(cache_dir.join("tectonic")),
            system_tex_bin: folio_core::compile::detect_system_tex(),
        };
        Ok(Self {
            ws: RwLock::new(ws),
            settings: Mutex::new(settings),
            config_dir,
            toolchain: RwLock::new(toolchain),
            bin_dir,
        })
    }

    pub fn ws(&self) -> Workspace {
        self.ws.read().unwrap().clone()
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn save_settings(&self, s: Settings) -> anyhow::Result<()> {
        std::fs::write(self.config_dir.join("settings.json"), serde_json::to_string_pretty(&s)?)?;
        *self.settings.lock().unwrap() = s;
        Ok(())
    }

    pub fn mcp_binary(&self) -> PathBuf {
        self.bin_dir.join(exe("folio-mcp"))
    }

    /// Arguments for launching folio-mcp against the current workspace.
    pub fn mcp_args(&self) -> Vec<String> {
        let tc = self.toolchain.read().unwrap();
        let mut args = vec!["--root".into(), self.ws().root().display().to_string()];
        if let Some(t) = &tc.tectonic {
            args.extend(["--tectonic".into(), t.display().to_string()]);
        }
        if let Some(c) = &tc.tectonic_cache {
            args.extend(["--tectonic-cache".into(), c.display().to_string()]);
        }
        args
    }
}

pub fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}
