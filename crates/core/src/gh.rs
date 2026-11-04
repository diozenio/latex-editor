use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::Value;

use crate::{Error, Result};

pub const HOST: &str = "github.com";

pub fn find() -> Option<PathBuf> {
    let name = if cfg!(windows) { "gh.exe" } else { "gh" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/home/linuxbrew/.linuxbrew/bin"].iter().map(PathBuf::from));
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        dirs.push(PathBuf::from(pf).join("GitHub CLI"));
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

pub fn command() -> Result<Command> {
    let bin = find().ok_or_else(|| Error::Other("GitHub CLI (gh) is not installed".into()))?;
    let mut c = Command::new(bin);
    c.stdin(Stdio::null()).env("GH_PROMPT_DISABLED", "1").env("NO_COLOR", "1");
    crate::compile::hide_console(&mut c);
    Ok(c)
}

pub fn logged_in() -> bool {
    command()
        .and_then(|mut c| Ok(c.args(["auth", "token", "--hostname", HOST]).stdout(Stdio::null()).stderr(Stdio::null()).status()?))
        .is_ok_and(|s| s.success())
}

pub fn git_credential_args() -> Vec<String> {
    let Some(bin) = find().filter(|_| logged_in()) else { return vec![] };
    let key = format!("credential.https://{HOST}.helper");
    let bin = bin.display().to_string().replace('\\', "/");
    vec!["-c".into(), format!("{key}="), "-c".into(), format!("{key}=!'{bin}' auth git-credential")]
}

pub fn api(args: &[&str]) -> Result<Value> {
    let out = command()?.arg("api").args(args).output()?;
    let body: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    if !out.status.success() {
        let msg = body["message"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_string());
        return Err(Error::Other(format!("GitHub: {msg}")));
    }
    Ok(body)
}

pub fn run(args: &[&str]) -> Result<()> {
    let out = command()?.args(args).output()?;
    if !out.status.success() {
        return Err(Error::Other(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    Ok(())
}
