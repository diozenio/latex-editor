//! Git through the system `git`, so the user's own config, credential
//! helpers and SSH keys apply. For github.com, a logged-in GitHub CLI is
//! used as the credential helper (see `gh::git_credential_args`).

use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde::Serialize;

use crate::{gh, Error, Result, Workspace};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    /// "new" | "modified" | "deleted" | "renamed" | "typechange" | "conflicted"
    pub kind: String,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub remote_url: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub files: Vec<FileStatus>,
    pub merging: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub id: String,
    pub short: String,
    pub summary: String,
    pub author: String,
    pub time: i64,
    /// Reachable from a remote branch, so rewriting it would diverge.
    pub pushed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    /// "new" | "modified" | "deleted" | "typechange"
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub is_remote: bool,
    pub is_head: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum MergeOutcome {
    UpToDate,
    FastForward,
    Merged { commit: String },
    Conflicts { files: Vec<String> },
}

/// A git invocation in one project folder.
struct Git<'a> {
    dir: &'a Path,
    /// Network operations get credentials from `gh`.
    remote: bool,
}

impl Git<'_> {
    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new("git");
        if self.remote {
            c.args(gh::git_credential_args());
        }
        c.args(args)
            .current_dir(self.dir)
            .stdin(Stdio::null())
            // Never block on a prompt nobody can see; keep messages parseable.
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C");
        crate::compile::hide_console(&mut c);
        c
    }

    fn output(&self, args: &[&str]) -> Result<Output> {
        self.command(args).output().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::Git("git is not installed".into()),
            _ => e.into(),
        })
    }

    /// Run and return stdout; a non-zero exit becomes an error.
    fn run(&self, args: &[&str]) -> Result<String> {
        let out = self.output(args)?;
        if !out.status.success() {
            return Err(failure(&out));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Run and report only whether it succeeded.
    fn ok(&self, args: &[&str]) -> bool {
        self.output(args).is_ok_and(|o| o.status.success())
    }

    fn line(&self, args: &[&str]) -> Option<String> {
        self.run(args).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }
}

fn failure(out: &Output) -> Error {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let text = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
    if text.contains("terminal prompts disabled") || text.contains("Authentication failed") || text.contains("could not read Username") {
        return Error::Git("authentication failed: sign in to GitHub in Settings (or run `gh auth login`)".into());
    }
    let msg = text
        .lines()
        .map(|l| l.trim_start_matches("fatal: ").trim_start_matches("error: "))
        .filter(|l| !l.starts_with("hint:"))
        .collect::<Vec<_>>()
        .join("\n");
    Error::Git(msg)
}

fn open<'a>(dir: &'a Path) -> Result<Git<'a>> {
    // Only the project folder itself counts, never a repo further up.
    if !dir.join(".git").exists() {
        return Err(Error::Git("not a git repository".into()));
    }
    Ok(Git { dir, remote: false })
}

fn remote(dir: &Path) -> Result<Git<'_>> {
    Ok(Git { remote: true, ..open(dir)? })
}

pub fn init(ws: &Workspace, project: &str, name: &str, email: &str) -> Result<()> {
    let dir = ws.project_dir(project)?;
    Git { dir: &dir, remote: false }.run(&["init", "-q", "-b", "main"])?;
    set_identity(&open(&dir)?, name, email)
}

/// Stored in the repo's own .git/config, not ~/.gitconfig. Empty values are
/// left alone so the user's global identity applies.
pub fn set_identity_for(ws: &Workspace, project: &str, name: &str, email: &str) -> Result<()> {
    let dir = ws.project_dir(project)?;
    set_identity(&open(&dir)?, name, email)
}

fn set_identity(git: &Git, name: &str, email: &str) -> Result<()> {
    if !name.is_empty() {
        git.run(&["config", "user.name", name])?;
    }
    if !email.is_empty() {
        git.run(&["config", "user.email", email])?;
    }
    Ok(())
}

/// The identity git would use here (repo config, then global).
pub fn configured_identity(ws: &Workspace, project: &str) -> (Option<String>, Option<String>) {
    let Ok(dir) = ws.project_dir(project) else { return (None, None) };
    let git = Git { dir: &dir, remote: false };
    (git.line(&["config", "user.name"]), git.line(&["config", "user.email"]))
}

fn has_head(git: &Git) -> bool {
    git.ok(&["rev-parse", "-q", "--verify", "HEAD"])
}

