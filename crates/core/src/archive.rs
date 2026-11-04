use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::{project, Error, Result, Workspace};

pub fn import_zip(ws: &Workspace, zip_path: &Path, name: &str) -> Result<project::ProjectSummary> {
    let dir = ws.project_dir(name)?;
    if dir.exists() {
        return Err(Error::AlreadyExists(name.into()));
    }
    let mut zip = zip::ZipArchive::new(std::fs::File::open(zip_path)?)?;

    let mut entries: Vec<(usize, PathBuf)> = Vec::new();
    for i in 0..zip.len() {
        let f = zip.by_index(i)?;
        let Some(p) = f.enclosed_name() else {
            return Err(Error::OutsideRoot(f.name().to_string()));
        };
        if is_junk(&p) {
            continue;
        }
        entries.push((i, p));
    }
    let prefix = common_root(&entries);

    std::fs::create_dir_all(&dir)?;
    let result = (|| -> Result<()> {
        for (i, p) in &entries {
            let rel = match &prefix {
                Some(pre) => p.strip_prefix(pre).unwrap_or(p).to_path_buf(),
                None => p.clone(),
            };
            if rel.as_os_str().is_empty() {
                continue;
            }
            let out = dir.join(&rel);
            let mut f = zip.by_index(*i)?;
            if f.is_dir() {
                std::fs::create_dir_all(&out)?;
                continue;
            }
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut buf = Vec::with_capacity(f.size() as usize);
            f.read_to_end(&mut buf)?;
            std::fs::write(out, buf)?;
        }
        ws.ensure_inside(&dir)?;
        project::ensure_scaffold(ws, name)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result?;
    project::summary(ws, name)
}

fn is_junk(p: &Path) -> bool {
    p.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s == "__MACOSX" || s == ".DS_Store"
    })
}

fn common_root(entries: &[(usize, PathBuf)]) -> Option<PathBuf> {
    let mut first: Option<PathBuf> = None;
    for (_, p) in entries {
        let mut comps = p.components();
        let top = PathBuf::from(comps.next()?.as_os_str());
        if comps.next().is_none() && !p.to_string_lossy().ends_with('/') {
            return None;
        }
        match &first {
            None => first = Some(top),
            Some(f) if *f != top => return None,
            _ => {}
        }
    }
    first
}

pub fn export_zip(ws: &Workspace, name: &str, dest: &Path, include_git: bool) -> Result<()> {
    let dir = ws.project_dir(name)?;
    if !dir.is_dir() {
        return Err(Error::NotFound(name.into()));
    }
    let mut zip = zip::ZipWriter::new(std::fs::File::create(dest)?);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let walker = walkdir::WalkDir::new(&dir).into_iter().filter_entry(|e| {
        let rel = e.path().strip_prefix(&dir).unwrap_or(e.path());
        let top = rel.components().next().map(|c| c.as_os_str().to_string_lossy().to_string());
        let in_git = top.as_deref() == Some(".git");
        e.file_name() != ".DS_Store"
            && !(in_git && !include_git)
            && !(project::is_internal(e.path(), &dir) && !in_git)
    });
    for entry in walker {
        let entry = entry.map_err(|e| Error::Other(e.to_string()))?;
        let rel = entry.path().strip_prefix(&dir).unwrap();
        if rel.as_os_str().is_empty() || entry.file_type().is_symlink() {
            continue;
        }
        let rel = rel.to_string_lossy().replace('\\', "/");
        if entry.file_type().is_dir() {
            zip.add_directory(format!("{rel}/"), opts)?;
        } else {
            zip.start_file(rel, opts)?;
            zip.write_all(&std::fs::read(entry.path())?)?;
        }
    }
    zip.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_strips_wrapper() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path().join("ws")).unwrap();
        project::create(&ws, "src", "report").unwrap();
        std::fs::create_dir_all(ws.root().join("src/.quilltex/build")).unwrap();
        std::fs::write(ws.root().join("src/.quilltex/build/main.pdf"), "x").unwrap();
        let z = tmp.path().join("out.zip");
        export_zip(&ws, "src", &z, false).unwrap();

        let names: Vec<String> = {
            let a = zip::ZipArchive::new(std::fs::File::open(&z).unwrap()).unwrap();
            a.file_names().map(String::from).collect()
        };
        assert!(names.iter().any(|n| n == "chapters/introduction.tex"));
        assert!(!names.iter().any(|n| n.contains("build")));

        let s = import_zip(&ws, &z, "copy").unwrap();
        assert_eq!(s.meta.main_file, "main.tex");
        assert!(ws.root().join("copy/chapters/introduction.tex").exists());

        let wrapped = tmp.path().join("wrapped.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&wrapped).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        w.start_file("paper/main.tex", o).unwrap();
        w.write_all(b"\\documentclass{article}").unwrap();
        w.start_file("__MACOSX/paper/._main.tex", o).unwrap();
        w.finish().unwrap();
        import_zip(&ws, &wrapped, "wrapped").unwrap();
        assert!(ws.root().join("wrapped/main.tex").exists());
    }

    #[test]
    fn rejects_zip_slip() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path().join("ws")).unwrap();
        let z = tmp.path().join("evil.zip");
        let mut w = zip::ZipWriter::new(std::fs::File::create(&z).unwrap());
        w.start_file("../../evil.txt", zip::write::SimpleFileOptions::default()).unwrap();
        w.write_all(b"pwned").unwrap();
        w.finish().unwrap();
        assert!(import_zip(&ws, &z, "evil").is_err());
        assert!(!ws.root().join("evil").exists());
        assert!(!tmp.path().join("evil.txt").exists());
    }
}
