//! The app's private TeX Live (a TinyTeX build) behind the pdfLaTeX, XeLaTeX
//! and LuaLaTeX engines. It lives in the app's data dir, is never added to
//! PATH and ignores any TeX installed on the computer: only the app's own
//! child processes see it, with an environment built here.
//!
//! TinyTeX ships a small base; whatever else a document needs is installed
//! with tlmgr the first time a compile reports it missing.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use crate::compile::hide_console;
use crate::{Error, Result};

const TINYTEX_VERSION: &str = "2026.11";
/// Installed right away: helpers latexmk calls for bibliographies, indexes and glossaries.
const BASE_PACKAGES: &[&str] = &["biber", "makeindex", "glossaries"];
const READY_MARKER: &str = ".ready";
/// Package from the TeX Live of a given year, once that year's repository is frozen.
const HISTORIC_REPO: &str = "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/{year}/tlnet-final";

/// Variables a user's shell may set that would point TeX at files outside our tree.
const TEX_ENV: &[&str] = &[
    "TEXMFHOME", "TEXMFVAR", "TEXMFCONFIG", "TEXMFCNF", "TEXMF", "TEXMFLOCAL", "TEXMFSYSVAR", "TEXMFSYSCONFIG",
    "TEXMFDIST", "TEXINPUTS", "BIBINPUTS", "BSTINPUTS", "TEXFONTS", "TFMFONTS", "ENCFONTS", "LUAINPUTS",
    "TEXFORMATS", "MFINPUTS", "MPINPUTS", "T1FONTS", "VFFONTS", "OPENTYPEFONTS", "TTFONTS",
];

/// tlmgr is not safe to run twice at once on the same tree.
static TLMGR: Mutex<()> = Mutex::new(());

/// Used instead of a project's own `.latexmkrc` (that file is Perl code, and its
/// output paths would fight ours): glossaries support and enough reruns for
/// heavy classes like abnTeX2. Subfolders of the build dir are made up front for
/// `\include{chapters/x}`.
const LATEXMKRC: &str = r#"$max_repeat = 10;
$allow_subdir_creation = 2;
add_cus_dep('glo', 'gls', 0, 'run_makeglossaries');
add_cus_dep('acn', 'acr', 0, 'run_makeglossaries');
add_cus_dep('ntn', 'not', 0, 'run_makeglossaries');
$clean_ext .= ' acr acn alg glo gls glg ist not ntn';
sub run_makeglossaries {
    my ($name, $dir) = fileparse($_[0]);
    return system('makeglossaries', '-d', $dir, $name);
}
"#;

/// Writes the latexmk configuration and returns its path.
pub fn latexmkrc(root: &Path) -> Result<PathBuf> {
    let path = root.join("latexmkrc");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(LATEXMKRC) {
        std::fs::write(&path, LATEXMKRC)?;
    }
    Ok(path)
}

pub fn is_installed(root: &Path) -> bool {
    root.join(READY_MARKER).is_file() && bin_dir(root).is_some()
}

/// `<root>/bin/<platform>`, the one holding latexmk.
pub fn bin_dir(root: &Path) -> Option<PathBuf> {
    std::fs::read_dir(root.join("bin"))
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|d| d.join(exe("latexmk")).is_file())
}

/// A command for one of the distribution's programs, isolated from any other TeX.
pub fn command(root: &Path, program: &str) -> Result<Command> {
    let bin = bin_dir(root).ok_or_else(|| Error::Compile("TeX Live is not installed".into()))?;
    let program = bin.join(exe(program));
    isolated(bin, program)
}

fn isolated(bin: PathBuf, program: PathBuf) -> Result<Command> {
    let mut c = Command::new(program);
    for var in TEX_ENV {
        c.env_remove(var);
    }
    // latexmk starts lualatex, biber, makeglossaries… by name: ours go first, and
    // directories holding another TeX are dropped so nothing falls through to it.
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![bin];
    paths.extend(std::env::split_paths(&path).filter(|d| !has_tex(d)));
    c.env("PATH", std::env::join_paths(paths).map_err(|e| Error::Other(e.to_string()))?);
    hide_console(&mut c);
    Ok(c)
}

fn has_tex(dir: &Path) -> bool {
    ["kpsewhich", "latex", "tex", "tlmgr"].iter().any(|b| dir.join(exe(b)).is_file())
}