fn ref_exists(git: &Git, refname: &str) -> bool {
    git.ok(&["show-ref", "--verify", "-q", refname])
}

fn head_branch(git: &Git) -> Option<String> {
    // Works on unborn branches too.
    git.line(&["symbolic-ref", "-q", "--short", "HEAD"])
}

fn ahead_behind(git: &Git, upstream: &str) -> Result<(usize, usize)> {
    let out = git.run(&["rev-list", "--left-right", "--count", &format!("HEAD...{upstream}")])?;
    let mut it = out.split_whitespace().map(|n| n.parse().unwrap_or(0));
    Ok((it.next().unwrap_or(0), it.next().unwrap_or(0)))
}

pub fn status(ws: &Workspace, project: &str) -> Result<RepoStatus> {
    let dir = ws.project_dir(project)?;
    let Ok(git) = open(&dir) else {
        return Ok(RepoStatus {
            is_repo: false,
            branch: None,
            upstream: None,
            remote_url: None,
            ahead: 0,
            behind: 0,
            files: vec![],
            merging: false,
        });
    };
    let raw = git.run(&["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
    let mut branch = None;
    let mut upstream = None;
    let (mut ahead, mut behind) = (0, 0);
    let mut files = Vec::new();
    let mut entries = raw.split('\0');
    while let Some(e) = entries.next() {
        if let Some(h) = e.strip_prefix("# branch.head ") {
            branch = Some(h.to_string()).filter(|h| h != "(detached)");
        } else if let Some(u) = e.strip_prefix("# branch.upstream ") {
            upstream = Some(u.to_string());
        } else if let Some(ab) = e.strip_prefix("# branch.ab ") {
            let mut it = ab.split(' ').map(|n| n.trim_start_matches(['+', '-']).parse().unwrap_or(0));
            (ahead, behind) = (it.next().unwrap_or(0), it.next().unwrap_or(0));
        } else if let Some(p) = e.strip_prefix("? ") {
            files.push(FileStatus { path: p.into(), kind: "new".into(), staged: false, unstaged: true });
        } else if let Some(rest) = e.strip_prefix("1 ") {
            let f: Vec<&str> = rest.splitn(8, ' ').collect();
            files.push(entry(f[0], f[7]));
        } else if let Some(rest) = e.strip_prefix("2 ") {
            let f: Vec<&str> = rest.splitn(9, ' ').collect();
            files.push(entry(f[0], f[8]));
            entries.next(); // original path
        } else if let Some(rest) = e.strip_prefix("u ") {
            let f: Vec<&str> = rest.splitn(10, ' ').collect();
            files.push(FileStatus { path: f[9].into(), kind: "conflicted".into(), staged: false, unstaged: true });
        }
    }
    files.retain(|f| !f.path.starts_with(".quilltex/build"));

    let remote_url = git.line(&["config", "--get", "remote.origin.url"]);
    if let (Some(b), None) = (&branch, &upstream) {
        let origin_ref = format!("refs/remotes/origin/{b}");
        if ref_exists(&git, &origin_ref) {
            // No tracking configured yet but origin/<branch> exists.
            upstream = Some(format!("origin/{b}"));
            (ahead, behind) = ahead_behind(&git, &format!("origin/{b}"))?;
        } else if remote_url.is_some() && has_head(&git) {
            // Branch never pushed: everything is "ahead".
            ahead = git.run(&["rev-list", "--count", "HEAD"])?.trim().parse().unwrap_or(0);
        }
    }
    Ok(RepoStatus {
        is_repo: true,
        branch,
        upstream,
        remote_url,
        ahead,
        behind,
        files,
        merging: dir.join(".git/MERGE_HEAD").exists(),
    })
}

/// One porcelain v2 changed entry; `xy` is index + worktree status.
fn entry(xy: &str, path: &str) -> FileStatus {
    let (x, y) = (xy.as_bytes()[0], xy.as_bytes()[1]);
    let has = |c: u8| x == c || y == c;
    let kind = if has(b'A') {
        "new"
    } else if has(b'D') {
        "deleted"
    } else if has(b'R') || has(b'C') {
        "renamed"
    } else if has(b'T') {
        "typechange"
    } else {
        "modified"
    };
    FileStatus { path: path.into(), kind: kind.into(), staged: x != b'.', unstaged: y != b'.' }
}

pub fn stage(ws: &Workspace, project: &str, paths: &[String]) -> Result<()> {
    for p in paths {
        ws.resolve(project, p)?;
    }
    let dir = ws.project_dir(project)?;
    let mut args = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    open(&dir)?.run(&args)?;
    Ok(())
}

pub fn stage_all(ws: &Workspace, project: &str) -> Result<()> {
    let dir = ws.project_dir(project)?;
    open(&dir)?.run(&["add", "-A"])?;
    Ok(())
}

pub fn unstage(ws: &Workspace, project: &str, paths: &[String]) -> Result<()> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    let mut args = if has_head(&git) { vec!["reset", "-q", "--"] } else { vec!["rm", "--cached", "-q", "-r", "--"] };
    args.extend(paths.iter().map(String::as_str));
    git.run(&args)?;
    Ok(())
}

/// Throw away working-tree changes for the given paths.
pub fn discard(ws: &Workspace, project: &str, paths: &[String]) -> Result<()> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    let mut tracked = Vec::new();
    for p in paths {
        ws.resolve(project, p)?;
        if git.ok(&["cat-file", "-e", &format!("HEAD:{p}")]) {
            tracked.push(p.as_str());
        } else {
            let _ = git.run(&["rm", "--cached", "-q", "--ignore-unmatch", "--", p]);
            let _ = std::fs::remove_file(dir.join(p));
        }
    }
    if !tracked.is_empty() {
        let mut args = vec!["checkout", "HEAD", "--"];
        args.extend(tracked);
        git.run(&args)?;
    }
    Ok(())
}

