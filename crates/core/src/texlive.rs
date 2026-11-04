use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use crate::compile::hide_console;
use crate::{Error, Result};

const TINYTEX_VERSION: &str = "2026.11";
const BASE_PACKAGES: &[&str] = &["biber", "makeindex", "glossaries"];
const READY_MARKER: &str = ".ready";
const REMOVED_MARKER: &str = "texlive.removed";
const DEPENDENCY_ROUNDS: usize = 4;
const MAX_SCANNED: usize = 1000;
const HISTORIC_REPO: &str = "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/{year}/tlnet-final";

const TEX_ENV: &[&str] = &[
    "TEXMFHOME", "TEXMFVAR", "TEXMFCONFIG", "TEXMFCNF", "TEXMF", "TEXMFLOCAL", "TEXMFSYSVAR", "TEXMFSYSCONFIG",
    "TEXMFDIST", "TEXINPUTS", "BIBINPUTS", "BSTINPUTS", "TEXFONTS", "TFMFONTS", "ENCFONTS", "LUAINPUTS",
    "TEXFORMATS", "MFINPUTS", "MPINPUTS", "T1FONTS", "VFFONTS", "OPENTYPEFONTS", "TTFONTS",
];

static TLMGR: Mutex<()> = Mutex::new(());

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

pub fn bin_dir(root: &Path) -> Option<PathBuf> {
    std::fs::read_dir(root.join("bin"))
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|d| d.join(exe("latexmk")).is_file())
}

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

pub fn install(root: &Path, bundled: Option<&Path>, status: &dyn Fn(&str)) -> Result<()> {
    let _guard = TLMGR.lock().unwrap_or_else(|e| e.into_inner());
    if is_installed(root) {
        return Ok(());
    }
    let parent = root.parent().ok_or_else(|| Error::Other("invalid TeX Live folder".into()))?;
    std::fs::create_dir_all(parent)?;
    let _ = std::fs::remove_file(parent.join(REMOVED_MARKER));
    let stage = parent.join("texlive.partial");
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage)?;
    let result = (|| -> Result<()> {
        match bundled.filter(|a| a.is_file()) {
            Some(archive) => {
                status("Unpacking TeX Live…");
                unpack(archive, &stage)?;
            }
            None => {
                let asset = asset()?;
                let archive = stage.join(&asset);
                let url =
                    format!("https://github.com/rstudio/tinytex-releases/releases/download/v{TINYTEX_VERSION}/{asset}");
                download(&url, &archive, status)?;
                status("Unpacking TeX Live…");
                unpack(&archive, &stage)?;
                let _ = std::fs::remove_file(&archive);
            }
        }
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

    if root.join(READY_MARKER).is_file() {
        let _ = tlmgr(root, &["postaction", "install", "script", "xetex"]);
        return Ok(());
    }
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
    if let Some(parent) = root.parent() {
        let _ = std::fs::write(parent.join(REMOVED_MARKER), "");
    }
    Ok(())
}

pub fn was_removed(root: &Path) -> bool {
    root.parent().is_some_and(|p| p.join(REMOVED_MARKER).is_file())
}

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

pub fn install_with_requirements(
    root: &Path,
    mut packages: Vec<String>,
    files: Vec<String>,
    tried: &mut Vec<String>,
    status: &dyn Fn(&str),
) -> Result<Vec<String>> {
    let mut installed = Vec::new();
    let mut queue = files;
    let mut seen = HashSet::new();
    for _ in 0..DEPENDENCY_ROUNDS {
        packages.sort();
        packages.dedup();
        packages.retain(|p| !tried.contains(p));
        if !packages.is_empty() {
            status(&match packages.as_slice() {
                [one] => format!("Installing TeX package {one}…"),
                many => format!("Installing TeX packages {}…", many.join(", ")),
            });
            tried.extend(packages.iter().cloned());
            let names: Vec<&str> = packages.iter().map(String::as_str).collect();
            match install_packages(root, &names) {
                Ok(()) => installed.append(&mut packages),
                Err(e) if installed.is_empty() => return Err(e),
                Err(_) => break,
            }
        }
        let db = local_db(root);
        let paths = installed_paths(&db);
        let mut missing = Vec::new();
        while let Some(file) = queue.pop() {
            if seen.len() >= MAX_SCANNED || !seen.insert(file.clone()) {
                continue;
            }
            match paths.get(&file) {
                Some(path) => {
                    if let Ok(source) = std::fs::read_to_string(root.join(path)) {
                        queue.extend(requirements(&source));
                    }
                }
                None => {
                    seen.remove(&file);
                    missing.push(file);
                }
            }
        }
        packages = packages_for(root, &paths, &missing);
        if packages.iter().all(|p| tried.contains(p)) {
            break;
        }
        queue = missing;
    }
    Ok(installed)
}

pub fn install_for_project(root: &Path, project: &Path, tried: &mut Vec<String>, status: &dyn Fn(&str)) -> Vec<String> {
    let mut own = HashSet::new();
    let mut wanted = Vec::new();
    let entries = walkdir::WalkDir::new(project)
        .into_iter()
        .filter_entry(|e| !crate::project::is_internal(e.path(), project))
        .flatten()
        .filter(|e| e.file_type().is_file());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let ext = entry.path().extension().and_then(|e| e.to_str()).unwrap_or_default();
        if matches!(ext, "tex" | "ltx" | "sty" | "cls") && entry.metadata().is_ok_and(|m| m.len() < 4 << 20) {
            if let Ok(source) = std::fs::read_to_string(entry.path()) {
                wanted.extend(requirements(&source));
            }
        }
        own.insert(name);
    }
    wanted.retain(|f| !own.contains(f));
    install_with_requirements(root, Vec::new(), wanted, tried, status).unwrap_or_default()
}

