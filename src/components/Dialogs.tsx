import {
  BookOpen,
  FileText,
  FileType,
  Github,
  GitMerge,
  Globe,
  Loader2,
  Lock,
  MoreHorizontal,
  Presentation,
  ScrollText,
  Search,
  Square,
  UserSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { slug, timeAgo } from "@/lib/format";
import { hasKey, type MessageKey, useT } from "@/lib/i18n";
import { T } from "@/lib/i18n/T";
import {
  api,
  type Branch,
  type Commit,
  type CommitFile,
  type Engine,
  errorMessage,
  type Repo,
} from "@/lib/ipc";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import { commitMenu } from "./commitMenu";
import { describeMerge } from "./GitPanel";
import { Dialog } from "./ui/Dialog";
import { Dropdown } from "./ui/Menu";
import { Select } from "./ui/Select";

export function Dialogs() {
  const dialog = useApp((s) => s.dialog);
  const close = () => useApp.getState().openDialog(null);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "new-project":
      return <NewProject onClose={close} />;
    case "clone":
      return <CloneRepo onClose={close} />;
    case "publish":
      return <Publish project={dialog.project} onClose={close} />;
    case "uninstall":
      return <Uninstall onClose={close} />;
    case "diff":
      return (
        <Diff project={dialog.project} path={dialog.path} onClose={close} />
      );
    case "commit":
      return (
        <CommitDetails
          project={dialog.project}
          commit={dialog.commit}
          onClose={close}
        />
      );
    case "merge":
      return <Merge project={dialog.project} onClose={close} />;
    case "project-settings":
      return <ProjectSettings onClose={close} />;
    case "prompt":
      return <Prompt d={dialog} onClose={close} />;
    case "confirm":
      return <Confirm d={dialog} onClose={close} />;
  }
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const TEMPLATE_ICONS: Record<string, JSX.Element> = {
  document: <FileType size={18} />,
  blank: <Square size={18} />,
  article: <FileText size={18} />,
  report: <BookOpen size={18} />,
  beamer: <Presentation size={18} />,
  cv: <UserSquare size={18} />,
};

const DEFAULT_TEMPLATES: [string, string][] = [
  ["blank", "Blank"],
  ["article", "Article"],
  ["report", "Report"],
  ["beamer", "Presentation (Beamer)"],
  ["cv", "CV"],
  ["document", "Markdown"],
];

function templateKey(id: string): MessageKey | null {
  const key = `template.${id}`;
  return hasKey(key) ? (key as MessageKey) : null;
}

function NewProject({ onClose }: { onClose: () => void }) {
  const t = useT();
  const app = useApp();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("article");
  const [templates, setTemplates] =
    useState<[string, string][]>(DEFAULT_TEMPLATES);
  const { busy, error, run } = useBusy();

  useEffect(() => {
    api.listTemplates().then(setTemplates);
    api.uniqueProjectName("Untitled").then(setName);
  }, []);

  const submit = () =>
    run(async () => {
      const p = await api.createProject(name, template);
      await app.refreshProjects();
      app.openProject(p.name);
      onClose();
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("common.newProject")}
      description={t("dialog.newProject.desc")}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            disabled={!name.trim() || busy}
            onClick={submit}
          >
            {busy && <Loader2 size={14} className="spin" />}{" "}
            {t("common.create")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("dialog.newProject.name")}</label>
        <input
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          className="input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          onFocus={(e) => e.target.select()}
        />
      </div>
      <div className="field">
        <label>{t("dialog.newProject.template")}</label>
        <div className="template-grid">
          {templates.map(([id, label]) => (
            <button
              key={id}
              className={`template${template === id ? " on" : ""}`}
              onClick={() => setTemplate(id)}
            >
              {TEMPLATE_ICONS[id] ?? <ScrollText size={18} />}
              {templateKey(id) ? t(templateKey(id)!) : label}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function CloneRepo({ onClose }: { onClose: () => void }) {
  const t = useT();
  const app = useApp();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const { busy, error, run } = useBusy();

  useEffect(() => {
    if (app.info?.githubConnected)
      api
        .githubRepos()
        .then(setRepos)
        .catch(() => setRepos([]));
    else setRepos([]);
  }, [app.info?.githubConnected]);

  const filtered = useMemo(
    () =>
      (repos ?? [])
        .filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 50),
    [repos, query],
  );

  const pick = (r: Repo) => {
    setUrl(r.cloneUrl);
    setName(r.name);
  };

  const submit = () =>
    run(async () => {
      const p = await api.gitClone(
        url,
        name ||
          slug(
            url
              .split("/")
              .pop()
              ?.replace(/\.git$/, "") ?? "repo",
          ),
      );
      await app.refreshProjects();
      app.openProject(p.name);
      onClose();
    });

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t("common.cloneFromGithub")}
      description={
        app.info?.githubConnected
          ? t("dialog.clone.descConnected")
          : t("dialog.clone.descSignedOut")
      }
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            disabled={!url || busy}
            onClick={submit}
          >
            {busy && <Loader2 size={14} className="spin" />}{" "}
            {t("dialog.clone.button")}
          </button>
        </>
      }
    >
      {app.info?.githubConnected && (
        <div className="field">
          <div className="search-field">
            <Search size={14} />
            <input
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              autoFocus
              placeholder={t("dialog.clone.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div
            className="card"
            style={{ maxHeight: 240, overflow: "auto", borderRadius: 10 }}
          >
            {repos === null ? (
              <div className="empty" style={{ padding: 24 }}>
                <Loader2 size={16} className="spin" />
              </div>
            ) : (
              filtered.map((r) => (
                <div
                  key={r.fullName}
                  className="project-row"
                  style={{
                    height: 40,
                    background:
                      url === r.cloneUrl ? "var(--bg-selected)" : undefined,
                  }}
                  onClick={() => pick(r)}
                  onDoubleClick={() => {
                    pick(r);
                  }}
                >
                  {r.private ? (
                    <Lock size={13} className="muted" />
                  ) : (
                    <Globe size={13} className="muted" />
                  )}
                  <span className="title">{r.fullName}</span>
                  <span className="muted">
                    {timeAgo(Date.parse(r.updatedAt))}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field grow">
          <label>{t("dialog.clone.url")}</label>
          <input
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            className="input"
            placeholder="https://github.com/user/repo.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="field" style={{ width: 200 }}>
          <label>{t("dialog.clone.name")}</label>
          <input
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function Publish({
  project,
  onClose,
}: {
  project: string;
  onClose: () => void;
}) {
  const t = useT();
  const app = useApp();
  const [name, setName] = useState(slug(project));
  const [isPrivate, setPrivate] = useState(true);
  const { busy, error, run } = useBusy();

  if (!app.info?.githubConnected) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={t("dialog.publish.connectTitle")}
        description={t("dialog.publish.connectDesc")}
        footer={
          <>
            <button className="btn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              className="btn primary"
              onClick={() => {
                onClose();
                app.setUi({ settings: "github" });
              }}
            >
              <Github size={14} /> {t("dialog.publish.connect")}
            </button>
          </>
        }
      >
        <span />
      </Dialog>
    );
  }

  const submit = () =>
    run(async () => {
      const status = await api.gitStatus(project);
      if (!status.isRepo) {
        await api.gitInit(project);
        await api.gitStageAll(project);
        await api.gitCommit(project, t("git.initialCommit"));
      } else if (status.files.length) {
        await api.gitStageAll(project);
        await api.gitCommit(project, t("git.updateBeforePublish"));
      }
      const url = await api.githubPublish(project, name, isPrivate);
      app.toast(
        t("dialog.publish.done", { url: url.replace(/\.git$/, "") }),
        "success",
      );
      await useProject.getState().refreshGit();
      onClose();
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("common.publishToGithub")}
      description={t("dialog.publish.desc", {
        user: app.settings?.githubUser?.login ?? "",
        project,
      })}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            disabled={!name || busy}
            onClick={submit}
          >
            {busy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Github size={14} />
            )}{" "}
            {t("dialog.publish.button")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("dialog.publish.repoName")}</label>
        <input
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          className="input"
          autoFocus
          value={name}
          onChange={(e) => setName(slug(e.target.value) || e.target.value)}
        />
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(e) => setPrivate(e.target.checked)}
        />
        <span>
          {t("dialog.publish.private")}
          <div className="muted" style={{ fontSize: 12 }}>
            {t("dialog.publish.privateHint")}
          </div>
        </span>
      </label>
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function Merge({ project, onClose }: { project: string; onClose: () => void }) {
  const t = useT();
  const app = useApp();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [from, setFrom] = useState("");
  const { busy, error, run } = useBusy();
  const head = branches.find((b) => b.isHead)?.name;

  useEffect(() => {
    api.gitBranches(project).then((b) => {
      setBranches(b);
      setFrom(b.find((x) => !x.isHead)?.name ?? "");
    });
  }, [project]);

  const submit = () =>
    run(async () => {
      const out = await api.gitMerge(project, from);
      app.toast(
        describeMerge(out),
        out.type === "Conflicts" ? "error" : "success",
      );
      await useProject.getState().refreshGit();
      await useProject.getState().refreshTree();
      if (out.type === "Conflicts" && out.files[0]) {
        app.setUi({ sidebar: true, sidebarTab: "git" });
        await useProject.getState().openFile(out.files[0]);
      }
      onClose();
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("dialog.merge.title")}
      description={t("dialog.merge.desc", {
        branch: head ?? t("dialog.merge.currentBranch"),
      })}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            disabled={!from || busy}
            onClick={submit}
          >
            {busy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <GitMerge size={14} />
            )}{" "}
            {t("dialog.merge.button")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("dialog.merge.from")}</label>
        <Select
          value={from}
          options={branches
            .filter((b) => !b.isHead)
            .map((b) => ({ value: b.name, label: b.name }))}
          onChange={setFrom}
        />
      </div>
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function Diff({
  project,
  path,
  onClose,
}: {
  project: string;
  path: string;
  onClose: () => void;
}) {
  const t = useT();
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    api
      .gitDiff(project, path)
      .then(setDiff)
      .catch((e) => setDiff(errorMessage(e)));
  }, [project, path]);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={path}
      description={t("dialog.diff.desc")}
      footer={
        <>
          <button
            className="btn"
            onClick={() => {
              onClose();
              void useProject.getState().openFile(path);
            }}
          >
            {t("dialog.diff.openFile")}
          </button>
          <button className="btn primary" onClick={onClose}>
            {t("common.done")}
          </button>
        </>
      }
    >
      <DiffLines diff={diff} />
    </Dialog>
  );
}

function DiffLines({ diff }: { diff: string | null }) {
  const t = useT();
  return (
    <div className="diff">
      {diff === null ? (
        <div className="muted">{t("common.loading")}</div>
      ) : !diff.trim() ? (
        <div className="muted">{t("dialog.diff.noChanges")}</div>
      ) : (
        diff.split("\n").map((l, i) => (
          <div
            key={i}
            className={
              l.startsWith("@@")
                ? "hunk"
                : l.startsWith("+") && !l.startsWith("+++")
                  ? "add"
                  : l.startsWith("-") && !l.startsWith("---")
                    ? "del"
                    : ""
            }
          >
            {l || " "}
          </div>
        ))
      )}
    </div>
  );
}

function CommitDetails({
  project,
  commit,
  onClose,
}: {
  project: string;
  commit: Commit;
  onClose: () => void;
}) {
  const t = useT();
  const [files, setFiles] = useState<CommitFile[] | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [head, setHead] = useState(false);

  useEffect(() => {
    api
      .gitLog(project)
      .then((l) => setHead(l[0]?.id === commit.id))
      .catch(() => {});
    api
      .gitCommitFiles(project, commit.id)
      .then((f) => {
        setFiles(f);
        setPath(f[0]?.path ?? null);
      })
      .catch(() => setFiles([]));
  }, [project, commit.id]);

  useEffect(() => {
    if (!path) return;
    setDiff(null);
    api
      .gitCommitDiff(project, commit.id, path)
      .then(setDiff)
      .catch((e) => setDiff(errorMessage(e)));
  }, [project, commit.id, path]);

  return (
    <Dialog
      open
      wide
      tall
      onClose={onClose}
      title={commit.summary}
      description={`${commit.short} · ${commit.author} · ${timeAgo(commit.time)}`}
      corner={
        <Dropdown
          align="end"
          items={commitMenu(project, commit, head, false)}
          trigger={
            <button className="icon-btn" title={t("common.actions")}>
              <MoreHorizontal size={16} />
            </button>
          }
        />
      }
    >
      {files === null ? (
        <div className="muted">{t("common.loading")}</div>
      ) : (
        <>
          <div className="commit-files">
            {files.map((f, i) => (
              <div
                key={f.path}
                className={`git-file${f.path === path ? " active" : ""}`}
                style={{ "--i": Math.min(i, 10) } as React.CSSProperties}
                onClick={() => setPath(f.path)}
              >
                <span className={`kind ${f.kind}`}>
                  {
                    { new: "A", modified: "M", deleted: "D", typechange: "T" }[
                      f.kind
                    ]
                  }
                </span>
                <span className="name" title={f.path}>
                  &lrm;{f.path}
                </span>
              </div>
            ))}
            {!files.length && (
              <div className="muted">{t("dialog.commit.noFiles")}</div>
            )}
          </div>
          {path && (
            <div className="commit-diff">
              <DiffLines key={path} diff={diff} />
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

const ENGINES: [Engine, MessageKey | string][] = [
  ["tectonic", "engine.tectonic"],
  ["latexmk-pdflatex", "pdfLaTeX (TeX Live)"],
  ["latexmk-xelatex", "XeLaTeX (TeX Live)"],
  ["latexmk-lualatex", "LuaLaTeX (TeX Live)"],
];
const COLORS = [
  "#6366F1",
  "#3B82F6",
  "#84CC16",
  "#10B981",
  "#F59E0B",
  "#EC4899",
  "#8B5CF6",
  "#EF4444",
];

function ProjectSettings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const project = useProject((s) => s.project);
  const tree = useProject((s) => s.tree);
  const info = useApp((s) => s.info);
  const [meta, setMeta] = useState(project?.meta);
  const { busy, error, run } = useBusy();
  if (!project || !meta) return null;
  const texFiles = (function walk(nodes: typeof tree): string[] {
    return nodes.flatMap((n) =>
      n.isDir ? walk(n.children ?? []) : /\.tex$/i.test(n.name) ? [n.path] : [],
    );
  })(tree);

  const submit = () =>
    run(async () => {
      await api.setProjectMeta(project.name, meta);
      await useProject.getState().refreshMeta();
      await useApp.getState().refreshProjects();
      useProject.getState().scheduleCompile();
      onClose();
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("dialog.projectSettings.title")}
      description={
        <T
          k="dialog.projectSettings.desc"
          values={{
            file: <span className="mono">.quilltex/project.json</span>,
          }}
        />
      }
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("dialog.projectSettings.main")}</label>
        <Select
          value={meta.mainFile}
          options={texFiles.map((f) => ({ value: f, label: f }))}
          onChange={(v) => setMeta({ ...meta, mainFile: v })}
        />
      </div>
      <div className="field">
        <label>{t("dialog.projectSettings.compiler")}</label>
        <Select
          value={meta.engine}
          options={ENGINES.map(([id, label]) => ({
            value: id,
            label: `${hasKey(label) ? t(label as MessageKey) : label}${
              id !== "tectonic" && !info?.texlive && !info?.texliveBundled
                ? t("dialog.projectSettings.downloadsOnFirst")
                : ""
            }`,
          }))}
          onChange={(v) => setMeta({ ...meta, engine: v as Engine })}
        />
        <span className="hint">{t("dialog.projectSettings.compilerHint")}</span>
      </div>
      <div className="field">
        <label>{t("dialog.projectSettings.color")}</label>
        <div className="row">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setMeta({ ...meta, color: c })}
              style={{
                width: 22,
                height: 22,
                borderRadius: 7,
                background: c,
                border: "none",
                boxShadow:
                  meta.color === c
                    ? `0 0 0 2px var(--bg-elevated), 0 0 0 4px ${c}`
                    : "none",
              }}
            />
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div className="text">
          <strong>{t("dialog.projectSettings.auto")}</strong>
          <span>{t("dialog.projectSettings.autoHint")}</span>
        </div>
        <button
          className={`switch${meta.autoCompile ? " on" : ""}`}
          onClick={() => setMeta({ ...meta, autoCompile: !meta.autoCompile })}
        />
      </div>
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function Uninstall({ onClose }: { onClose: () => void }) {
  const t = useT();
  const info = useApp((s) => s.info);
  const [deleteProjects, setDeleteProjects] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const { busy, error, run } = useBusy();
  const [done, setDone] = useState<string | null>(null);

  const submit = () =>
    run(async () => {
      setDone(await api.uninstall(deleteProjects));
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("dialog.uninstall.title")}
      description={t("dialog.uninstall.desc")}
      footer={
        done ? (
          <button className="btn primary" onClick={onClose}>
            {t("common.ok")}
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              className="btn danger solid"
              disabled={busy || (deleteProjects && confirmText !== "delete")}
              onClick={submit}
            >
              {busy && <Loader2 size={14} className="spin" />}{" "}
              {t("dialog.uninstall.button")}
            </button>
          </>
        )
      }
    >
      {done ? (
        <div className="banner blue">{done}</div>
      ) : (
        <>
          <label className="checkbox">
            <input type="checkbox" checked readOnly disabled />
            <span>
              {t("dialog.uninstall.appData")}
              <div className="muted" style={{ fontSize: 12 }}>
                {t("dialog.uninstall.appDataHint")}
              </div>
            </span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={deleteProjects}
              onChange={(e) => setDeleteProjects(e.target.checked)}
            />
            <span>
              {t("dialog.uninstall.alsoProjects")}
              <div className="muted" style={{ fontSize: 12 }}>
                <T
                  k="dialog.uninstall.alsoProjectsHint"
                  values={{
                    path: <span className="mono">{info?.projectsRoot}</span>,
                  }}
                />
              </div>
            </span>
          </label>
          {deleteProjects && (
            <div className="field">
              <label>
                <T
                  k="dialog.uninstall.typeToConfirm"
                  values={{ word: <span className="mono">delete</span> }}
                />
              </label>
              <input
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                autoComplete="off"
                className="input"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
              />
            </div>
          )}
          {info?.platform === "windows" && (
            <div className="banner blue">{t("dialog.uninstall.windows")}</div>
          )}
        </>
      )}
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function Prompt({
  d,
  onClose,
}: {
  d: Extract<import("@/stores/app").Dialog, { kind: "prompt" }>;
  onClose: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(d.initial ?? "");
  const { busy, error, run } = useBusy();
  const submit = () =>
    run(async () => {
      if (!value.trim()) return;
      await d.onSubmit(value.trim());
      onClose();
    });
  return (
    <Dialog
      open
      onClose={onClose}
      title={d.title}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            disabled={!value.trim() || busy}
            onClick={submit}
          >
            {busy && <Loader2 size={14} className="spin" />}{" "}
            {d.confirm ?? t("common.ok")}
          </button>
        </>
      }
    >
      <div className="field">
        {d.label && <label>{d.label}</label>}
        <input
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          className="input"
          autoFocus
          value={value}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </div>
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function Confirm({
  d,
  onClose,
}: {
  d: Extract<import("@/stores/app").Dialog, { kind: "confirm" }>;
  onClose: () => void;
}) {
  const t = useT();
  const { busy, error, run } = useBusy();
  return (
    <Dialog
      open
      onClose={onClose}
      title={d.title}
      description={d.message}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className={`btn ${d.danger ? "danger solid" : "primary"}`}
            autoFocus
            disabled={busy}
            onClick={() =>
              run(async () => {
                await d.onConfirm();
                onClose();
              })
            }
          >
            {busy && <Loader2 size={14} className="spin" />}{" "}
            {d.confirm ?? t("common.confirm")}
          </button>
        </>
      }
    >
      {error ? <div className="banner red">{error}</div> : <span />}
    </Dialog>
  );
}
