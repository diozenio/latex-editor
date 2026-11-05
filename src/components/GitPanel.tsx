import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  FileDiff,
  GitBranch,
  Github,
  GitMerge,
  Link2,
  Loader2,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { basename, timeAgo } from "@/lib/format";
import { t, useT } from "@/lib/i18n";
import { api, type Branch, type Commit, type FileStatus, type MergeOutcome } from "@/lib/ipc";
import { matches, useShortcut } from "@/lib/keybinds";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import { commitMenu } from "./commitMenu";
import { SyncBadge } from "./SyncBadge";
import { ContextMenu, Dropdown, type MenuEntry } from "./ui/Menu";

export function describeMerge(o: MergeOutcome): string {
  switch (o.type) {
    case "UpToDate":
      return t("git.merge.upToDate");
    case "FastForward":
      return t("git.merge.fastForward");
    case "Merged":
      return t("git.merge.merged");
    case "Conflicts":
      return t("git.merge.conflicts", { count: o.files.length });
  }
}

export function GitPanel() {
  const t = useT();
  const kCommit = useShortcut("git-commit");
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
        <h3>{t("git.versionControl")}</h3>
        <p>{t("git.intro")}</p>
        <button className="btn primary" onClick={() => act("init", () => api.gitInit(name), t("git.repoCreated"))}>
          {t("git.init")}
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
      t("git.committed"),
    );
  };

  const branchItems: MenuEntry[] = [
    { heading: t("git.switchBranch") },
    ...local.map((b) => ({
      label: b.name,
      icon: <GitBranch size={14} />,
      right: b.isHead ? <Check size={13} /> : undefined,
      action: b.isHead
        ? undefined
        : {
            icon: <Trash2 size={13} />,
            label: t("git.deleteBranch", { name: b.name }),
            danger: true,
            onClick: () =>
              app.openDialog({
                kind: "confirm",
                title: t("git.deleteBranchTitle", { name: b.name }),
                message: t("git.deleteBranchMessage"),
                danger: true,
                confirm: t("common.delete"),
                onConfirm: () => act("delete", () => api.gitDeleteBranch(name, b.name)),
              }),
          },
      onSelect: () => !b.isHead && act("checkout", () => api.gitCheckout(name, b.name), t("git.switchedTo", { name: b.name })),
    })),
    ...(remote.length ? [{ heading: t("git.remote") } as MenuEntry] : []),
    ...remote.map((b) => ({
      label: b.name,
      icon: <Github size={14} />,
      onSelect: () => act("checkout", () => api.gitCheckout(name, b.name), t("git.checkedOut", { name: b.name })),
    })),
    { separator: true },
    {
      label: t("git.newBranchEllipsis"),
      icon: <Plus size={14} />,
      onSelect: () =>
        app.openDialog({
          kind: "prompt",
          title: t("git.newBranch"),
          label: t("git.newBranchLabel", { from: git.branch ?? "HEAD" }),
          confirm: t("common.create"),
          onSubmit: (b) => act("branch", () => api.gitCreateBranch(name, b.replace(/\s+/g, "-")), t("git.onBranch", { name: b })),
        }),
    },
    { label: t("git.mergeIntoCurrent"), icon: <GitMerge size={14} />, onSelect: () => app.openDialog({ kind: "merge", project: name }) },
  ];

  return (
    <div className="git-panel">
      <div className="row" style={{ padding: "4px 2px 0" }}>
        <Dropdown
          items={branchItems}
          trigger={
            <button className="btn sm" style={{ maxWidth: 150 }}>
              <GitBranch size={13} />
              <span className="ellipsis">{git.branch ?? t("git.detached")}</span>
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
            {busy === "pull" ? <Loader2 size={13} className="spin" /> : <ArrowDown size={13} />} {t("git.pull")}
            {git.behind > 0 && <span className="count" style={{ height: 16 }}>{git.behind}</span>}
          </button>
          <button className="btn sm grow" disabled={!!busy} onClick={() => act("push", () => api.gitPush(name), t("git.pushed"))}>
            {busy === "push" ? <Loader2 size={13} className="spin" /> : <ArrowUp size={13} />} {t("git.push")}
            {git.ahead > 0 && <span className="count" style={{ height: 16 }}>{git.ahead}</span>}
          </button>
          <button className="icon-btn framed" title={t("git.fetch")} disabled={!!busy} onClick={() => act("fetch", () => api.gitFetch(name))}>
            <RefreshCw size={13} className={busy === "fetch" ? "spin" : ""} />
          </button>
        </div>
      ) : (
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm grow" onClick={() => app.openDialog({ kind: "publish", project: name })}>
            <Github size={13} /> {t("common.publishToGithub")}
          </button>
          <button
            className="icon-btn framed"
            title={t("git.addRemote")}
            onClick={() =>
              app.openDialog({
                kind: "prompt",
                title: t("git.linkRemoteTitle"),
                label: t("git.linkRemoteLabel"),
                confirm: t("git.link"),
                onSubmit: (url) => act("remote", () => api.gitSetRemote(name, url), t("git.remoteLinked")),
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
            <div style={{ fontWeight: 600 }}>{t("git.mergeInProgress")}</div>
            <div className="muted">
              {conflicted.length
                ? t("git.fixConflicts")
                : t("git.conflictsResolved")}
            </div>
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => act("abort", () => api.gitAbortMerge(name), t("git.mergeAborted"))}>
              {t("git.abortMerge")}
            </button>
          </div>
        </div>
      )}

      <div className="chat-box" style={{ padding: "6px 6px 6px 10px", marginTop: 2 }}>
        <textarea
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          rows={2}
          data-keys="git-commit"
          placeholder={kCommit ? t("git.commitMessageHint", { key: kCommit }) : t("git.commitMessage")}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (matches("git-commit", e.nativeEvent)) {
              e.preventDefault();
              commit();
            }
          }}
        />
        <div className="row">
          <span className="ctx">
            {staged.length ? t("git.stagedCount", { count: staged.length }) : git.files.length ? t("git.allWillCommit") : t("git.noChanges")}
          </span>
          <button className="btn sm primary" disabled={!message.trim() || !git.files.length || !!busy || conflicted.length > 0} onClick={commit}>
            {busy === "commit" ? <Loader2 size={13} className="spin" /> : <Check size={13} />} {t("git.commit")}
          </button>
        </div>
      </div>

      {staged.length > 0 && (
        <FileGroup
          title={t("git.staged")}
          files={staged}
          onOpen={(f) => app.openDialog({ kind: "diff", project: name, path: f.path })}
          actions={(f) => (
            <button className="icon-btn sm" title={t("git.unstage")} onClick={() => act("unstage", () => api.gitUnstage(name, [f.path]))}>
              <Minus size={13} />
            </button>
          )}
          headerAction={
            <button className="icon-btn sm" title={t("git.unstageAll")} onClick={() => act("unstage", () => api.gitUnstage(name, staged.map((f) => f.path)))}>
              <Minus size={13} />
            </button>
          }
        />
      )}
      <FileGroup
        title={t("git.changes")}
        files={unstaged}
        empty={t("git.clean")}
        onOpen={(f) =>
          f.kind === "conflicted" ? openFile(f.path) : app.openDialog({ kind: "diff", project: name, path: f.path })
        }
        actions={(f) => (
          <>
            {f.kind === "conflicted" ? (
              <button className="icon-btn sm" title={t("git.markResolved")} onClick={() => act("resolve", () => api.gitResolve(name, f.path), t("git.markedResolved"))}>
                <Check size={13} />
              </button>
            ) : (
              <>
                <button className="icon-btn sm" title={t("git.openFile")} onClick={() => openFile(f.path)}>
                  <FileDiff size={13} />
                </button>
                <button
                  className="icon-btn sm"
                  title={t("git.discard")}
                  onClick={() =>
                    app.openDialog({
                      kind: "confirm",
                      title: t("git.discardTitle", { name: basename(f.path) }),
                      message: f.kind === "new" ? t("git.discardNew") : t("git.discardEdits"),
                      danger: true,
                      confirm: t("git.discardConfirm"),
                      onConfirm: () => act("discard", () => api.gitDiscard(name, [f.path])),
                    })
                  }
                >
                  <RotateCcw size={13} />
                </button>
                <button className="icon-btn sm" title={t("git.stage")} onClick={() => act("stage", () => api.gitStage(name, [f.path]))}>
                  <Plus size={13} />
                </button>
              </>
            )}
          </>
        )}
        headerAction={
          unstaged.length > 0 ? (
            <button className="icon-btn sm" title={t("git.stageAll")} onClick={() => act("stage", () => api.gitStageAll(name))}>
              <Plus size={13} />
            </button>
          ) : undefined
        }
      />

      <div className="section-label" style={{ paddingLeft: 6 }}>
        <span>{t("git.history")}</span>
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
                      <button className="icon-btn sm" title={t("common.actions")}>
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
        {!log.length && <div className="muted" style={{ padding: "4px 8px" }}>{t("git.noCommits")}</div>}
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
