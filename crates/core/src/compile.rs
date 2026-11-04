use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use wait_timeout::ChildExt;

use crate::project::{self, Engine, BUILD_DIR};
use crate::{Error, Result, Workspace};

const TIMEOUT: Duration = Duration::from_secs(300);

/// Where to find TeX binaries. Tectonic ships with the app as a sidecar; a
/// system TeX distribution is optional.
#[derive(Debug, Clone, Default)]
pub struct Toolchain {
    pub tectonic: Option<PathBuf>,
    /// Kept inside the app's own cache dir so uninstalling removes it.
    pub tectonic_cache: Option<PathBuf>,
    /// Directory containing `latexmk` (TeX Live / MacTeX / MiKTeX).
    pub system_tex_bin: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: Severity,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub ok: bool,
    /// Relative to the project, e.g. `.folio/build/main.pdf`.
    pub pdf: Option<String>,
    pub log: String,
    pub diagnostics: Vec<Diagnostic>,
    pub duration_ms: u64,
}

pub fn compile(ws: &Workspace, name: &str, tc: &Toolchain) -> Result<CompileResult> {
    let dir = ws.project_dir(name)?;
    let meta = project::read_meta(ws, name)?;
    let main = ws.resolve(name, &meta.main_file)?;
    if !main.is_file() {
        return Err(Error::Compile(format!("main file {} not found", meta.main_file)));
    }
    let out_dir = dir.join(BUILD_DIR);
    std::fs::create_dir_all(&out_dir)?;
    let stem = main.file_stem().unwrap().to_string_lossy().to_string();
    let pdf_path = out_dir.join(format!("{stem}.pdf"));
    let _ = std::fs::remove_file(&pdf_path);

    let started = Instant::now();
    let mut cmd = match meta.engine {
        Engine::Tectonic => {
            let bin = tc
                .tectonic
                .clone()
                .ok_or_else(|| Error::Compile("Tectonic is not available".into()))?;
            let mut c = Command::new(bin);
            c.args(["-X", "compile", "--synctex", "--keep-logs", "--untrusted", "--outdir"])
                .arg(&out_dir)
                .arg(&meta.main_file);
            if let Some(cache) = &tc.tectonic_cache {
                c.env("TECTONIC_CACHE_DIR", cache);
            }
            c
        }
        engine => {
            let bin_dir = tc
                .system_tex_bin
                .clone()
                .ok_or_else(|| Error::Compile("No system TeX distribution found (latexmk). Install TeX Live/MacTeX/MiKTeX or switch the engine to Tectonic.".into()))?;
            let flag = match engine {
                Engine::LatexmkXelatex => "-xelatex",
                Engine::LatexmkLualatex => "-lualatex",
                _ => "-pdf",
            };
            let mut c = Command::new(bin_dir.join(exe("latexmk")));
            c.args([flag, "-interaction=nonstopmode", "-file-line-error", "-synctex=1", "-halt-on-error"])
                .arg(format!("-outdir={}", out_dir.display()))
                .arg(&meta.main_file);
            // latexmk spawns pdflatex & friends; they must be on PATH.
            let path = std::env::var_os("PATH").unwrap_or_default();
            let mut paths = vec![bin_dir];
            paths.extend(std::env::split_paths(&path));
            c.env("PATH", std::env::join_paths(paths).map_err(|e| Error::Other(e.to_string()))?);
            c
        }
    };
    cmd.current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| Error::Compile(format!("failed to start compiler: {e}")))?;
    // Drain pipes on threads so a chatty compiler can't deadlock us.
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let t1 = std::thread::spawn(move || read_all(&mut so));
    let t2 = std::thread::spawn(move || read_all(&mut se));
    let status = match child.wait_timeout(TIMEOUT)? {
        Some(s) => s,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::Compile("compilation timed out after 5 minutes".into()));
        }
    };
    let console = format!("{}{}", t1.join().unwrap_or_default(), t2.join().unwrap_or_default());

    // Prefer the full TeX log; fall back to console output.
    let tex_log = std::fs::read_to_string(out_dir.join(format!("{stem}.log"))).unwrap_or_default();
    let mut diagnostics = parse_log(&console);
    for d in parse_log(&tex_log) {
        if !diagnostics.iter().any(|x| x.message == d.message && x.line == d.line) {
            diagnostics.push(d);
        }
    }
    let pdf_exists = pdf_path.is_file();
    if !status.success() && diagnostics.iter().all(|d| d.severity != Severity::Error) {
        diagnostics.insert(0, Diagnostic {
            severity: Severity::Error,
            file: None,
            line: None,
            message: console.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("compilation failed").to_string(),
        });
    }
    Ok(CompileResult {
        ok: status.success() && pdf_exists,
        pdf: pdf_exists.then(|| format!("{BUILD_DIR}/{stem}.pdf")),
        log: if tex_log.is_empty() { console } else { format!("{console}\n{tex_log}") },
        diagnostics,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// Remove build output.
pub fn clean(ws: &Workspace, name: &str) -> Result<()> {
    let out = ws.project_dir(name)?.join(BUILD_DIR);
    if out.exists() {
        std::fs::remove_dir_all(out)?;
    }
    Ok(())
}

fn read_all(r: &mut impl std::io::Read) -> String {
    let mut buf = Vec::new();
    let _ = r.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

#[cfg(windows)]
pub(crate) fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
pub(crate) fn hide_console(_: &mut Command) {}

/// Finds a directory containing `latexmk`.
pub fn detect_system_tex() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    candidates.extend(
        ["/Library/TeX/texbin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"]
            .iter()
            .map(PathBuf::from),
    );
    for base in ["/usr/local/texlive", "C:\\texlive"] {
        if let Ok(years) = std::fs::read_dir(base) {
            let mut years: Vec<_> = years.filter_map(|e| e.ok()).map(|e| e.path()).collect();
            years.sort();
            for y in years.into_iter().rev() {
                if let Ok(arches) = std::fs::read_dir(y.join("bin")) {
                    candidates.extend(arches.filter_map(|e| e.ok()).map(|e| e.path()));
                }
            }
        }
    }
    if let Some(local) = dirs::data_local_dir() {
        candidates.push(local.join("Programs/MiKTeX/miktex/bin/x64"));
    }
    candidates.push(PathBuf::from("C:\\Program Files\\MiKTeX\\miktex\\bin\\x64"));
    candidates.into_iter().find(|d| d.join(exe("latexmk")).is_file())
}

pub fn parse_log(log: &str) -> Vec<Diagnostic> {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<[Regex; 5]> = OnceLock::new();
    let [file_line, tectonic, bang, latex_warn, badbox] = RE.get_or_init(|| {
        [
            Regex::new(r"^(?:error: )?(?:\./)?([^\s:][^:]*?\.(?:tex|sty|cls|bib|ltx|dtx)):(\d+): (.+)$").unwrap(),
            Regex::new(r"^(error|warning|note): (.+)$").unwrap(),
            Regex::new(r"^! (.+)$").unwrap(),
            Regex::new(r"^(?:LaTeX|Package \w+) Warning: (.+?)(?: on input line (\d+))?\.?$").unwrap(),
            Regex::new(r"^((?:Over|Under)full \\[hv]box \([^)]*\))(?:.*? at lines? (\d+))?").unwrap(),
        ]
    });

    let lines: Vec<&str> = log.lines().collect();
    let mut out: Vec<Diagnostic> = Vec::new();
    let mut push = |d: Diagnostic| {
        if !out.iter().any(|x| x.message == d.message && x.line == d.line && x.file == d.file) {
            out.push(d);
        }
    };
    for (i, raw) in lines.iter().enumerate() {
        let line = raw.trim_end();
        if let Some(c) = file_line.captures(line) {
            let is_warning = line.starts_with("warning:");
            push(Diagnostic {
                severity: if is_warning { Severity::Warning } else { Severity::Error },
                file: Some(c[1].to_string()),
                line: c[2].parse().ok(),
                message: c[3].to_string(),
            });
        } else if let Some(c) = tectonic.captures(line) {
            let sev = match &c[1] {
                "error" => Severity::Error,
                "warning" => Severity::Warning,
                _ => Severity::Info,
            };
            // Tectonic's "warning: file:line: msg" form.
            let msg = c[2].to_string();
            let (file, ln, msg) = match file_line.captures(&msg) {
                Some(fc) => (Some(fc[1].to_string()), fc[2].parse().ok(), fc[3].to_string()),
                None => (None, None, msg),
            };
            if msg.starts_with("something bad happened") || msg.starts_with("halted on potentially-recoverable error") {
                continue;
            }
            push(Diagnostic { severity: sev, file, line: ln, message: msg });
        } else if let Some(c) = bang.captures(line) {
            // Classic TeX error: "! msg" … "l.42 context".
            let ln = lines[i + 1..]
                .iter()
                .take(12)
                .find_map(|l| l.strip_prefix("l.").and_then(|r| r.split_whitespace().next()?.parse().ok()));
            push(Diagnostic { severity: Severity::Error, file: None, line: ln, message: c[1].to_string() });
        } else if let Some(c) = latex_warn.captures(line) {
            push(Diagnostic {
                severity: Severity::Warning,
                file: None,
                line: c.get(2).and_then(|m| m.as_str().parse().ok()),
                message: c[1].to_string(),
            });
        } else if let Some(c) = badbox.captures(line) {
            push(Diagnostic {
                severity: Severity::Info,
                file: None,
                line: c.get(2).and_then(|m| m.as_str().parse().ok()),
                message: c[1].to_string(),
            });
        }
    }
    out
}

pub fn pdf_path(ws: &Workspace, name: &str) -> Result<Option<PathBuf>> {
    let meta = project::read_meta(ws, name)?;
    let stem = Path::new(&meta.main_file).file_stem().unwrap_or_default().to_string_lossy().to_string();
    let p = ws.project_dir(name)?.join(BUILD_DIR).join(format!("{stem}.pdf"));
    Ok(p.is_file().then_some(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_formats() {
        let log = "\
./main.tex:12: Undefined control sequence.
error: chapters/a.tex:3: Missing $ inserted
warning: main.tex:20: Reference `fig' undefined
LaTeX Warning: Citation `knuth' on page 1 undefined on input line 7.
Overfull \\hbox (12.0pt too wide) in paragraph at lines 30--31
! Emergency stop.
l.99 \\end
";
        let d = parse_log(log);
        assert_eq!(d[0].file.as_deref(), Some("main.tex"));
        assert_eq!(d[0].line, Some(12));
        assert_eq!(d[1].file.as_deref(), Some("chapters/a.tex"));
        assert_eq!(d[2].severity, Severity::Warning);
        assert_eq!(d[3].line, Some(7));
        assert_eq!(d[4].severity, Severity::Info);
        assert_eq!(d[4].line, Some(30));
        assert_eq!(d[5].line, Some(99));
    }

    /// Runs only when a tectonic binary is reachable (FOLIO_TECTONIC or PATH).
    #[test]
    fn compiles_with_tectonic() {
        let bin = std::env::var_os("FOLIO_TECTONIC").map(PathBuf::from).or_else(|| {
            let p = std::env::var_os("PATH")?;
            std::env::split_paths(&p).map(|d| d.join(exe("tectonic"))).find(|p| p.is_file())
        });
        let Some(bin) = bin else { return };
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        project::create(&ws, "p", "blank").unwrap();
        let tc = Toolchain { tectonic: Some(bin), ..Default::default() };
        let r = compile(&ws, "p", &tc).unwrap();
        assert!(r.ok, "{}", r.log);
        assert!(ws.root().join("p/.folio/build/main.synctex.gz").exists());
    }
}