fn conflicted(git: &Git) -> Vec<String> {
    git.run(&["diff", "--name-only", "--diff-filter=U", "-z"])
        .unwrap_or_default()
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

/// Fallback identity so a commit never fails for lack of one.
fn identity_args(git: &Git) -> Vec<&'static str> {
    let mut args = Vec::new();
    if git.line(&["config", "user.name"]).is_none() {
        args.extend(["-c", "user.name=QuillTex"]);
    }
    if git.line(&["config", "user.email"]).is_none() {
        args.extend(["-c", "user.email=quilltex@localhost"]);
    }
    args
}

pub fn commit(ws: &Workspace, project: &str, message: &str) -> Result<String> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    if !conflicted(&git).is_empty() {
        return Err(Error::Other("resolve conflicts before committing".into()));
    }
    let merging = dir.join(".git/MERGE_HEAD").exists();
    let unborn = !has_head(&git);
    if !merging && !unborn && git.ok(&["diff", "--cached", "--quiet"]) {
        return Err(Error::Other("nothing to commit".into()));
    }
    let mut args = identity_args(&git);
    args.extend(["commit", "-q", "--no-edit", "-m", message]);
    if unborn {
        args.push("--allow-empty");
    }
    git.run(&args)?;
    Ok(git.run(&["rev-parse", "HEAD"])?.trim().to_string())
}

pub fn log(ws: &Workspace, project: &str, limit: usize) -> Result<Vec<Commit>> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    if !has_head(&git) {
        return Ok(vec![]);
    }
    let out = git.run(&["log", &format!("-n{limit}"), "--format=%H%x1f%s%x1f%an%x1f%ct%x1e"])?;
    let unpushed: std::collections::HashSet<String> = git
        .run(&["rev-list", &format!("-n{limit}"), "HEAD", "--not", "--remotes"])
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect();
    Ok(out
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            let [id, summary, author, time] = f[..] else { return None };
            Some(Commit {
                short: id[..7].to_string(),
                id: id.to_string(),
                summary: summary.to_string(),
                author: author.to_string(),
                time: time.trim().parse::<i64>().unwrap_or(0) * 1000,
                pushed: !unpushed.contains(id),
            })
        })
        .collect())
}

/// Full id of a commit, rejecting anything that isn't a plain hex id.
fn resolve_commit(git: &Git, id: &str) -> Result<String> {
    if id.len() < 4 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::NotFound(format!("commit {id}")));
    }
    git.line(&["rev-parse", "--verify", "-q", &format!("{id}^{{commit}}")])
        .ok_or_else(|| Error::NotFound(format!("commit {id}")))
}

