use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{paths::validate_name, templates, Error, Result, Workspace};

pub const META_DIR: &str = ".folio";
pub const BUILD_DIR: &str = ".folio/build";
const META_FILE: &str = ".folio/project.json";
const GITIGNORE: &str = ".folio/build/\n.DS_Store\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Engine {
    #[default]
    Tectonic,
    LatexmkPdflatex,
    LatexmkXelatex,
    LatexmkLualatex,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectMeta {
    pub main_file: String,
    pub engine: Engine,
    pub color: String,
    pub auto_compile: bool,
}

impl Default for ProjectMeta {
    fn default() -> Self {
        Self {
            main_file: "main.tex".into(),
            engine: Engine::Tectonic,
            color: "#6366F1".into(),
            auto_compile: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub name: String,
    pub path: String,
    pub meta: ProjectMeta,
    /// Unix millis of the most recently modified file.
    pub modified: i64,
    pub has_git: bool,
}

const COLORS: [&str; 8] = ["#6366F1", "#3B82F6", "#84CC16", "#10B981", "#F59E0B", "#EC4899", "#8B5CF6", "#EF4444"];

pub fn list(ws: &Workspace) -> Result<Vec<ProjectSummary>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(ws.root())? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry.file_type()?.is_dir() || validate_name(&name).is_err() {
            continue;
        }
        out.push(summary(ws, &name)?);
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

pub fn summary(ws: &Workspace, name: &str) -> Result<ProjectSummary> {
    let dir = ws.project_dir(name)?;
    if !dir.is_dir() {
        return Err(Error::NotFound(name.into()));
    }
    Ok(ProjectSummary {
        name: name.into(),
        path: dir.display().to_string(),
        meta: read_meta(ws, name)?,
        modified: last_modified(&dir),
        has_git: dir.join(".git").exists(),
    })
}

fn last_modified(dir: &Path) -> i64 {
    walkdir::WalkDir::new(dir)
        .max_depth(3)
        .into_iter()
        .filter_entry(|e| !is_internal(e.path(), dir))
        .filter_map(|e| e.ok()?.metadata().ok()?.modified().ok())
        .max()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis())
        .unwrap_or(0)
}

/// `.git` and `.folio/build` are implementation details, not user content.
pub fn is_internal(path: &Path, project_dir: &Path) -> bool {
    let rel = path.strip_prefix(project_dir).unwrap_or(path);
    let mut comps = rel.components().map(|c| c.as_os_str().to_string_lossy());
    match comps.next().as_deref() {
        Some(".git") => true,
        Some(".folio") => comps.next().as_deref() == Some("build"),
        _ => false,
    }
}

pub fn read_meta(ws: &Workspace, name: &str) -> Result<ProjectMeta> {
    let file = ws.project_dir(name)?.join(META_FILE);
    match std::fs::read_to_string(&file) {
        Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(guess_meta(&ws.project_dir(name)?)),
        Err(e) => Err(e.into()),
    }
}

pub fn write_meta(ws: &Workspace, name: &str, meta: &ProjectMeta) -> Result<()> {
    let dir = ws.project_dir(name)?;
    std::fs::create_dir_all(dir.join(META_DIR))?;
    std::fs::write(dir.join(META_FILE), serde_json::to_string_pretty(meta)? + "\n")?;
    Ok(())
}

/// For folders created outside Folio (unzipped, cloned): find the file with
/// `\documentclass`, preferring main.tex.
fn guess_meta(dir: &Path) -> ProjectMeta {
    let mut meta = ProjectMeta::default();
    if dir.join("main.tex").exists() {
        return meta;
    }
    let found = walkdir::WalkDir::new(dir)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "tex"))
        .find(|e| std::fs::read_to_string(e.path()).is_ok_and(|s| s.contains("\\documentclass")));
    if let Some(e) = found {
        if let Ok(rel) = e.path().strip_prefix(dir) {
            meta.main_file = rel.to_string_lossy().replace('\\', "/");
        }
    }
    meta
}