/// Download and set up TinyTeX into `root`. Reports progress as short messages.
pub fn install(root: &Path, status: &dyn Fn(&str)) -> Result<()> {
    let _guard = TLMGR.lock().unwrap_or_else(|e| e.into_inner());
    if is_installed(root) {
        return Ok(());
    }
    let parent = root.parent().ok_or_else(|| Error::Other("invalid TeX Live folder".into()))?;
    std::fs::create_dir_all(parent)?;
    let stage = parent.join("texlive.partial");
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage)?;
    let result = (|| -> Result<()> {
        let asset = asset()?;
        let archive = stage.join(&asset);
        let url = format!("https://github.com/rstudio/tinytex-releases/releases/download/v{TINYTEX_VERSION}/{asset}");
        download(&url, &archive, status)?;
        status("Unpacking TeX Live…");
        unpack(&archive, &stage)?;
        let _ = std::fs::remove_file(&archive);
        let unpacked = stage.join("TinyTeX");
        if !unpacked.join("bin").is_dir() {
            return Err(Error::Other("unexpected TeX Live archive layout".into()));
        }
        let _ = std::fs::remove_dir_all(root);
        std::fs::rename(&unpacked, root)?;
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result?;

    status("Setting up TeX Live…");
    tlmgr(root, &["update", "--self"]).map_err(|out| Error::Compile(last_lines(&out, 6)))?;
    let _ = tlmgr(root, &["postaction", "install", "script", "xetex"]);
    status("Installing TeX helpers…");
    install_locked(root, BASE_PACKAGES)?;
    std::fs::write(root.join(READY_MARKER), TINYTEX_VERSION)?;
    Ok(())
}

pub fn remove(root: &Path) -> Result<()> {
    let _guard = TLMGR.lock().unwrap_or_else(|e| e.into_inner());
    if root.exists() {
        std::fs::remove_dir_all(root)?;
    }
    Ok(())
}

/// Install TeX Live packages (tlmgr names).
pub fn install_packages(root: &Path, packages: &[&str]) -> Result<()> {
    let _guard = TLMGR.lock().unwrap_or_else(|e| e.into_inner());
    install_locked(root, packages)
}

fn install_locked(root: &Path, packages: &[&str]) -> Result<()> {
    let mut args = vec!["install"];
    args.extend(packages);
    for _ in 0..3 {
        match tlmgr(root, &args) {
            Ok(_) => return Ok(()),
            Err(out) if out.contains("tlmgr itself needs to be updated") => {
                tlmgr(root, &["update", "--self"]).map_err(|out| Error::Compile(last_lines(&out, 6)))?;
            }
            // A new TeX Live year came out: keep installing from our year's frozen repository.
            Err(out) if out.contains("is older than remote repository") => {
                let year = release_year(root).ok_or_else(|| Error::Compile(out.clone()))?;
                tlmgr(root, &["option", "repository", &HISTORIC_REPO.replace("{year}", &year)])
                    .map_err(|out| Error::Compile(last_lines(&out, 6)))?;
            }
            Err(out) => return Err(Error::Compile(last_lines(&out, 6))),
        }
    }
    Err(Error::Compile(format!("could not install {}", packages.join(", "))))
}

/// Which package ships `file` (e.g. `abntex2.cls`), looked up in the online catalogue.
pub fn package_for_file(root: &Path, file: &str) -> Option<String> {
    let _guard = TLMGR.lock().unwrap_or_else(|e| e.into_inner());
    let out = tlmgr(root, &["search", "--global", "--file", &format!("/{file}")]).ok()?;
    // "pkg:" lines, each followed by indented paths.
    let mut current: Option<&str> = None;
    for line in out.lines() {
        if let Some(pkg) = line.strip_suffix(':').filter(|l| !l.starts_with(char::is_whitespace) && !l.contains(' ')) {
            current = Some(pkg);
        } else if let Some(pkg) = current {
            let path = line.trim();
            if path.rsplit('/').next() == Some(file) {
                return Some(pkg.to_string());
            }
        }
    }
    None
}

/// What a failed run is missing, from its console output or log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Missing {
    /// A file to look up (`foo.sty`, `ecrm1000.tfm`).
    File(String),
    /// A package known by name.
    Package(String),
    /// A babel language: its `babel-*` package, plus hyphenation patterns when they exist.
    Language(String),
}