/// Files a commit changed (against its first parent, if any).
pub fn commit_files(ws: &Workspace, project: &str, id: &str) -> Result<Vec<CommitFile>> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    let id = resolve_commit(&git, id)?;
    let out = git.run(&[
        "diff-tree", "-r", "--root", "--no-commit-id", "--name-status", "-z", "--no-renames", "-m", "--first-parent", &id,
    ])?;
    let mut parts = out.split('\0').filter(|p| !p.is_empty());
    let mut files = Vec::new();
    while let (Some(status), Some(path)) = (parts.next(), parts.next()) {
        let kind = match status.as_bytes()[0] {
            b'A' => "new",
            b'D' => "deleted",
            b'T' => "typechange",
            _ => "modified",
        };
        files.push(CommitFile { path: path.into(), kind: kind.into() });
    }
    Ok(files)
}

/// Unified diff of one file in a commit.
pub fn commit_diff(ws: &Workspace, project: &str, id: &str, path: &str) -> Result<String> {
    ws.resolve(project, path)?;
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    let id = resolve_commit(&git, id)?;
    git.run(&["show", "--format=", "--no-color", "--no-ext-diff", "-m", "--first-parent", &id, "--", path])
}

/// Unified diff of the working tree vs HEAD for a single file.
pub fn diff_file(ws: &Workspace, project: &str, path: &str) -> Result<String> {
    ws.resolve(project, path)?;
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    let in_head = git.ok(&["cat-file", "-e", &format!("HEAD:{path}")]);
    let out = if in_head {
        git.output(&["diff", "--no-color", "--no-ext-diff", "HEAD", "--", path])?
    } else {
        // New file: show its whole content as added. Exit code 1 = "differs".
        git.output(&["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", path])?
    };
    if out.status.code().is_some_and(|c| c > 1) {
        return Err(failure(&out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn branches(ws: &Workspace, project: &str) -> Result<Vec<Branch>> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    let out = git.run(&["for-each-ref", "--format=%(HEAD)%(refname)", "refs/heads", "refs/remotes"])?;
    let mut list = Vec::new();
    for line in out.lines() {
        let (is_head, refname) = (line.starts_with('*'), &line[1..]);
        let (name, is_remote) = match refname.strip_prefix("refs/heads/") {
            Some(n) => (n, false),
            None => (refname.trim_start_matches("refs/remotes/"), true),
        };
        if name.ends_with("/HEAD") {
            continue;
        }
        list.push(Branch { name: name.into(), is_remote, is_head });
    }
    if list.is_empty() {
        if let Some(b) = head_branch(&git) {
            list.push(Branch { name: b, is_remote: false, is_head: true });
        }
    }
    Ok(list)
}

pub fn create_branch(ws: &Workspace, project: &str, name: &str, checkout: bool) -> Result<()> {
    let dir = ws.project_dir(project)?;
    open(&dir)?.run(&["branch", "--", name])?;
    if checkout {
        checkout_branch(ws, project, name)?;
    }
    Ok(())
}

/// Switch branches. A remote branch name (origin/x) creates a tracking
/// local branch.
pub fn checkout_branch(ws: &Workspace, project: &str, name: &str) -> Result<()> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    let local = if ref_exists(&git, &format!("refs/heads/{name}")) {
        name.to_string()
    } else if ref_exists(&git, &format!("refs/remotes/{name}")) {
        let short = name.split_once('/').map(|(_, b)| b).unwrap_or(name).to_string();
        if !ref_exists(&git, &format!("refs/heads/{short}")) {
            git.run(&["branch", "--track", "--", &short, name])?;
        }
        short
    } else {
        return Err(Error::NotFound(format!("branch {name}")));
    };
    git.run(&["switch", "-q", "--", &local])
        .map_err(|e| Error::Other(format!("cannot switch branch: {e}. Commit or discard your changes first.")))?;
    Ok(())
}

pub fn delete_branch(ws: &Workspace, project: &str, name: &str) -> Result<()> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    if head_branch(&git).as_deref() == Some(name) {
        return Err(Error::Other("cannot delete the current branch".into()));
    }
    git.run(&["branch", "-D", "--", name])?;
    Ok(())
}

/// Merge `from` (local or remote-tracking branch) into HEAD.
pub fn merge(ws: &Workspace, project: &str, from: &str) -> Result<MergeOutcome> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    let theirs = [format!("refs/heads/{from}"), format!("refs/remotes/{from}")]
        .into_iter()
        .find(|r| ref_exists(&git, r))
        .ok_or_else(|| Error::NotFound(format!("branch {from}")))?;
    merge_ref(&git, &theirs, from)
}

