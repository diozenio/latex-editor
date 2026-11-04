import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  FileText,
  GitMerge,
  Github,
  Globe,
  Loader2,
  Lock,
  Mail,
  Presentation,
  ScrollText,
  Search,
  UserSquare,
  Square,
} from "lucide-react";
import { api, errorMessage, type Branch, type Engine, type Repo } from "@/lib/ipc";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import { slug, timeAgo } from "@/lib/format";
import { Dialog } from "./ui/Dialog";
import { describeMerge } from "./GitPanel";

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
      return <Diff project={dialog.project} path={dialog.path} onClose={close} />;
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
  blank: <Square size={18} />,
  article: <FileText size={18} />,
  report: <BookOpen size={18} />,
  beamer: <Presentation size={18} />,
  letter: <Mail size={18} />,
  cv: <UserSquare size={18} />,
};

function NewProject({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("article");
  const [templates, setTemplates] = useState<[string, string][]>([]);
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
      title="New project"
      description="A new folder is created in your projects directory."
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || busy} onClick={submit}>
            {busy && <Loader2 size={14} className="spin" />} Create
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input
          className="input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          onFocus={(e) => e.target.select()}
        />
      </div>
      <div className="field">
        <label>Template</label>
        <div className="template-grid">
          {templates.map(([id, label]) => (
            <button key={id} className={`template${template === id ? " on" : ""}`} onClick={() => setTemplate(id)}>
              {TEMPLATE_ICONS[id] ?? <ScrollText size={18} />}
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function CloneRepo({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const { busy, error, run } = useBusy();

  useEffect(() => {
    if (app.info?.githubConnected) api.githubRepos().then(setRepos).catch(() => setRepos([]));
    else setRepos([]);
  }, [app.info?.githubConnected]);

  const filtered = useMemo(
    () => (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase())).slice(0, 50),
    [repos, query],
  );

  const pick = (r: Repo) => {
    setUrl(r.cloneUrl);
    setName(r.name);
  };

  const submit = () =>
    run(async () => {
      const p = await api.gitClone(url, name || slug(url.split("/").pop()?.replace(/\.git$/, "") ?? "repo"));
      await app.refreshProjects();
      app.openProject(p.name);
      onClose();
    });

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Clone from GitHub"
      description={app.info?.githubConnected ? "Pick one of your repositories or paste a URL." : "Paste a repository URL. Sign in to GitHub in Settings to browse your repositories."}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!url || busy} onClick={submit}>
            {busy && <Loader2 size={14} className="spin" />} Clone
          </button>
        </>
      }
    >
      {app.info?.githubConnected && (
        <div className="field">
          <div className="search-field">
            <Search size={14} />
            <input autoFocus placeholder="Search repositories" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="card" style={{ maxHeight: 240, overflow: "auto", borderRadius: 10 }}>
            {repos === null ? (
              <div className="empty" style={{ padding: 24 }}>
                <Loader2 size={16} className="spin" />
              </div>
            ) : (
              filtered.map((r) => (
                <div
                  key={r.fullName}
                  className="project-row"
                  style={{ height: 40, background: url === r.cloneUrl ? "var(--bg-selected)" : undefined }}
                  onClick={() => pick(r)}
                  onDoubleClick={() => {
                    pick(r);
                  }}
                >
                  {r.private ? <Lock size={13} className="muted" /> : <Globe size={13} className="muted" />}
                  <span className="title">{r.fullName}</span>
                  <span className="muted">{timeAgo(Date.parse(r.updatedAt))}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field grow">
          <label>Repository URL</label>
          <input className="input" placeholder="https://github.com/user/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="field" style={{ width: 200 }}>
          <label>Project name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function Publish({ project, onClose }: { project: string; onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState(slug(project));
  const [isPrivate, setPrivate] = useState(true);
  const { busy, error, run } = useBusy();

  if (!app.info?.githubConnected) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Connect GitHub first"
        description="Publishing creates a repository on your account and pushes this project to it."
        footer={
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => {
                onClose();
                app.setUi({ settings: "github" });
              }}
            >
              <Github size={14} /> Connect GitHub
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
      if (!status.isRepo) await api.gitInit(project);
      else if (status.files.length) {
        await api.gitStageAll(project);
        await api.gitCommit(project, "Update before publishing");
      }
      const url = await api.githubPublish(project, name, isPrivate);
      app.toast(`Published to ${url.replace(/\.git$/, "")}`, "success");
      await useProject.getState().refreshGit();
      onClose();
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Publish to GitHub"
      description={`Creates a new repository under @${app.settings?.githubUser?.login} and pushes “${project}”.`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name || busy} onClick={submit}>
            {busy ? <Loader2 size={14} className="spin" /> : <Github size={14} />} Publish
          </button>
        </>
      }
    >
      <div className="field">
        <label>Repository name</label>
        <input className="input" autoFocus value={name} onChange={(e) => setName(slug(e.target.value) || e.target.value)} />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />
        <span>
          Private repository
          <div className="muted" style={{ fontSize: 12 }}>
            Only you and people you invite can see it.
          </div>
        </span>
      </label>
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function Merge({ project, onClose }: { project: string; onClose: () => void }) {
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
      app.toast(describeMerge(out), out.type === "Conflicts" ? "error" : "success");
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
      title="Merge branch"
      description={`Bring the changes from another branch into ${head ?? "the current branch"}.`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!from || busy} onClick={submit}>
            {busy ? <Loader2 size={14} className="spin" /> : <GitMerge size={14} />} Merge
          </button>
        </>
      }
    >
      <div className="field">
        <label>Merge from</label>
        <select className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
          {branches
            .filter((b) => !b.isHead)
            .map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
        </select>
      </div>
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function Diff({ project, path, onClose }: { project: string; path: string; onClose: () => void }) {
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    api.gitDiff(project, path).then(setDiff).catch((e) => setDiff(errorMessage(e)));
  }, [project, path]);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={path}
      description="Changes since the last commit"
      footer={
        <>
          <button
            className="btn"
            onClick={() => {
              onClose();
              void useProject.getState().openFile(path);
            }}
          >
            Open file
          </button>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="diff">
        {diff === null ? (
          <div className="muted">Loading…</div>
        ) : !diff.trim() ? (
          <div className="muted">No textual changes.</div>
        ) : (
          diff.split("\n").map((l, i) => (
            <div
              key={i}
              className={
                l.startsWith("@@") ? "hunk" : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""
              }
            >
              {l || " "}
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}

const ENGINES: [Engine, string][] = [
  ["tectonic", "Tectonic (built-in, XeTeX)"],
  ["latexmk-pdflatex", "pdfLaTeX (system TeX)"],
  ["latexmk-xelatex", "XeLaTeX (system TeX)"],
  ["latexmk-lualatex", "LuaLaTeX (system TeX)"],
];
const COLORS = ["#6366F1", "#3B82F6", "#84CC16", "#10B981", "#F59E0B", "#EC4899", "#8B5CF6", "#EF4444"];

function ProjectSettings({ onClose }: { onClose: () => void }) {
  const project = useProject((s) => s.project);
  const tree = useProject((s) => s.tree);
  const info = useApp((s) => s.info);
  const [meta, setMeta] = useState(project?.meta);
  const { busy, error, run } = useBusy();
  if (!project || !meta) return null;
  const texFiles = (function walk(nodes: typeof tree): string[] {
    return nodes.flatMap((n) => (n.isDir ? walk(n.children ?? []) : /\.tex$/i.test(n.name) ? [n.path] : []));
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
      title="Project settings"
      description={
        <>
          Saved in <span className="mono">.folio/project.json</span> inside the project.
        </>
      }
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label>Main document</label>
        <select className="select" value={meta.mainFile} onChange={(e) => setMeta({ ...meta, mainFile: e.target.value })}>
          {texFiles.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Compiler</label>
        <select className="select" value={meta.engine} onChange={(e) => setMeta({ ...meta, engine: e.target.value as Engine })}>
          {ENGINES.map(([id, label]) => (
            <option key={id} value={id} disabled={id !== "tectonic" && !info?.systemTex}>
              {label}
              {id !== "tectonic" && !info?.systemTex ? " (not installed)" : ""}
            </option>
          ))}
        </select>
        <span className="hint">Tectonic ships with Folio and downloads packages on demand into its own cache.</span>
      </div>
      <div className="field">
        <label>Color</label>
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
                boxShadow: meta.color === c ? `0 0 0 2px var(--bg-elevated), 0 0 0 4px ${c}` : "none",
              }}
            />
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div className="text">
          <strong>Compile automatically</strong>
          <span>Recompile on ⌘S and when files change outside the editor</span>
        </div>
        <button className={`switch${meta.autoCompile ? " on" : ""}`} onClick={() => setMeta({ ...meta, autoCompile: !meta.autoCompile })} />
      </div>
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function Uninstall({ onClose }: { onClose: () => void }) {
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
      title="Uninstall Folio"
      description="Removes the app, its settings, the TeX package cache, chat history, the saved GitHub token and the Claude Code registration."
      footer={
        done ? (
          <button className="btn primary" onClick={onClose}>
            OK
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn danger solid"
              disabled={busy || (deleteProjects && confirmText !== "delete")}
              onClick={submit}
            >
              {busy && <Loader2 size={14} className="spin" />} Uninstall
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
              App and app data
              <div className="muted" style={{ fontSize: 12 }}>
                Settings, caches and logs. Nothing outside Folio’s own folders is touched.
              </div>
            </span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={deleteProjects} onChange={(e) => setDeleteProjects(e.target.checked)} />
            <span>
              Also delete my projects
              <div className="muted" style={{ fontSize: 12 }}>
                Moves <span className="mono">{info?.projectsRoot}</span> to the Trash.
              </div>
            </span>
          </label>
          {deleteProjects && (
            <div className="field">
              <label>
                Type <span className="mono">delete</span> to confirm
              </label>
              <input className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            </div>
          )}
          {info?.platform === "windows" && (
            <div className="banner blue">Windows opens the standard uninstaller, which has the same options.</div>
          )}
        </>
      )}
      {error && <div className="banner red">{error}</div>}
    </Dialog>
  );
}

function Prompt({ d, onClose }: { d: Extract<import("@/stores/app").Dialog, { kind: "prompt" }>; onClose: () => void }) {
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
            Cancel
          </button>
          <button className="btn primary" disabled={!value.trim() || busy} onClick={submit}>
            {busy && <Loader2 size={14} className="spin" />} {d.confirm ?? "OK"}
          </button>
        </>
      }
    >
      <div className="field">
        {d.label && <label>{d.label}</label>}
        <input
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

function Confirm({ d, onClose }: { d: Extract<import("@/stores/app").Dialog, { kind: "confirm" }>; onClose: () => void }) {
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
            Cancel
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
            {busy && <Loader2 size={14} className="spin" />} {d.confirm ?? "Confirm"}
          </button>
        </>
      }
    >
      {error ? <div className="banner red">{error}</div> : <span />}
    </Dialog>
  );
}
