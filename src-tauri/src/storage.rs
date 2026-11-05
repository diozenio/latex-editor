use std::path::{Path, PathBuf};

use serde::Serialize;
use quilltex_core::texlive::{self, InstalledPackage};
use tauri::{AppHandle, Manager, State};

use crate::commands::CmdResult;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub projects: u64,
    pub engine: u64,
    pub system: u64,
    pub total: u64,
}

fn size_of(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| size_of(&e.path())).sum())
        .unwrap_or(0)
}

fn dedup(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for p in paths {
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

fn measure(projects: PathBuf, engine: Vec<PathBuf>, system: Vec<PathBuf>) -> StorageUsage {
    let engine = dedup(engine);
    let engine_sizes: Vec<(PathBuf, u64)> = engine.into_iter().map(|p| { let n = size_of(&p); (p, n) }).collect();
    let engine_total = engine_sizes.iter().map(|(_, n)| n).sum::<u64>();
    let system_total = dedup(system)
        .iter()
        .map(|root| {
            let inside: u64 = engine_sizes.iter().filter(|(p, _)| p.starts_with(root)).map(|(_, n)| n).sum();
            size_of(root).saturating_sub(inside)
        })
        .sum::<u64>();
    let projects = size_of(&projects);
    StorageUsage { projects, engine: engine_total, system: system_total, total: projects + engine_total + system_total }
}

#[tauri::command]
pub async fn storage_usage(app: AppHandle) -> CmdResult<StorageUsage> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let tc = state.toolchain.read().unwrap();
        let resources = app.path().resource_dir().ok();

        let mut engine: Vec<PathBuf> = Vec::new();
        engine.extend(tc.tectonic.clone());
        engine.extend(tc.tectonic_cache.clone());
        engine.extend(tc.texlive.clone());
        if let Some(r) = &resources {
            engine.push(r.join("texlive"));
            engine.push(r.join("tectonic-cache"));
        }

        let paths = app.path();
        let mut system: Vec<PathBuf> = [paths.app_config_dir(), paths.app_cache_dir(), paths.app_data_dir(), paths.app_local_data_dir(), paths.app_log_dir()]
            .into_iter()
            .flatten()
            .collect();
        let exe = std::env::current_exe().ok();
        let bundle = exe.as_ref().and_then(|e| e.ancestors().find(|p| p.extension().is_some_and(|x| x == "app")).map(Path::to_path_buf));
        match bundle {
            Some(b) => system.push(b),
            None => {
                system.extend(exe);
                system.push(state.mcp_binary());
            }
        }

        Ok(measure(state.ws().root().to_path_buf(), engine, system))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Engine {
    pub id: &'static str,
    pub name: &'static str,
    pub detail: String,
    pub path: Option<String>,
    pub size: u64,
    pub installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub engines: Vec<Engine>,
    pub packages: Vec<InstalledPackage>,
}

#[tauri::command]
pub async fn installed_components(app: AppHandle) -> CmdResult<Installed> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let tc = state.toolchain.read().unwrap();
        let resources = app.path().resource_dir().ok();
        let shown = |p: &Option<PathBuf>| p.as_ref().map(|p| p.display().to_string());

        let mut engines = vec![Engine {
            id: "tectonic",
            name: "Tectonic",
            detail: if tc.tectonic.is_some() { "Default engine, bundled with QuillTex.".into() } else { "Bundled Tectonic is missing. Run `npm run sidecars`.".into() },
            path: shown(&tc.tectonic),
            size: tc.tectonic.as_deref().map_or(0, size_of),
            installed: tc.tectonic.is_some(),
        }];
        let cache_size = tc.tectonic_cache.as_deref().map_or(0, size_of);
        engines.push(Engine {
            id: "tectonic-cache",
            name: "Tectonic package cache",
            detail: "TeX bundles and formats, downloaded on demand".into(),
            path: shown(&tc.tectonic_cache),
            size: cache_size,
            installed: cache_size > 0,
        });

        let texlive = tc.texlive.clone();
        let texlive_ready = texlive.as_deref().is_some_and(texlive::is_installed);
        let version = texlive.as_deref().and_then(texlive::installed_version);
        engines.push(Engine {
            id: "texlive",
            name: "TeX Live (pdfLaTeX, XeLaTeX, LuaLaTeX)",
            detail: match (texlive_ready, version) {
                (true, v) => format!(
                    "{}Installed inside QuillTex. Missing packages are added automatically when a document needs them.",
                    v.map(|v| format!("TinyTeX {v}. ")).unwrap_or_default()
                ),
                (false, _) if tc.texlive_archive.is_some() => "Included with QuillTex. Set up on the first compile that uses it, or now.".into(),
                (false, _) => "Downloaded on the first compile that uses it (about 70 MB), or now.".into(),
            },
            path: shown(&texlive),
            size: if texlive_ready { texlive.as_deref().map_or(0, size_of) } else { 0 },
            installed: texlive_ready,
        });

        let bundled: Vec<PathBuf> = resources.iter().flat_map(|r| [r.join("texlive"), r.join("tectonic-cache")]).filter(|p| p.exists()).collect();
        if !bundled.is_empty() {
            engines.push(Engine {
                id: "bundled",
                name: "Bundled engine data",
                detail: "Offline installers shipped inside the app".into(),
                path: resources.as_ref().map(|r| r.display().to_string()),
                size: bundled.iter().map(|p| size_of(p)).sum(),
                installed: true,
            });
        }

        let packages = match (&texlive, texlive_ready) {
            (Some(root), true) => texlive::installed_packages(root),
            _ => Vec::new(),
        };
        Ok(Installed { engines, packages })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_tectonic_cache(state: State<'_, AppState>) -> CmdResult<()> {
    let dir = state.toolchain.read().unwrap().tectonic_cache.clone().ok_or("Tectonic cache is not available")?;
    tauri::async_runtime::spawn_blocking(move || match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}

fn valid_package_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '.'))
}

#[tauri::command]
pub async fn remove_tex_package(state: State<'_, AppState>, name: String) -> CmdResult<()> {
    if !valid_package_name(&name) {
        return Err(format!("Invalid package name: {name}"));
    }
    let root = state.toolchain.read().unwrap().texlive.clone().ok_or("TeX Live is not available")?;
    tauri::async_runtime::spawn_blocking(move || texlive::remove_packages(&root, &[name.as_str()]).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_engine_from_system_without_double_counting() {
        let tmp = tempfile::tempdir().unwrap();
        let projects = tmp.path().join("projects");
        let data = tmp.path().join("data");
        let engine = data.join("texlive");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::create_dir_all(&engine).unwrap();
        std::fs::write(projects.join("a.tex"), [0u8; 100]).unwrap();
        std::fs::write(engine.join("pkg"), [0u8; 1000]).unwrap();
        std::fs::write(data.join("settings.json"), [0u8; 10]).unwrap();

        let u = measure(projects, vec![engine.clone(), engine], vec![data]);
        assert_eq!((u.projects, u.engine, u.system, u.total), (100, 1000, 10, 1110));
    }

    #[test]
    fn rejects_package_names_that_look_like_flags() {
        assert!(valid_package_name("amsmath"));
        assert!(valid_package_name("collection-latex"));
        assert!(!valid_package_name("--force"));
        assert!(!valid_package_name("a b"));
        assert!(!valid_package_name(""));
    }

    #[test]
    fn missing_paths_count_as_zero() {
        assert_eq!(size_of(Path::new("/definitely/not/here")), 0);
    }
}