fn merge_ref(git: &Git, theirs: &str, label: &str) -> Result<MergeOutcome> {
    let unborn = !has_head(git);
    if !unborn && git.ok(&["merge-base", "--is-ancestor", theirs, "HEAD"]) {
        return Ok(MergeOutcome::UpToDate);
    }
    let fast_forward = unborn || git.ok(&["merge-base", "--is-ancestor", "HEAD", theirs]);
    let message = format!("Merge {label}");
    let out = git.output(&["merge", "--ff", "--no-edit", "-m", &message, theirs])?;
    if !out.status.success() {
        let files = conflicted(git);
        if !files.is_empty() {
            return Ok(MergeOutcome::Conflicts { files });
        }
        return Err(Error::Other(format!("{}. Commit or discard your local changes first.", failure(&out))));
    }
    if fast_forward {
        return Ok(MergeOutcome::FastForward);
    }
    Ok(MergeOutcome::Merged { commit: git.run(&["rev-parse", "HEAD"])?.trim().to_string() })
}

/// Mark a conflicted file as resolved (stage its current content).
pub fn resolve(ws: &Workspace, project: &str, path: &str) -> Result<()> {
    let text = std::fs::read_to_string(ws.resolve(project, path)?).unwrap_or_default();
    if text.contains("<<<<<<<") && text.contains(">>>>>>>") {
        return Err(Error::Other(format!("{path} still has conflict markers")));
    }
    stage(ws, project, &[path.to_string()])
}

pub fn abort_merge(ws: &Workspace, project: &str) -> Result<()> {
    let dir = ws.project_dir(project)?;
    open(&dir)?.run(&["reset", "-q", "--hard", "HEAD"])?;
    Ok(())
}

pub fn set_remote(ws: &Workspace, project: &str, url: &str) -> Result<()> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    if git.line(&["config", "--get", "remote.origin.url"]).is_some() {
        git.run(&["remote", "set-url", "origin", url])?;
    } else {
        git.run(&["remote", "add", "origin", url])?;
    }
    Ok(())
}

fn require_origin(git: &Git) -> Result<()> {
    match git.line(&["config", "--get", "remote.origin.url"]) {
        Some(_) => Ok(()),
        None => Err(Error::Other("no remote configured".into())),
    }
}

pub fn fetch(ws: &Workspace, project: &str) -> Result<()> {
    let dir = ws.project_dir(project)?;
    let git = remote(&dir)?;
    require_origin(&git)?;
    git.run(&["fetch", "-q", "--prune", "origin"])?;
    Ok(())
}

/// Fetch + merge origin/<branch> into the current branch.
pub fn pull(ws: &Workspace, project: &str) -> Result<MergeOutcome> {
    fetch(ws, project)?;
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    let branch = head_branch(&git).ok_or_else(|| Error::Other("detached HEAD".into()))?;
    let remote_ref = format!("refs/remotes/origin/{branch}");
    if !ref_exists(&git, &remote_ref) {
        return Ok(MergeOutcome::UpToDate);
    }
    let out = merge_ref(&git, &remote_ref, &format!("origin/{branch}"))?;
    ensure_upstream(&git, &branch);
    Ok(out)
}

pub fn push(ws: &Workspace, project: &str) -> Result<()> {
    let dir = ws.project_dir(project)?;
    let git = remote(&dir)?;
    require_origin(&git)?;
    let branch = head_branch(&git).ok_or_else(|| Error::Other("detached HEAD".into()))?;
    let out = git.output(&["push", "-q", "--porcelain", "origin", &format!("refs/heads/{branch}:refs/heads/{branch}")])?;
    if !out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        if let Some(line) = stdout.lines().find(|l| l.starts_with('!')) {
            let reason = line.rsplit('\t').next().unwrap_or("rejected").trim();
            return Err(Error::Other(format!("push rejected ({reason}). Pull first.")));
        }
        return Err(failure(&out));
    }
    ensure_upstream(&git, &branch);
    Ok(())
}

fn ensure_upstream(git: &Git, branch: &str) {
    let has_upstream = git.ok(&["rev-parse", "-q", "--verify", &format!("{branch}@{{upstream}}")]);
    if !has_upstream && ref_exists(git, &format!("refs/remotes/origin/{branch}")) {
        let _ = git.run(&["branch", "-q", &format!("--set-upstream-to=origin/{branch}"), branch]);
    }
}