pub fn find_missing(log: &str) -> Option<Missing> {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<[Regex; 6]> = OnceLock::new();
    let [file, cant_find, font, babel, bib_style, command] = RE.get_or_init(|| {
        [
            Regex::new(r"File `([^']+)' not found").unwrap(),
            Regex::new(r"! I can't find file `([^']+)'").unwrap(),
            Regex::new(r"Font [^=\s]+=([^\s]+?)(?: at [^ ]+)? not loadable: (?:Metric \(TFM\) file|metric data) not found").unwrap(),
            Regex::new(r"Package babel Error: Unknown option `?'?([A-Za-z]+)'").unwrap(),
            Regex::new(r"Package biblatex Error: Style '([^']+)' not found").unwrap(),
            Regex::new(r"(?m)(?:sh: (?:line \d+: )?([\w-]+): command not found|'([\w-]+)' is not recognized as an internal or external command)").unwrap(),
        ]
    });
    if let Some(c) = file.captures(log) {
        return Some(Missing::File(c[1].to_string()));
    }
    if let Some(c) = font.captures(log) {
        return Some(Missing::File(format!("{}.tfm", &c[1])));
    }
    if let Some(c) = cant_find.captures(log) {
        let name = &c[1];
        let name = if Path::new(name).extension().is_some() { name.to_string() } else { format!("{name}.tex") };
        return Some(Missing::File(name));
    }
    if let Some(c) = babel.captures(log) {
        return Some(Missing::Language(babel_package(&c[1]).to_string()));
    }
    if let Some(c) = bib_style.captures(log) {
        return Some(Missing::File(format!("{}.bbx", &c[1])));
    }
    if let Some(c) = command.captures(log) {
        let name = c.get(1).or(c.get(2)).unwrap().as_str();
        let pkg = match name {
            "makeglossaries" | "makeglossaries-lite" => "glossaries",
            "bibtex" | "bibtex8" => "bibtex",
            other => other,
        };
        return Some(Missing::Package(pkg.to_string()));
    }
    None
}

/// Packages a successful build did without but which change its output, the way a
/// full TeX Live (Overleaf) would typeset it: hyphenation patterns and glossaries'
/// language modules.
pub fn find_optional(log: &str) -> Vec<String> {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<[Regex; 2]> = OnceLock::new();
    let [hyphen, glossaries] = RE.get_or_init(|| {
        [
            Regex::new(r"No hyphenation patterns were preloaded for\s*(?:\(babel\)\s*)?the language [`']?([A-Za-z]+)'").unwrap(),
            Regex::new(r"bundle called\s*(?:\(glossaries\)\s*)?`(glossaries-[a-z]+)'").unwrap(),
        ]
    });
    let mut out: Vec<String> = Vec::new();
    for c in hyphen.captures_iter(log) {
        if let (_, Some(h)) = language_packages(babel_package(&c[1])) {
            out.push(h);
        }
    }
    out.extend(glossaries.captures_iter(log).map(|c| c[1].to_string()));
    out.sort();
    out.dedup();
    out
}

/// babel's language options → the `babel-*` package that defines them.
fn babel_package(lang: &str) -> &str {
    match lang {
        "brazil" | "brazilian" | "portuguese" | "portuges" => "portuges",
        "english" | "american" | "USenglish" | "british" | "UKenglish" | "australian" | "canadian" | "newzealand" => {
            "english"
        }
        "ngerman" | "german" | "austrian" | "naustrian" | "swissgerman" | "nswissgerman" => "german",
        "french" | "francais" | "acadian" | "canadien" => "french",
        "spanish" | "mexican" => "spanish",
        other => other,
    }
}

/// TeX Live packages for a babel language (`portuges` → babel-portuges, hyphen-portuguese).
pub fn language_packages(lang: &str) -> (String, Option<String>) {
    let hyphen = match lang {
        "english" => None,
        "portuges" => Some("portuguese"),
        other => Some(other),
    };
    (format!("babel-{lang}"), hyphen.map(|h| format!("hyphen-{h}")))
}

fn release_year(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join("release-texlive.txt")).ok()?;
    let re = regex::Regex::new(r"version (\d{4})").unwrap();
    re.captures(&text).map(|c| c[1].to_string())
}

