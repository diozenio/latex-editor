use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{paths::validate_name, templates, Error, Result, Workspace};

pub const META_DIR: &str = ".quilltex";
pub const BUILD_DIR: &str = ".quilltex/build";
const META_FILE: &str = ".quilltex/project.json";
const GITIGNORE: &str = ".quilltex/build/\n.DS_Store\n";

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
    pub id: String,
    pub main_file: String,
    pub engine: Engine,
    pub color: String,
    pub auto_compile: bool,
}

impl Default for ProjectMeta {
    fn default() -> Self {
        Self {
            id: String::new(),
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
    ensure_scaffold(ws, name)?;
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

pub fn is_internal(path: &Path, project_dir: &Path) -> bool {
    let rel = path.strip_prefix(project_dir).unwrap_or(path);
    let mut comps = rel.components().map(|c| c.as_os_str().to_string_lossy());
    match comps.next().as_deref() {
        Some(".git") => true,
        Some(".quilltex") => comps.next().as_deref() == Some("build"),
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
    let mut meta = meta.clone();
    if meta.id.is_empty() {
        meta.id = read_meta(ws, name).map(|m| m.id).unwrap_or_default();
    }
    std::fs::create_dir_all(dir.join(META_DIR))?;
    std::fs::write(dir.join(META_FILE), serde_json::to_string_pretty(&meta)? + "\n")?;
    Ok(())
}

fn guess_meta(dir: &Path) -> ProjectMeta {
    let mut meta = ProjectMeta::default();
    let rc = [".latexmkrc", "latexmkrc"].iter().find_map(|f| std::fs::read_to_string(dir.join(f)).ok());
    let rc_main = rc.as_deref().and_then(latexmkrc_main).filter(|f| dir.join(f).is_file());
    if let Some(main) = rc_main {
        meta.main_file = main;
    } else if !dir.join("main.tex").exists() {
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
    }
    let main = std::fs::read_to_string(dir.join(&meta.main_file)).unwrap_or_default();
    meta.engine = magic_engine(&main).or_else(|| rc.as_deref().map(|rc| tex_live_engine(dir, rc))).unwrap_or_default();
    meta
}

fn magic_engine(tex: &str) -> Option<Engine> {
    let re = regex::Regex::new(r"(?im)^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*([a-z]+)").unwrap();
    let head: String = tex.lines().take(30).collect::<Vec<_>>().join("\n");
    match re.captures(&head)?[1].to_ascii_lowercase().as_str() {
        "pdflatex" | "latex" => Some(Engine::LatexmkPdflatex),
        "xelatex" => Some(Engine::LatexmkXelatex),
        "lualatex" => Some(Engine::LatexmkLualatex),
        _ => None,
    }
}

fn tex_live_engine(dir: &Path, rc: &str) -> Engine {
    let package = regex::Regex::new(
        r"\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}|\\directlua",
    )
    .unwrap();
    let (mut unicode, mut lua) = (false, false);
    let sources = walkdir::WalkDir::new(dir)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "tex" || x == "sty" || x == "cls"));
    for e in sources {
        let text = std::fs::read_to_string(e.path()).unwrap_or_default();
        for c in package.captures_iter(&text) {
            let Some(names) = c.get(1) else {
                lua = true;
                continue;
            };
            for name in names.as_str().split(',').map(str::trim) {
                match name {
                    "fontspec" | "unicode-math" | "polyglossia" | "xeCJK" => unicode = true,
                    "luacode" | "luatexja" | "luaotfload" | "lua-ul" | "luatexbase" => lua = true,
                    _ => {}
                }
            }
        }
    }
    let rc_lua = regex::Regex::new(r"(?m)^\s*\$pdf_mode\s*=\s*4").unwrap().is_match(rc);
    if lua || (unicode && rc_lua) {
        Engine::LatexmkLualatex
    } else if unicode {
        Engine::LatexmkXelatex
    } else {
        Engine::LatexmkPdflatex
    }
}

fn latexmkrc_main(rc: &str) -> Option<String> {
    let re = regex::Regex::new(r#"(?m)^\s*@default_files\s*=\s*\(\s*['"]([^'"]+)['"]"#).unwrap();
    re.captures(rc).map(|c| c[1].to_string())
}

pub fn ensure_scaffold(ws: &Workspace, name: &str) -> Result<()> {
    let dir = ws.project_dir(name)?;
    if !dir.join(META_FILE).exists() {
        let mut meta = guess_meta(&dir);
        meta.color = pick_color(name).into();
        meta.id = new_id();
        write_meta(ws, name, &meta)?;
    } else {
        let mut meta = read_meta(ws, name)?;
        if meta.id.is_empty() {
            meta.id = new_id();
            write_meta(ws, name, &meta)?;
        }
    }
    let gi = dir.join(".gitignore");
    let current = std::fs::read_to_string(&gi).unwrap_or_default();
    if !current.lines().any(|l| l.trim() == ".quilltex/build/") {
        let sep = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
        std::fs::write(&gi, format!("{current}{sep}{GITIGNORE}"))?;
    }
    Ok(())
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
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
    let mut meta = read_meta(ws, to)?;
    meta.id = new_id();
    write_meta(ws, to, &meta)?;
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

pub fn delete(ws: &Workspace, name: &str) -> Result<()> {
    let dir = ws.project_dir(name)?;
    if !dir.is_dir() {
        return Err(Error::NotFound(name.into()));
    }
    crate::trash::delete(&dir).map_err(|e| Error::Other(e.to_string()))
}

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
        assert!(std::fs::read_to_string(ws.root().join("Thesis/.gitignore")).unwrap().contains(".quilltex/build/"));
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

    #[test]
    fn guesses_engine_from_latexmkrc_and_magic_comment() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        std::fs::create_dir_all(ws.root().join("a")).unwrap();
        std::fs::write(ws.root().join("a/thesis.tex"), "\\documentclass{book}\\usepackage[T1]{fontenc}").unwrap();
        std::fs::write(ws.root().join("a/notes.tex"), "\\documentclass{article}").unwrap();
        std::fs::write(ws.root().join("a/.latexmkrc"), "$pdf_mode = 4;\n@default_files = ('thesis.tex');\n").unwrap();
        ensure_scaffold(&ws, "a").unwrap();
        let meta = read_meta(&ws, "a").unwrap();
        assert_eq!(meta.main_file, "thesis.tex");
        assert_eq!(meta.engine, Engine::LatexmkPdflatex);

        std::fs::create_dir_all(ws.root().join("d/style")).unwrap();
        std::fs::write(ws.root().join("d/main.tex"), "\\documentclass{article}\\usepackage{style/x}").unwrap();
        std::fs::write(ws.root().join("d/style/x.sty"), "\\RequirePackage{amsmath, fontspec}").unwrap();
        std::fs::write(ws.root().join("d/.latexmkrc"), "$pdf_mode = 5;\n").unwrap();
        ensure_scaffold(&ws, "d").unwrap();
        assert_eq!(read_meta(&ws, "d").unwrap().engine, Engine::LatexmkXelatex);

        std::fs::create_dir_all(ws.root().join("b")).unwrap();
        std::fs::write(ws.root().join("b/main.tex"), "% !TEX program = xelatex\n\\documentclass{article}").unwrap();
        ensure_scaffold(&ws, "b").unwrap();
        assert_eq!(read_meta(&ws, "b").unwrap().engine, Engine::LatexmkXelatex);

        std::fs::create_dir_all(ws.root().join("c")).unwrap();
        std::fs::write(ws.root().join("c/main.tex"), "\\documentclass{article}").unwrap();
        ensure_scaffold(&ws, "c").unwrap();
        assert_eq!(read_meta(&ws, "c").unwrap().engine, Engine::Tectonic);
    }
}