pub fn requirements(source: &str) -> Vec<String> {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r"\\(usepackage|RequirePackage(?:WithOptions)?|documentclass|LoadClass(?:WithOptions)?|use(color|font|inner|outer)?theme|bibliographystyle)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}",
        )
        .unwrap()
    });
    let text: Vec<&str> = source.lines().map(strip_comment).collect();
    let text = text.join("\n");
    let mut out = Vec::new();
    for c in re.captures_iter(&text) {
        let command = &c[1];
        for name in c[3].split(',').map(str::trim) {
            if name.is_empty() || !name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') {
                continue;
            }
            out.push(match command {
                "documentclass" | "LoadClass" | "LoadClassWithOptions" => format!("{name}.cls"),
                "bibliographystyle" => format!("{name}.bst"),
                _ if command.ends_with("theme") => {
                    format!("beamer{}theme{name}.sty", c.get(2).map_or("", |m| m.as_str()))
                }
                _ => format!("{name}.sty"),
            });
        }
    }
    out.sort();
    out.dedup();
    out
}

fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    match (0..bytes.len()).find(|&i| bytes[i] == b'%' && (i == 0 || bytes[i - 1] != b'\\')) {
        Some(i) => &line[..i],
        None => line,
    }
}

fn local_db(root: &Path) -> String {
    std::fs::read_to_string(root.join("tlpkg").join("texlive.tlpdb")).unwrap_or_default()
}

fn runfiles(tlpdb: &str, mut f: impl FnMut(&str, &str)) {
    let (mut package, mut in_runfiles) = ("", false);
    for line in tlpdb.lines() {
        if let Some(path) = line.strip_prefix(' ') {
            if in_runfiles {
                f(package, path);
            }
        } else {
            in_runfiles = line.starts_with("runfiles");
            if let Some(name) = line.strip_prefix("name ") {
                package = name;
            }
        }
    }
}

fn installed_paths(db: &str) -> HashMap<String, String> {
    let mut paths = HashMap::new();
    runfiles(db, |_, path| {
        paths.insert(path.rsplit('/').next().unwrap_or(path).to_string(), path.to_string());
    });
    paths
}