/// Writes `.folio/project.json` and makes sure build output is git-ignored.
pub fn ensure_scaffold(ws: &Workspace, name: &str) -> Result<()> {
    let dir = ws.project_dir(name)?;
    if !dir.join(META_FILE).exists() {
        let mut meta = guess_meta(&dir);
        meta.color = pick_color(name).into();
        write_meta(ws, name, &meta)?;
    }
    let gi = dir.join(".gitignore");
    let current = std::fs::read_to_string(&gi).unwrap_or_default();
    if !current.lines().any(|l| l.trim() == ".folio/build/") {
        let sep = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
        std::fs::write(&gi, format!("{current}{sep}{GITIGNORE}"))?;
    }
    Ok(())
}

fn pick_color(name: &str) -> &'static str {
    let h = name.bytes().fold(0usize, |a, b| a.wrapping_mul(31).wrapping_add(b as usize));
    COLORS[h % COLORS.len()]
}

pub fn create(ws: &Workspace, name: &str, template: &str) -> Result<ProjectSummary> {
    let dir = ws.project_dir(name)?;
    if dir.exists() {
        return Err(Error::AlreadyExists(name.into()));
    }
    std::fs::create_dir_all(&dir)?;
    for (path, content) in templates::files(template, name) {
        let p = dir.join(path);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(p, content)?;
    }
    ensure_scaffold(ws, name)?;
    summary(ws, name)
}

pub fn rename(ws: &Workspace, from: &str, to: &str) -> Result<ProjectSummary> {
    let src = ws.project_dir(from)?;
    let dst = ws.project_dir(to)?;
    if !src.is_dir() {
        return Err(Error::NotFound(from.into()));
    }
    if dst.exists() {
        return Err(Error::AlreadyExists(to.into()));
    }
    std::fs::rename(src, dst)?;
    summary(ws, to)
}

pub fn duplicate(ws: &Workspace, from: &str, to: &str) -> Result<ProjectSummary> {
    let src = ws.project_dir(from)?;
    let dst = ws.project_dir(to)?;
    if dst.exists() {
        return Err(Error::AlreadyExists(to.into()));
    }
    copy_dir(&src, &dst, &src)?;
    summary(ws, to)
}

fn copy_dir(src: &Path, dst: &Path, root: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        if is_internal(&from, root) {
            continue;
        }
        let to = dst.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_dir(&from, &to, root)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Moves the project to the OS trash so it can be recovered.
pub fn delete(ws: &Workspace, name: &str) -> Result<()> {
    let dir = ws.project_dir(name)?;
    if !dir.is_dir() {
        return Err(Error::NotFound(name.into()));
    }
    crate::trash::delete(&dir).map_err(|e| Error::Other(e.to_string()))
}

/// A free name like "Untitled 2" given a base.
pub fn unique_name(ws: &Workspace, base: &str) -> String {
    let exists = |n: &str| ws.root().join(n).exists();
    if !exists(base) {
        return base.to_string();
    }
    (2..).map(|i| format!("{base} {i}")).find(|n| !exists(n)).unwrap()
}

pub fn build_dir(ws: &Workspace, name: &str) -> Result<PathBuf> {
    Ok(ws.project_dir(name)?.join(BUILD_DIR))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_list_rename_duplicate() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        create(&ws, "Thesis", "article").unwrap();
        assert!(ws.root().join("Thesis/main.tex").exists());
        assert!(std::fs::read_to_string(ws.root().join("Thesis/.gitignore")).unwrap().contains(".folio/build/"));
        assert!(create(&ws, "Thesis", "blank").is_err());
        rename(&ws, "Thesis", "Paper").unwrap();
        duplicate(&ws, "Paper", "Paper copy").unwrap();
        let names: Vec<_> = list(&ws).unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(names.len(), 2);
        assert_eq!(unique_name(&ws, "Paper"), "Paper 2");
    }

    #[test]
    fn guesses_main_file() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        std::fs::create_dir_all(ws.root().join("x/src")).unwrap();
        std::fs::write(ws.root().join("x/src/paper.tex"), "\\documentclass{article}").unwrap();
        ensure_scaffold(&ws, "x").unwrap();
        assert_eq!(read_meta(&ws, "x").unwrap().main_file, "src/paper.tex");
    }
}
