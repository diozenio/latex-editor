use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use wait_timeout::ChildExt;

use crate::project::{self, Engine, BUILD_DIR};
use crate::{markdown, texlive, Error, Result, Workspace};

const TIMEOUT: Duration = Duration::from_secs(300);

const MAX_INSTALLS: usize = 60;

#[derive(Debug, Clone, Default)]
pub struct Toolchain {
    pub tectonic: Option<PathBuf>,
    pub tectonic_cache: Option<PathBuf>,
    pub texlive: Option<PathBuf>,
    pub texlive_archive: Option<PathBuf>,
}

pub fn seed_tectonic_cache(seed: &Path, cache: &Path) -> Result<()> {
    for entry in walkdir::WalkDir::new(seed).into_iter().flatten().filter(|e| e.file_type().is_file()) {
        let rel = entry.path().strip_prefix(seed).unwrap();
        let dest = cache.join(rel);
        if dest.exists() {
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let partial = dest.with_file_name(format!("{}.seeding", rel.file_name().unwrap().to_string_lossy()));
        std::fs::copy(entry.path(), &partial)?;
        std::fs::rename(&partial, &dest)?;
    }
    Ok(())
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
    pub pdf: Option<String>,
    pub log: String,
    pub diagnostics: Vec<Diagnostic>,
    pub duration_ms: u64,
}

pub fn compile(ws: &Workspace, name: &str, tc: &Toolchain) -> Result<CompileResult> {
    compile_with(ws, name, tc, &|_| {})
}

pub fn compile_with(ws: &Workspace, name: &str, tc: &Toolchain, status: &dyn Fn(&str)) -> Result<CompileResult> {
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
    let document = markdown::is_document(&meta.main_file);
    let source = if document {
        let md = std::fs::read_to_string(&main)?;
        let tex = markdown::to_latex(&md, &|p| ws.resolve(name, p).is_ok_and(|p| p.is_file()));
        std::fs::write(out_dir.join(format!("{stem}.tex")), tex)?;
        format!("{BUILD_DIR}/{stem}.tex")
    } else {
        meta.main_file.clone()
    };

    let started = Instant::now();
    let (success, console) = match meta.engine {
        Engine::Tectonic => {
            let bin = tc
                .tectonic
                .clone()
                .ok_or_else(|| Error::Compile("Tectonic is not available".into()))?;
            let mut c = Command::new(bin);
            c.args(["-X", "compile", "--synctex", "--keep-logs", "--untrusted", "--outdir"])
                .arg(&out_dir)
                .arg(&source);
            if let Some(cache) = &tc.tectonic_cache {
                c.env("TECTONIC_CACHE_DIR", cache);
            }
            hide_console(&mut c);
            run(c, &dir)?
        }
        engine => {
            let root = tc.texlive.clone().ok_or_else(|| Error::Compile("TeX Live is not available".into()))?;
            if !texlive::is_installed(&root) {
                status("Setting up TeX Live (first use)…");
                texlive::install(&root, tc.texlive_archive.as_deref(), status)?;
            }
            let rc = texlive::latexmkrc(&root)?;
            let flag = match engine {
                Engine::LatexmkXelatex => "-xelatex",
                Engine::LatexmkLualatex => "-lualatex",
                _ => "-pdf",
            };
            let latexmk = |force: bool| -> Result<Command> {
                let mut c = texlive::command(&root, "latexmk")?;
                c.arg("-norc").arg("-r").arg(&rc);
                if force {
                    c.arg("-g");
                }
                c.args([flag, "-interaction=nonstopmode", "-file-line-error", "-synctex=1", "-halt-on-error"])
                    .arg(format!("-outdir={}", out_dir.display()))
                    .arg(&source);
                Ok(c)
            };
            let mut notes = String::new();
            let mut tried: Vec<String> = Vec::new();
            let note = |notes: &mut String, installed: &[String]| {
                for p in installed {
                    notes.push_str(&format!("QuillTex: installed TeX package `{p}`\n"));
                }
            };
            let installed = texlive::install_for_project(&root, &dir, &mut tried, status);
            note(&mut notes, &installed);
            if !installed.is_empty() {
                status("Compiling…");
            }
            let mut outcome = run(latexmk(false)?, &dir)?;
            while !outcome.0 && tried.len() < MAX_INSTALLS {
                let log = std::fs::read_to_string(out_dir.join(format!("{stem}.log"))).unwrap_or_default();
                let Some(missing) = texlive::find_missing(&format!("{}\n{log}", outcome.1)) else { break };
                let package = match &missing {
                    texlive::Missing::Package(p) => Some(p.clone()),
                    texlive::Missing::Language(lang) => {
                        let (babel, hyphen) = texlive::language_packages(lang);
                        if let Some(h) = hyphen.filter(|h| !tried.contains(h)) {
                            if texlive::install_packages(&root, &[&h]).is_ok() {
                                notes.push_str(&format!("QuillTex: installed TeX package `{h}`\n"));
                            }
                            tried.push(h);
                        }
                        Some(babel)
                    }
                    texlive::Missing::File(f) => {
                        status(&format!("Looking up {f}…"));
                        texlive::package_for_file(&root, f)
                    }
                };
                let Some(package) = package.filter(|p| !tried.contains(p)) else { break };
                let files = match &missing {
                    texlive::Missing::File(f) => vec![f.rsplit('/').next().unwrap_or(f).to_string()],
                    _ => Vec::new(),
                };
                match texlive::install_with_requirements(&root, vec![package.clone()], files, &mut tried, status) {
                    Ok(installed) => note(&mut notes, &installed),
                    Err(e) => {
                        notes.push_str(&format!("QuillTex: could not install TeX package `{package}`: {e}\n"));
                        break;
                    }
                }
                status("Compiling…");
                outcome = run(latexmk(true)?, &dir)?;
            }
            if outcome.0 {
                let log = std::fs::read_to_string(out_dir.join(format!("{stem}.log"))).unwrap_or_default();
                let mut installed = Vec::new();
                for p in texlive::find_optional(&log).into_iter().filter(|p| !tried.contains(p)) {
                    status(&format!("Installing TeX package {p}…"));
                    if texlive::install_packages(&root, &[&p]).is_ok() {
                        notes.push_str(&format!("QuillTex: installed TeX package `{p}`\n"));
                        installed.push(p);
                    }
                }
                if !installed.is_empty() {
                    status("Compiling…");
                    outcome = run(latexmk(true)?, &dir)?;
                }
            }
            (outcome.0, format!("{notes}{}", outcome.1))
        }
    };

    let tex_log = std::fs::read_to_string(out_dir.join(format!("{stem}.log"))).unwrap_or_default();
    let mut diagnostics = parse_log(&console);
    for d in parse_log(&tex_log) {
        if !diagnostics.iter().any(|x| x.message == d.message && x.line == d.line) {
            diagnostics.push(d);
        }
    }
    if document {
        // Errors point into the generated LaTeX, which the user never sees.
        for d in &mut diagnostics {
            d.file = Some(meta.main_file.clone());
            d.line = None;
        }
    }
    let pdf_exists = pdf_path.is_file();
    if !success && diagnostics.iter().all(|d| d.severity != Severity::Error) {
        diagnostics.insert(0, Diagnostic {
            severity: Severity::Error,
            file: None,
            line: None,
            message: console.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("compilation failed").to_string(),
        });
    }
    Ok(CompileResult {
        ok: success && pdf_exists,
        pdf: pdf_exists.then(|| format!("{BUILD_DIR}/{stem}.pdf")),
        log: if tex_log.is_empty() { console } else { format!("{console}\n{tex_log}") },
        diagnostics,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

fn run(mut cmd: Command, dir: &Path) -> Result<(bool, String)> {
    cmd.current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| Error::Compile(format!("failed to start compiler: {e}")))?;
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
    Ok((status.success(), console))
}

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

#[cfg(test)]
fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

#[cfg(windows)]
pub(crate) fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
pub(crate) fn hide_console(_: &mut Command) {}

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

    #[test]
    fn compiles_with_tectonic() {
        let bin = std::env::var_os("QUILLTEX_TECTONIC").map(PathBuf::from).or_else(|| {
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
        assert!(ws.root().join("p/.quilltex/build/main.synctex.gz").exists());
    }

    #[test]
    fn compiles_a_markdown_document_with_tectonic() {
        let bin = std::env::var_os("QUILLTEX_TECTONIC").map(PathBuf::from).or_else(|| {
            let p = std::env::var_os("PATH")?;
            std::env::split_paths(&p).map(|d| d.join(exe("tectonic"))).find(|p| p.is_file())
        });
        let Some(bin) = bin else { return };
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        project::create(&ws, "d", "document").unwrap();
        let tc = Toolchain { tectonic: Some(bin), ..Default::default() };
        let r = compile(&ws, "d", &tc).unwrap();
        assert!(r.ok, "{}", r.log);
        assert!(ws.root().join("d/.quilltex/build/main.pdf").exists());
    }

    #[test]
    fn compiles_with_texlive_installing_packages() {
        let Some(root) = std::env::var_os("QUILLTEX_TEXLIVE").map(PathBuf::from) else { return };
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        std::fs::create_dir_all(ws.root().join("p")).unwrap();
        std::fs::write(ws.root().join("p/.latexmkrc"), "$pdf_mode = 4;\n").unwrap();
        std::fs::write(
            ws.root().join("p/main.tex"),
            "\\documentclass{article}\\usepackage{lipsum}\\begin{document}\\lipsum[1]\\end{document}\n",
        )
        .unwrap();
        let tc = Toolchain { texlive: Some(root), ..Default::default() };
        let r = compile_with(&ws, "p", &tc, &|s| eprintln!("{s}")).unwrap();
        assert!(r.ok, "{}", r.log);
    }
}