fn packages_for(root: &Path, installed: &HashMap<String, String>, files: &[String]) -> Vec<String> {
    let missing: Vec<&String> = files.iter().filter(|f| !installed.contains_key(*f)).collect();
    if missing.is_empty() {
        return Vec::new();
    }
    let Some(catalogue) = catalogue(root) else { return Vec::new() };
    let mut out: Vec<String> = missing.iter().filter_map(|f| catalogue.get(*f).cloned()).collect();
    out.sort();
    out.dedup();
    out
}

fn catalogue(root: &Path) -> Option<Arc<HashMap<String, String>>> {
    type Cached = (PathBuf, SystemTime, Arc<HashMap<String, String>>);
    static CACHE: Mutex<Option<Cached>> = Mutex::new(None);
    let (path, modified) = std::fs::read_dir(root.join("tlpkg"))
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("texlive.tlpdb.main."))
        .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
        .max_by_key(|(_, m)| *m)?;
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((p, m, map)) = cache.as_ref() {
        if *p == path && *m == modified {
            return Some(map.clone());
        }
    }
    let text = std::fs::read_to_string(&path).ok()?;
    let mut map = HashMap::new();
    runfiles(&text, |package, path| {
        let file = path.rsplit('/').next().unwrap_or(path);
        map.entry(file.to_string()).or_insert_with(|| package.to_string());
    });
    let map = Arc::new(map);
    *cache = Some((path, modified, map.clone()));
    Some(map)
}

pub fn remove_packages(root: &Path, packages: &[&str]) -> Result<()> {
    let _guard = TLMGR.lock().unwrap_or_else(|e| e.into_inner());
    let mut args = vec!["remove"];
    args.extend(packages);
    tlmgr(root, &args).map(|_| ()).map_err(|out| Error::Compile(last_lines(&out, 6)))
}

pub fn package_for_file(root: &Path, file: &str) -> Option<String> {
    if let Some(package) = catalogue(root).and_then(|c| c.get(file).cloned()) {
        return Some(package);
    }
    let _guard = TLMGR.lock().unwrap_or_else(|e| e.into_inner());
    let out = tlmgr(root, &["search", "--global", "--file", &format!("/{file}")]).ok()?;
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Missing {
    File(String),
    Package(String),
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
    let mut cmd = if archive.extension().is_some_and(|e| e == "exe") {
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

    #[test]
    fn finds_what_sources_load() {
        let source = r"\documentclass[12pt]{abntex2}
\usepackage[utf8]{inputenc}
\usepackage{amsmath, amssymb}
% \usepackage{commented}
\usepackage[
  margin=2cm,
]{geometry}
\RequirePackage{xcolor}[2020/01/01]
\usepackage{\mypkg}
\usetheme{metropolis} \usecolortheme{beaver}
\bibliographystyle{abntex2-alf}
50\% \usepackage{lipsum}";
        assert_eq!(
            requirements(source),
            [
                "abntex2-alf.bst",
                "abntex2.cls",
                "amsmath.sty",
                "amssymb.sty",
                "beamercolorthemebeaver.sty",
                "beamerthememetropolis.sty",
                "geometry.sty",
                "inputenc.sty",
                "lipsum.sty",
                "xcolor.sty",
            ]
        );
    }

    #[test]
    fn reads_runfiles() {
        let db = "name foo\ncategory Package\ndocfiles size=1\n RELOC/doc/foo/README details=\"Readme\"\n\
runfiles size=2\n RELOC/tex/latex/foo/foo.sty\n RELOC/tex/latex/foo/foo-extra.sty\n\nname bar\nrunfiles size=1\n RELOC/tex/latex/bar/bar.cls\n";
        let mut seen = Vec::new();
        runfiles(db, |p, f| seen.push(format!("{p}:{f}")));
        assert_eq!(
            seen,
            ["foo:RELOC/tex/latex/foo/foo.sty", "foo:RELOC/tex/latex/foo/foo-extra.sty", "bar:RELOC/tex/latex/bar/bar.cls"]
        );
    }
}
