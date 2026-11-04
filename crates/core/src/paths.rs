use std::path::{Component, Path, PathBuf};

use crate::{Error, Result};

/// The folder that holds every project. All file access goes through
/// [`Workspace::resolve`], which refuses anything outside of it.
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;
        Ok(Self { root: root.canonicalize()? })
    }

    /// `~/Documents/Folio`, falling back to `~/Folio`.
    pub fn default_root() -> PathBuf {
        dirs::document_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Folio")
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn project_dir(&self, project: &str) -> Result<PathBuf> {
        validate_name(project)?;
        Ok(self.root.join(project))
    }

    /// Resolve `rel` inside `project`, rejecting absolute paths, `..`, and
    /// symlinks that point outside the projects folder.
    pub fn resolve(&self, project: &str, rel: &str) -> Result<PathBuf> {
        let base = self.project_dir(project)?;
        let rel = rel.trim_start_matches("./");
        let mut out = base.clone();
        for comp in Path::new(rel).components() {
            match comp {
                Component::Normal(c) => out.push(c),
                Component::CurDir => {}
                _ => return Err(Error::OutsideRoot(rel.to_string())),
            }
        }
        self.ensure_inside(&out)?;
        Ok(out)
    }

    /// Canonicalize the longest existing prefix and make sure it stays inside
    /// the root (this is what catches symlinks).
    pub fn ensure_inside(&self, path: &Path) -> Result<()> {
        let mut existing = path.to_path_buf();
        while !existing.exists() {
            if !existing.pop() {
                return Err(Error::OutsideRoot(path.display().to_string()));
            }
        }
        let canon = existing.canonicalize()?;
        if canon.starts_with(&self.root) {
            Ok(())
        } else {
            Err(Error::OutsideRoot(path.display().to_string()))
        }
    }

    /// Relative, forward-slash path of `abs` within `project`.
    pub fn relative(&self, project: &str, abs: &Path) -> Result<String> {
        let base = self.project_dir(project)?;
        let rel = abs
            .strip_prefix(&base)
            .map_err(|_| Error::OutsideRoot(abs.display().to_string()))?;
        Ok(rel.to_string_lossy().replace('\\', "/"))
    }
}

/// Project and file names: no separators, no leading dot, nothing Windows
/// would choke on.
pub fn validate_name(name: &str) -> Result<()> {
    let bad = name.is_empty()
        || name.len() > 120
        || name.starts_with('.')
        || name.ends_with(' ')
        || name.ends_with('.')
        || name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control());
    if bad {
        Err(Error::InvalidName(name.to_string()))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escapes() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path().join("root")).unwrap();
        std::fs::create_dir_all(ws.root().join("p")).unwrap();
        assert!(ws.resolve("p", "main.tex").is_ok());
        assert!(ws.resolve("p", "a/b/c.tex").is_ok());
        assert!(ws.resolve("p", "../other/x").is_err());
        assert!(ws.resolve("p", "/etc/passwd").is_err());
        assert!(ws.resolve("../p", "x").is_err());
        assert!(ws.resolve(".hidden", "x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_out() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path().join("root")).unwrap();
        std::fs::create_dir_all(ws.root().join("p")).unwrap();
        std::fs::create_dir_all(tmp.path().join("secret")).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("secret"), ws.root().join("p/link")).unwrap();
        assert!(ws.resolve("p", "link/file").is_err());
    }
}
