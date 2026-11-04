use std::path::Path;

use serde::Serialize;

use crate::{paths::validate_name, project::is_internal, Error, Result, Workspace};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    /// Forward-slash path relative to the project.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

pub fn tree(ws: &Workspace, project: &str) -> Result<Vec<FileNode>> {
    let dir = ws.project_dir(project)?;
    if !dir.is_dir() {
        return Err(Error::NotFound(project.into()));
    }
    walk(&dir, &dir)
}

fn walk(dir: &Path, root: &Path) -> Result<Vec<FileNode>> {
    let mut nodes = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // Hide internals and dotfiles except .gitignore / .latexmkrc.
        if is_internal(&path, root) || name == ".folio" || name == ".DS_Store" {
            continue;
        }
        if name.starts_with('.') && !matches!(name.as_str(), ".gitignore" | ".latexmkrc") {
            continue;
        }
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            continue;
        }
        let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        let is_dir = ft.is_dir();
        nodes.push(FileNode {
            name,
            path: rel,
            is_dir,
            size: if is_dir { 0 } else { entry.metadata()?.len() },
            children: if is_dir { Some(walk(&path, root)?) } else { None },
        });
    }
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(nodes)
}

pub fn read_text(ws: &Workspace, project: &str, rel: &str) -> Result<String> {
    let p = ws.resolve(project, rel)?;
    if !p.is_file() {
        return Err(Error::NotFound(rel.into()));
    }
    let bytes = std::fs::read(p)?;
    String::from_utf8(bytes).map_err(|_| Error::Other(format!("{rel} is not a text file")))
}

pub fn read_bytes(ws: &Workspace, project: &str, rel: &str) -> Result<Vec<u8>> {
    let p = ws.resolve(project, rel)?;
    Ok(std::fs::read(p)?)
}

pub fn write_text(ws: &Workspace, project: &str, rel: &str, content: &str) -> Result<()> {
    write_bytes(ws, project, rel, content.as_bytes())
}

pub fn write_bytes(ws: &Workspace, project: &str, rel: &str, content: &[u8]) -> Result<()> {
    let p = ws.resolve(project, rel)?;
    check_leaf(&p)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Write to a sibling temp file then rename, so editors and the watcher
    // never observe a half-written file.
    let tmp = p.with_extension(format!(
        "{}.folio-tmp",
        p.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()
    ));
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

/// Replace exactly one occurrence of `old` with `new`.
pub fn edit_text(ws: &Workspace, project: &str, rel: &str, old: &str, new: &str) -> Result<()> {
    let text = read_text(ws, project, rel)?;
    match text.matches(old).count() {
        0 => Err(Error::Other(format!("text not found in {rel}"))),
        1 => write_text(ws, project, rel, &text.replacen(old, new, 1)),
        n => Err(Error::Other(format!("text occurs {n} times in {rel}; include more context"))),
    }
}

pub fn create_dir(ws: &Workspace, project: &str, rel: &str) -> Result<()> {
    let p = ws.resolve(project, rel)?;
    check_leaf(&p)?;
    std::fs::create_dir_all(p)?;
    Ok(())
}

pub fn rename(ws: &Workspace, project: &str, from: &str, to: &str) -> Result<()> {
    let src = ws.resolve(project, from)?;
    let dst = ws.resolve(project, to)?;
    check_leaf(&dst)?;
    if !src.exists() {
        return Err(Error::NotFound(from.into()));
    }
    if dst.exists() {
        return Err(Error::AlreadyExists(to.into()));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(src, dst)?;
    Ok(())
}

/// Moves to the OS trash.
pub fn delete(ws: &Workspace, project: &str, rel: &str) -> Result<()> {
    let p = ws.resolve(project, rel)?;
    if p == ws.project_dir(project)? {
        return Err(Error::Other("refusing to delete the project root; use delete_project".into()));
    }
    if !p.exists() {
        return Err(Error::NotFound(rel.into()));
    }
    crate::trash::delete(&p).map_err(|e| Error::Other(e.to_string()))
}

/// Copy a file from anywhere on disk into the project (drag-and-drop upload).
pub fn import_file(ws: &Workspace, project: &str, src: &Path, dest_dir: &str) -> Result<String> {
    let name = src
        .file_name()
        .ok_or_else(|| Error::InvalidName(src.display().to_string()))?
        .to_string_lossy()
        .to_string();
    let rel = if dest_dir.is_empty() { name } else { format!("{}/{name}", dest_dir.trim_end_matches('/')) };
    let dst = ws.resolve(project, &rel)?;
    if src.is_dir() {
        return Err(Error::Other("folders are not supported; drop files or a zip".into()));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dst)?;
    Ok(rel)
}

fn check_leaf(p: &Path) -> Result<()> {
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if name == ".gitignore" || name == ".latexmkrc" {
        return Ok(());
    }
    validate_name(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crud() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        crate::project::create(&ws, "p", "blank").unwrap();
        write_text(&ws, "p", "sections/intro.tex", "hello world").unwrap();
        edit_text(&ws, "p", "sections/intro.tex", "world", "there").unwrap();
        assert_eq!(read_text(&ws, "p", "sections/intro.tex").unwrap(), "hello there");
        rename(&ws, "p", "sections/intro.tex", "sections/a.tex").unwrap();
        let t = tree(&ws, "p").unwrap();
        assert_eq!(t[0].name, "sections");
        assert!(t.iter().all(|n| n.name != ".folio"));
        assert!(write_text(&ws, "p", "../q/x.tex", "").is_err());
    }
}
