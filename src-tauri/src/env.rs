//! GUI apps on macOS/Linux don't inherit the login shell's PATH, so tools
//! like `claude` (often in ~/.local/bin or an nvm dir) wouldn't be found.
//! Ask the login shell once and extend our PATH (process-local only).

use std::path::PathBuf;

pub fn fix_path() {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = std::process::Command::new(shell)
            .args(["-ilc", "printf '__FOLIO_PATH__%s' \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output();
        if let Ok(out) = out {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(path) = text.split("__FOLIO_PATH__").nth(1) {
                let current = std::env::var("PATH").unwrap_or_default();
                std::env::set_var("PATH", format!("{}:{current}", path.trim()));
            }
        }
    }
}

/// Locate the Claude Code CLI.
pub fn find_claude(override_path: &str) -> Option<PathBuf> {
    if !override_path.is_empty() {
        return Some(PathBuf::from(override_path)).filter(|p| p.is_file());
    }
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".claude/local"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
        dirs.push(home.join("AppData/Roaming/npm"));
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].iter().map(PathBuf::from));
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}