/// Runs tlmgr; Err carries its output so callers can tell failures apart.
fn tlmgr(root: &Path, args: &[&str]) -> std::result::Result<String, String> {
    let bin = bin_dir(root).ok_or("TeX Live is not installed")?;
    let program = bin.join(if cfg!(windows) { "tlmgr.bat" } else { "tlmgr" });
    let mut cmd = isolated(bin, program).map_err(|e| e.to_string())?;
    let out = cmd
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run tlmgr: {e}"))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text) } else { Err(text) }
}

fn last_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

fn asset() -> Result<String> {
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", _) => "darwin",
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-arm64",
        ("windows", _) => "windows",
        (os, arch) => return Err(Error::Other(format!("TeX Live is not available for {os}/{arch}"))),
    };
    let ext = if cfg!(windows) { "exe" } else { "tar.xz" };
    Ok(format!("TinyTeX-1-{platform}-v{TINYTEX_VERSION}.{ext}"))
}

fn download(url: &str, dest: &Path, status: &dyn Fn(&str)) -> Result<()> {
    use std::io::{Read, Write};
    let fail = |e: &dyn std::fmt::Display| Error::Other(format!("TeX Live download failed: {e}"));
    let resp = ureq::get(url).call().map_err(|e| fail(&e))?;
    let total: Option<u64> = resp.headers().get("content-length").and_then(|v| v.to_str().ok()?.parse().ok());
    let mut reader = resp.into_body().into_reader();
    let mut file = std::fs::File::create(dest)?;
    let mut buf = vec![0u8; 256 * 1024];
    let (mut done, mut shown) = (0u64, u64::MAX);
    status("Downloading TeX Live…");
    loop {
        let n = reader.read(&mut buf).map_err(|e| fail(&e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        done += n as u64;
        if let Some(total) = total.filter(|t| *t > 0) {
            let pct = done * 100 / total;
            if pct != shown {
                shown = pct;
                status(&format!("Downloading TeX Live… {pct}%"));
            }
        }
    }
    file.flush()?;
    Ok(())
}

fn unpack(archive: &Path, into: &Path) -> Result<()> {
    // Windows bundles are self-extracting 7-Zip archives; elsewhere system tar handles .xz.
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new(archive);
        c.arg("-y");
        c
    } else {
        let mut c = Command::new("tar");
        c.arg("-xf").arg(archive);
        c
    };
    cmd.current_dir(into).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd.output().map_err(|e| Error::Other(format!("failed to unpack TeX Live: {e}")))?;
    if !out.status.success() {
        return Err(Error::Other(format!("failed to unpack TeX Live: {}", String::from_utf8_lossy(&out.stderr))));
    }
    Ok(())
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_missing_resources() {
        let f = |s: &str| find_missing(s);
        assert_eq!(f("./main.tex:3: LaTeX Error: File `abntex2.cls' not found."), Some(Missing::File("abntex2.cls".into())));
        assert_eq!(
            f("./m.tex:101: Font \\=txsyc at 12pt not loadable: metric data not found or bad."),
            Some(Missing::File("txsyc.tfm".into()))
        );
        assert_eq!(
            f("! Font T1/cmr/m/n/10=ecrm1000 at 10.0pt not loadable: Metric (TFM) file not found."),
            Some(Missing::File("ecrm1000.tfm".into()))
        );
        assert_eq!(f("babel.sty:4494: Package babel Error: Unknown option 'brazilian'."), Some(Missing::Language("portuges".into())));
        assert_eq!(f("Package biblatex Error: Style 'abnt' not found."), Some(Missing::File("abnt.bbx".into())));
        assert_eq!(f("sh: makeindex: command not found"), Some(Missing::Package("makeindex".into())));
        assert_eq!(
            f("'biber' is not recognized as an internal or external command,"),
            Some(Missing::Package("biber".into()))
        );
        assert_eq!(f("! I can't find file `chapters/intro'."), Some(Missing::File("chapters/intro.tex".into())));
        assert_eq!(f("Output written on main.pdf"), None);
    }

    #[test]
    fn finds_packages_that_change_output() {
        let log = "Package babel Warning: No hyphenation patterns were preloaded for\n\
(babel)                the language 'brazilian' into the format.\n\
(glossaries)                Please check on CTAN for a bundle called\n\
(glossaries)                `glossaries-portuges' or similar.\n\
(glossaries)                Please check on CTAN for a bundle called\n\
(glossaries)                `glossaries-english' or similar.\n";
        assert_eq!(find_optional(log), ["glossaries-english", "glossaries-portuges", "hyphen-portuguese"]);
    }
}