/// Clone into a new project folder.
pub fn clone(ws: &Workspace, url: &str, project: &str) -> Result<()> {
    let dir = ws.project_dir(project)?;
    if dir.exists() {
        return Err(Error::AlreadyExists(project.into()));
    }
    let target = dir.display().to_string();
    let res = Git { dir: ws.root(), remote: true }.run(&["clone", "-q", "--", url, &target]);
    if let Err(e) = res {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Workspace) {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path().join("ws")).unwrap();
        (tmp, ws)
    }

    #[test]
    fn commit_branch_merge_conflict() {
        let (_t, ws) = setup();
        crate::project::create(&ws, "p", "blank").unwrap();
        init(&ws, "p", "Tester", "t@example.com").unwrap();
        assert_eq!(status(&ws, "p").unwrap().branch.as_deref(), Some("main"));
        stage_all(&ws, "p").unwrap();
        commit(&ws, "p", "init").unwrap();

        create_branch(&ws, "p", "feature", true).unwrap();
        crate::files::write_text(&ws, "p", "main.tex", "feature\n").unwrap();
        stage_all(&ws, "p").unwrap();
        commit(&ws, "p", "feature change").unwrap();

        checkout_branch(&ws, "p", "main").unwrap();
        crate::files::write_text(&ws, "p", "main.tex", "main\n").unwrap();
        stage_all(&ws, "p").unwrap();
        commit(&ws, "p", "main change").unwrap();

        match merge(&ws, "p", "feature").unwrap() {
            MergeOutcome::Conflicts { files } => assert_eq!(files, vec!["main.tex"]),
            o => panic!("expected conflict, got {o:?}"),
        }
        let s = status(&ws, "p").unwrap();
        assert!(s.merging);
        assert!(s.files.iter().any(|f| f.path == "main.tex" && f.kind == "conflicted"));
        assert!(resolve(&ws, "p", "main.tex").is_err());
        crate::files::write_text(&ws, "p", "main.tex", "both\n").unwrap();
        resolve(&ws, "p", "main.tex").unwrap();
        commit(&ws, "p", "merge").unwrap();
        assert!(!status(&ws, "p").unwrap().merging);
        assert_eq!(log(&ws, "p", 10).unwrap().len(), 4);
        assert!(branches(&ws, "p").unwrap().iter().any(|b| b.name == "main" && b.is_head));
    }

    #[test]
    fn stage_unstage_discard_diff() {
        let (_t, ws) = setup();
        crate::project::create(&ws, "p", "blank").unwrap();
        init(&ws, "p", "T", "t@x").unwrap();
        stage_all(&ws, "p").unwrap();
        commit(&ws, "p", "init").unwrap();
        assert!(commit(&ws, "p", "again").is_err());

        crate::files::write_text(&ws, "p", "main.tex", "changed\n").unwrap();
        crate::files::write_text(&ws, "p", "new file.tex", "x\n").unwrap();
        let s = status(&ws, "p").unwrap();
        assert!(s.files.iter().any(|f| f.path == "main.tex" && f.kind == "modified" && f.unstaged && !f.staged));
        assert!(s.files.iter().any(|f| f.path == "new file.tex" && f.kind == "new"));
        assert!(diff_file(&ws, "p", "main.tex").unwrap().contains("+changed"));
        assert!(diff_file(&ws, "p", "new file.tex").unwrap().contains("+x"));

        stage(&ws, "p", &["main.tex".into()]).unwrap();
        assert!(status(&ws, "p").unwrap().files.iter().any(|f| f.path == "main.tex" && f.staged));
        unstage(&ws, "p", &["main.tex".into()]).unwrap();
        discard(&ws, "p", &["main.tex".into(), "new file.tex".into()]).unwrap();
        assert!(status(&ws, "p").unwrap().files.is_empty());
    }

    #[test]
    fn push_pull_ahead_behind() {
        let (tmp, ws) = setup();
        let bare = tmp.path().join("remote.git");
        Git { dir: tmp.path(), remote: false }
            .run(&["init", "-q", "--bare", "-b", "main", &bare.display().to_string()])
            .unwrap();
        let url = bare.to_string_lossy().to_string();

        crate::project::create(&ws, "a", "blank").unwrap();
        init(&ws, "a", "A", "a@x").unwrap();
        stage_all(&ws, "a").unwrap();
        commit(&ws, "a", "init").unwrap();
        set_remote(&ws, "a", &url).unwrap();
        assert_eq!(status(&ws, "a").unwrap().ahead, 1);
        push(&ws, "a").unwrap();
        let s = status(&ws, "a").unwrap();
        assert_eq!((s.ahead, s.behind), (0, 0));
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));

        clone(&ws, &url, "b").unwrap();
        set_identity_for(&ws, "b", "B", "b@x").unwrap();
        crate::files::write_text(&ws, "b", "new.tex", "x").unwrap();
        stage_all(&ws, "b").unwrap();
        commit(&ws, "b", "from b").unwrap();
        push(&ws, "b").unwrap();

        fetch(&ws, "a").unwrap();
        assert_eq!(status(&ws, "a").unwrap().behind, 1);
        assert!(matches!(pull(&ws, "a").unwrap(), MergeOutcome::FastForward));
        assert!(ws.root().join("a/new.tex").exists());
        assert_eq!(status(&ws, "a").unwrap().behind, 0);
    }
}

