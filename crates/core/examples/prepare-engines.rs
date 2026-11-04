use std::path::PathBuf;

use quilltex_core::compile::{compile_with, Toolchain};
use quilltex_core::project::{self, Engine};
use quilltex_core::{templates, texlive, Workspace};

fn main() {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    let [work, tectonic, archive] = args.as_slice() else {
        eprintln!("usage: prepare-engines <work> <tectonic> <tinytex-archive>");
        std::process::exit(2);
    };
    let projects = work.join("projects");
    let _ = std::fs::remove_dir_all(&projects);
    let ws = Workspace::new(&projects).expect("projects folder");
    let tc = Toolchain {
        tectonic: Some(tectonic.clone()),
        tectonic_cache: Some(work.join("tectonic-cache")),
        texlive: Some(work.join("TinyTeX")),
        texlive_archive: Some(archive.clone()),
    };

    let mut failed = Vec::new();
    for (template, _) in templates::TEMPLATES {
        project::create(&ws, template, template).expect("create project");
        for engine in [Engine::Tectonic, Engine::LatexmkPdflatex] {
            let mut meta = project::read_meta(&ws, template).expect("read meta");
            meta.engine = engine;
            project::write_meta(&ws, template, &meta).expect("write meta");
            eprintln!("· {template} ({engine:?})");
            match compile_with(&ws, template, &tc, &|s| eprintln!("  {s}")) {
                Ok(r) if r.ok => {}
                Ok(r) => failed.push(format!("{template} ({engine:?}):\n{}", r.log)),
                Err(e) => failed.push(format!("{template} ({engine:?}): {e}")),
            }
        }
    }
    let _ = std::fs::remove_dir_all(&projects);
    if let Err(e) = texlive::remove_packages(&work.join("TinyTeX"), &["biber"]) {
        failed.push(format!("removing biber: {e}"));
    }
    if !failed.is_empty() {
        eprintln!("templates that failed to compile:\n{}", failed.join("\n\n"));
        std::process::exit(1);
    }
}
