use std::path::PathBuf;

use quilltex_core::{compile::Toolchain, Workspace};
use quilltex_mcp::{serve, Ctx};

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let root = arg("--root").map(PathBuf::from).unwrap_or_else(Workspace::default_root);
    let ws = match Workspace::new(&root) {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("quilltex-mcp: cannot open {}: {e}", root.display());
            std::process::exit(1);
        }
    };
    let tectonic = arg("--tectonic").map(PathBuf::from).or_else(|| {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        let name = if cfg!(windows) { "tectonic.exe" } else { "tectonic" };
        Some(dir.join(name)).filter(|p| p.is_file())
    });
    let ctx = Ctx {
        ws,
        toolchain: Toolchain {
            tectonic,
            tectonic_cache: arg("--tectonic-cache").map(PathBuf::from),
            texlive: arg("--texlive").map(PathBuf::from),
            texlive_archive: arg("--texlive-archive").map(PathBuf::from),
        },
    };
    serve(&ctx, std::io::stdin().lock(), std::io::stdout().lock());
}