// ---------- rewriting history ----------

/// History actions start from a tree with no uncommitted work to lose.
fn require_clean(git: &Git, dir: &Path) -> Result<()> {
    if dir.join(".git/MERGE_HEAD").exists() {
        return Err(Error::Other("finish or abort the merge first".into()));
    }
    if !git.ok(&["diff-index", "--quiet", "HEAD", "--"]) {
        return Err(Error::Other("commit or discard your changes first".into()));
    }
    Ok(())
}

fn is_pushed(git: &Git, commit: &str) -> bool {
    git.line(&["branch", "-r", "--contains", commit]).is_some()
}

/// A commit that is in HEAD's history.
fn resolve_in_history(git: &Git, id: &str) -> Result<String> {
    let id = resolve_commit(git, id)?;
    if !git.ok(&["merge-base", "--is-ancestor", &id, "HEAD"]) {
        return Err(Error::Other("that commit is not in the current branch".into()));
    }
    Ok(id)
}

/// Make the files match an earlier commit and record that as a new commit,
/// so nothing is lost from the history.
pub fn restore_version(ws: &Workspace, project: &str, id: &str) -> Result<String> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    require_clean(&git, &dir)?;
    let id = resolve_commit(&git, id)?;
    git.run(&["read-tree", "--reset", "-u", &id])?;
    if git.ok(&["diff", "--cached", "--quiet"]) {
        return Err(Error::Other("the project already matches this version".into()));
    }
    commit(ws, project, &format!("Restore version {}", &id[..7]))
}

/// Add a commit that undoes the given one.
pub fn revert_commit(ws: &Workspace, project: &str, id: &str) -> Result<String> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    require_clean(&git, &dir)?;
    let id = resolve_in_history(&git, id)?;
    let mut args = identity_args(&git);
    args.extend(["revert", "--no-edit"]);
    if git.line(&["rev-list", "--parents", "-n1", &id]).is_some_and(|l| l.split(' ').count() > 2) {
        args.extend(["-m", "1"]);
    }
    args.push(&id);
    if let Err(e) = git.run(&args) {
        let _ = git.run(&["revert", "--abort"]);
        return Err(Error::Other(format!("cannot undo this commit cleanly, later changes conflict with it ({e})")));
    }
    Ok(git.run(&["rev-parse", "HEAD"])?.trim().to_string())
}

/// Move the branch back to a commit, dropping everything after it.
pub fn reset_to(ws: &Workspace, project: &str, id: &str) -> Result<()> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    require_clean(&git, &dir)?;
    let id = resolve_in_history(&git, id)?;
    let newer = git.run(&["rev-list", "--reverse", &format!("{id}..HEAD")])?;
    let Some(oldest) = newer.lines().next() else {
        return Err(Error::Other("already at this commit".into()));
    };
    if is_pushed(&git, oldest) {
        return Err(Error::Other("later commits were already pushed; rewriting them would diverge from the remote".into()));
    }
    git.run(&["reset", "-q", "--hard", &id])?;
    Ok(())
}

