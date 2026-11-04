import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  GitBranch,
  GitMerge,
  Github,
  Link2,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  AlertTriangle,
  FileDiff,
  MoreHorizontal,
} from "lucide-react";
import { api, type Branch, type Commit, type FileStatus, type MergeOutcome } from "@/lib/ipc";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import { basename, mod, timeAgo } from "@/lib/format";
import { ContextMenu, Dropdown, type MenuEntry } from "./ui/Menu";
import { commitMenu } from "./commitMenu";
import { SyncBadge } from "./SyncBadge";

export function describeMerge(o: MergeOutcome): string {
  switch (o.type) {
    case "UpToDate":
      return "Already up to date";
    case "FastForward":
      return "Updated (fast-forward)";
    case "Merged":
      return "Merged successfully";
    case "Conflicts":
      return `Merge has conflicts in ${o.files.length} file(s). Resolve them, then commit.`;
  }
}

export function GitPanel() {
  const { project, git, refreshGit, openFile } = useProject();
  const app = useApp();
  const sync = useApp((s) => (project ? s.sync[project.name] : undefined));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [log, setLog] = useState<Commit[]>([]);

  const name = project?.name ?? "";

  useEffect(() => {
    if (!name || !git?.isRepo) return;
    api.gitBranches(name).then(setBranches).catch(() => {});
    api.gitLog(name).then(setLog).catch(() => {});
  }, [name, git]);

  if (!project) return null;

  const act = async (label: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    try {
      const out = await fn();
      if (out && typeof out === "object" && "type" in (out as MergeOutcome)) {
        const o = out as MergeOutcome;
        app.toast(describeMerge(o), o.type === "Conflicts" ? "error" : "success");
      } else if (success) app.toast(success, "success");
    } catch (e) {
      app.fail(e);
    } finally {
      setBusy(null);
      await refreshGit();
      await useProject.getState().refreshTree();
    }
  };

  if (!git?.isRepo) {
    return (
      <div className="empty" style={{ padding: "32px 12px" }}>
        <div className="empty-icon">
          <GitBranch size={20} />
        </div>
        <h3>Version control</h3>
        <p>Track every change with Git, then sync with GitHub. Everything stays inside this project folder.</p>
        <button className="btn primary" onClick={() => act("init", () => api.gitInit(name), "Repository created")}>
          Initialize repository
        </button>
      </div>
    );
  }

  const staged = git.files.filter((f) => f.staged);
  const unstaged = git.files.filter((f) => f.unstaged);
  const conflicted = git.files.filter((f) => f.kind === "conflicted");
  const local = branches.filter((b) => !b.isRemote);
  const remote = branches.filter((b) => b.isRemote && !local.some((l) => `origin/${l.name}` === b.name));

  const commit = () => {
    const msg = message.trim();
    if (!msg) return;
    void act(
      "commit",
      async () => {
        if (!staged.length) await api.gitStageAll(name);
        await api.gitCommit(name, msg);
        setMessage("");
      },
      "Committed",
    );
  };

  const branchItems: MenuEntry[] = [
    { heading: "Switch branch" },
    ...local.map((b) => ({
      label: b.name,
      icon: <GitBranch size={14} />,
      right: b.isHead ? <Check size={13} /> : undefined,
      action: b.isHead
        ? undefined
        : {
            icon: <Trash2 size={13} />,
            label: `Delete ${b.name}`,
            danger: true,
            onClick: () =>
              app.openDialog({
                kind: "confirm",
                title: `Delete branch “${b.name}”?`,
                message: "Commits that only exist on this branch will no longer be reachable.",
                danger: true,
                confirm: "Delete",
                onConfirm: () => act("delete", () => api.gitDeleteBranch(name, b.name)),
              }),
          },
      onSelect: () => !b.isHead && act("checkout", () => api.gitCheckout(name, b.name), `Switched to ${b.name}`),
    })),
    ...(remote.length ? [{ heading: "Remote" } as MenuEntry] : []),
    ...remote.map((b) => ({
      label: b.name,
      icon: <Github size={14} />,
      onSelect: () => act("checkout", () => api.gitCheckout(name, b.name), `Checked out ${b.name}`),
    })),
    { separator: true },
    {
      label: "New branch…",
      icon: <Plus size={14} />,
      onSelect: () =>
        app.openDialog({
          kind: "prompt",
          title: "New branch",
          label: `Created from ${git.branch ?? "HEAD"} and checked out`,
          confirm: "Create",
          onSubmit: (b) => act("branch", () => api.gitCreateBranch(name, b.replace(/\s+/g, "-")), `On ${b}`),
        }),
    },
    { label: "Merge into current…", icon: <GitMerge size={14} />, onSelect: () => app.openDialog({ kind: "merge", project: name }) },
  ];

  return (
    <div className="git-panel">
      <div className="row" style={{ padding: "4px 2px 0" }}>
        <Dropdown
          items={branchItems}
          trigger={
            <button className="btn sm" style={{ maxWidth: 150 }}>
              <GitBranch size={13} />
              <span className="ellipsis">{git.branch ?? "detached"}</span>
              <ChevronDown size={12} />
            </button>
          }
        />
        <div className="grow" />
        <SyncBadge status={git} error={sync?.error} checkedAt={sync?.checkedAt} busy={busy === "fetch"} compact />
      </div>

      {git.remoteUrl ? (
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm grow" disabled={!!busy} onClick={() => act("pull", () => api.gitPull(name))}>
            {busy === "pull" ? <Loader2 size={13} className="spin" /> : <ArrowDown size={13} />} Pull
            {git.behind > 0 && <span className="count" style={{ height: 16 }}>{git.behind}</span>}
          </button>
          <button className="btn sm grow" disabled={!!busy} onClick={() => act("push", () => api.gitPush(name), "Pushed")}>
            {busy === "push" ? <Loader2 size={13} className="spin" /> : <ArrowUp size={13} />} Push
            {git.ahead > 0 && <span className="count" style={{ height: 16 }}>{git.ahead}</span>}
          </button>
          <button className="icon-btn framed" title="Fetch" disabled={!!busy} onClick={() => act("fetch", () => api.gitFetch(name))}>
            <RefreshCw size={13} className={busy === "fetch" ? "spin" : ""} />
          </button>
        </div>
      ) : (
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm grow" onClick={() => app.openDialog({ kind: "publish", project: name })}>
            <Github size={13} /> Publish to GitHub
          </button>
          <button
            className="icon-btn framed"
            title="Add remote URL"
            onClick={() =>
              app.openDialog({
                kind: "prompt",
                title: "Link a remote repository",
                label: "HTTPS URL, e.g. https://github.com/you/thesis.git",
                confirm: "Link",
                onSubmit: (url) => act("remote", () => api.gitSetRemote(name, url), "Remote linked"),
              })
            }
          >
            <Link2 size={13} />
          </button>
        </div>
      )}

      {git.merging && (
        <div className="banner orange">
          <AlertTriangle size={14} style={{ color: "var(--orange)", flex: "none", marginTop: 1 }} />
          <div className="grow">
            <div style={{ fontWeight: 600 }}>Merge in progress</div>
            <div className="muted">
              {conflicted.length
                ? "Fix the conflict markers, then mark each file resolved."
                : "All conflicts resolved. Commit to finish the merge."}
            </div>
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => act("abort", () => api.gitAbortMerge(name), "Merge aborted")}>
              Abort merge
            </button>
          </div>
        </div>
      )}

      <div className="chat-box" style={{ padding: "6px 6px 6px 10px", marginTop: 2 }}>
        <textarea
          rows={2}
          placeholder={`Commit message (${mod}↵)`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
          }}
        />
        <div className="row">
          <span className="ctx">
            {staged.length ? `${staged.length} staged` : git.files.length ? "All changes will be committed" : "No changes"}
          </span>
          <button className="btn sm primary" disabled={!message.trim() || !git.files.length || !!busy || conflicted.length > 0} onClick={commit}>
            {busy === "commit" ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Commit
          </button>
        </div>
      </div>

      {staged.length > 0 && (
        <FileGroup
          title="Staged"
          files={staged}
          onOpen={(f) => app.openDialog({ kind: "diff", project: name, path: f.path })}
          actions={(f) => (
            <button className="icon-btn sm" title="Unstage" onClick={() => act("unstage", () => api.gitUnstage(name, [f.path]))}>
              <Minus size={13} />
            </button>
          )}
          headerAction={
            <button className="icon-btn sm" title="Unstage all" onClick={() => act("unstage", () => api.gitUnstage(name, staged.map((f) => f.path)))}>
              <Minus size={13} />
            </button>
          }
        />
      )}
      <FileGroup
        title="Changes"
        files={unstaged}
        empty="Working tree clean"
        onOpen={(f) =>
          f.kind === "conflicted" ? openFile(f.path) : app.openDialog({ kind: "diff", project: name, path: f.path })
        }
        actions={(f) => (
          <>
            {f.kind === "conflicted" ? (
              <button className="icon-btn sm" title="Mark resolved" onClick={() => act("resolve", () => api.gitResolve(name, f.path), "Marked resolved")}>
                <Check size={13} />
              </button>
            ) : (
              <>
                <button className="icon-btn sm" title="Open file" onClick={() => openFile(f.path)}>
                  <FileDiff size={13} />
                </button>
                <button
                  className="icon-btn sm"
                  title="Discard changes"
                  onClick={() =>
                    app.openDialog({
                      kind: "confirm",
                      title: `Discard changes to ${basename(f.path)}?`,
                      message: f.kind === "new" ? "This new file will be deleted." : "Your edits since the last commit will be lost.",
                      danger: true,
                      confirm: "Discard",
                      onConfirm: () => act("discard", () => api.gitDiscard(name, [f.path])),
                    })
                  }
                >
                  <RotateCcw size={13} />
                </button>
                <button className="icon-btn sm" title="Stage" onClick={() => act("stage", () => api.gitStage(name, [f.path]))}>
                  <Plus size={13} />
                </button>
              </>
            )}
          </>
        )}
        headerAction={
          unstaged.length > 0 ? (
            <button className="icon-btn sm" title="Stage all" onClick={() => act("stage", () => api.gitStageAll(name))}>
              <Plus size={13} />
            </button>
          ) : undefined
        }
      />

      <div className="section-label" style={{ paddingLeft: 6 }}>
        <span>History</span>
      </div>
      <div>
        {log.slice(0, 40).map((c, i) => (
          <ContextMenu key={c.id} items={commitMenu(name, c, i === 0)}>
            <div
              className="commit-row"
              style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
              title={`${c.id}\n${c.author}`}
              onClick={() => app.openDialog({ kind: "commit", project: name, commit: c })}
            >
              <div className="top">
                <span className="summary">{c.summary}</span>
                <span className="acts" onClick={(e) => e.stopPropagation()}>
                  <Dropdown
                    align="end"
                    items={commitMenu(name, c, i === 0)}
                    trigger={
                      <button className="icon-btn sm" title="Actions">
                        <MoreHorizontal size={13} />
                      </button>
                    }
                  />
                </span>
              </div>
              <span className="meta">
                <span className="mono">{c.short}</span> · {c.author} · {timeAgo(c.time)}
              </span>
            </div>
          </ContextMenu>
        ))}
        {!log.length && <div className="muted" style={{ padding: "4px 8px" }}>No commits yet</div>}
      </div>
    </div>
  );
}

function FileGroup({
  title,
  files,
  empty,
  actions,
  onOpen,
  headerAction,
}: {
  title: string;
  files: FileStatus[];
  empty?: string;
  actions: (f: FileStatus) => JSX.Element;
  onOpen: (f: FileStatus) => void;
  headerAction?: JSX.Element;
}) {
  return (
    <div>
      <div className="section-label" style={{ paddingLeft: 6 }}>
        <span>
          {title} {files.length > 0 && <span className="count" style={{ marginLeft: 4 }}>{files.length}</span>}
        </span>
        {headerAction}
      </div>
      {files.length === 0 && empty && <div className="muted" style={{ padding: "2px 8px" }}>{empty}</div>}
      {files.map((f) => (
        <div key={f.path} className="git-file" onClick={() => onOpen(f)}>
          <span className={`kind ${f.kind}`}>{{ new: "A", modified: "M", deleted: "D", renamed: "R", typechange: "T", conflicted: "!" }[f.kind]}</span>
          <span className="name" title={f.path}>
            &lrm;{f.path}
          </span>
          <span className="acts" onClick={(e) => e.stopPropagation()}>
            {actions(f)}
          </span>
        </div>
      ))}
    </div>
  );
}