/// Remove one commit, replaying the later ones on top of its parent.
pub fn delete_commit(ws: &Workspace, project: &str, id: &str) -> Result<()> {
    let dir = ws.project_dir(project)?;
    let git = open(&dir)?;
    require_clean(&git, &dir)?;
    let id = resolve_in_history(&git, id)?;
    let parents = git.run(&["rev-list", "--parents", "-n1", &id])?;
    match parents.split_whitespace().count() {
        1 => return Err(Error::Other("the first commit cannot be deleted".into())),
        2 => {}
        _ => return Err(Error::Other("merge commits cannot be deleted".into())),
    }
    if !git.run(&["rev-list", "--merges", &format!("{id}..HEAD")])?.trim().is_empty() {
        return Err(Error::Other("a merge commit comes after this one, so it cannot be removed safely".into()));
    }
    if is_pushed(&git, &id) {
        return Err(Error::Other("this commit was already pushed; rewriting it would diverge from the remote. Undo it instead".into()));
    }
    let parent = format!("{id}^");
    if git.line(&["rev-parse", "HEAD"]).as_deref() == Some(id.as_str()) {
        git.run(&["reset", "-q", "--hard", &parent])?;
        return Ok(());
    }
    let mut args = identity_args(&git);
    args.extend(["rebase", "-q", "--onto", &parent, &id]);
    if let Err(e) = git.run(&args) {
        let _ = git.run(&["rebase", "--abort"]);
        return Err(Error::Other(format!("later commits depend on this one and conflict without it ({e})")));
    }
    Ok(())
}

#[cfg(test)]
mod history_tests {
    use super::*;
    use crate::files::write_text;

    /// Project "p" with commits c1..c4, each adding fN.txt; returns ids newest first.
    fn history() -> (tempfile::TempDir, Workspace, Vec<String>) {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(tmp.path()).unwrap();
        crate::project::create(&ws, "p", "blank").unwrap();
        init(&ws, "p", "t", "t@t").unwrap();
        for i in 1..=4 {
            write_text(&ws, "p", &format!("f{i}.txt"), &i.to_string()).unwrap();
            stage_all(&ws, "p").unwrap();
            commit(&ws, "p", &format!("c{i}")).unwrap();
        }
        let ids = log(&ws, "p", 10).unwrap().into_iter().map(|c| c.id).collect();
        (tmp, ws, ids)
    }

    fn summaries(ws: &Workspace) -> Vec<String> {
        log(ws, "p", 10).unwrap().into_iter().map(|c| c.summary).collect()
    }

    #[test]
    fn lists_commit_files() {
        let (_t, ws, ids) = history();
        let files = commit_files(&ws, "p", &ids[1]).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].path.as_str(), files[0].kind.as_str()), ("f3.txt", "new") as (&str, &str));
        assert!(commit_diff(&ws, "p", &ids[1], "f3.txt").unwrap().contains("+3"));
        assert!(commit_files(&ws, "p", "--oops").is_err());
    }

    #[test]
    fn restore_keeps_history() {
        let (_t, ws, ids) = history();
        restore_version(&ws, "p", &ids[2]).unwrap();
        let dir = ws.project_dir("p").unwrap();
        assert!(dir.join("f2.txt").exists() && !dir.join("f3.txt").exists());
        assert_eq!(summaries(&ws).len(), 5);
        assert!(restore_version(&ws, "p", &ids[2]).is_err()); // already there
    }

    #[test]
    fn delete_middle_and_head() {
        let (_t, ws, ids) = history();
        delete_commit(&ws, "p", &ids[1]).unwrap(); // c3
        assert_eq!(summaries(&ws)[..3], ["c4", "c2", "c1"].map(String::from));
        assert!(!ws.project_dir("p").unwrap().join("f3.txt").exists());
        let head = log(&ws, "p", 1).unwrap().remove(0).id;
        delete_commit(&ws, "p", &head).unwrap();
        assert_eq!(summaries(&ws)[0], "c2");
        let root = log(&ws, "p", 10).unwrap().pop().unwrap().id;
        assert!(delete_commit(&ws, "p", &root).is_err());
    }

    #[test]
    fn reset_and_revert() {
        let (_t, ws, ids) = history();
        revert_commit(&ws, "p", &ids[2]).unwrap(); // undo c2
        assert!(!ws.project_dir("p").unwrap().join("f2.txt").exists());
        reset_to(&ws, "p", &ids[2]).unwrap();
        assert_eq!(summaries(&ws)[0], "c2");
        assert!(reset_to(&ws, "p", &ids[2]).is_err());
    }

    #[test]
    fn refuses_with_uncommitted_changes() {
        let (_t, ws, ids) = history();
        write_text(&ws, "p", "f1.txt", "edited").unwrap();
        assert!(delete_commit(&ws, "p", &ids[1]).is_err());
        assert!(reset_to(&ws, "p", &ids[2]).is_err());
        assert!(restore_version(&ws, "p", &ids[2]).is_err());
    }
}
