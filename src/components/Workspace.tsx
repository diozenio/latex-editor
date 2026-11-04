import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Download,
  FileArchive,
  FolderOpen,
  Info,
  Loader2,
  MoreHorizontal,
  PanelLeftOpen,
  PanelRight,
  Play,
  Settings2,
  Sparkles,
  Terminal,
  Trash,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { basename, mod } from "@/lib/format";
import { api } from "@/lib/ipc";
import { useApp } from "@/stores/app";
import { tabKind, useProject } from "@/stores/project";
import { ChatPanel } from "./ChatPanel";
import { Editor } from "./Editor";
import { fileIcon } from "./FileTree";
import { downloadPdf, PdfViewer } from "./PdfViewer";
import { SyncBadge } from "./SyncBadge";
import { Dropdown } from "./ui/Menu";

export async function exportZipFlow() {
  const { project } = useProject.getState();
  const app = useApp.getState();
  if (!project) return;
  const dest = await save({
    defaultPath: `${project.name}.zip`,
    filters: [{ name: "ZIP", extensions: ["zip"] }],
  });
  if (!dest) return;
  try {
    await useProject.getState().saveAll();
    await api.exportZip(project.name, dest, false);
    app.toast("Exported ZIP", "success");
  } catch (e) {
    app.fail(e);
  }
}

export function Workspace() {
  const { ui, toggle, setUi, openDialog } = useApp();
  const { project, active, tabs, compiling, result, git, compile } =
    useProject();
  const sync = useApp((s) => (project ? s.sync[project.name] : undefined));
  const [split, setSplit] = useState(() => {
    try {
      return Number(localStorage.getItem("quilltex.split")) || 0.5;
    } catch {
      return 0.5;
    }
  });
  const panes = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const r = panes.current?.getBoundingClientRect();
      if (!r) return;
      setSplit(Math.min(0.8, Math.max(0.2, (e.clientX - r.left) / r.width)));
    };
    const up = () => {
      setDragging(false);
      try {
        localStorage.setItem("quilltex.split", String(split));
      } catch {}
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [dragging, split]);

  if (!project) return null;
  const errors =
    result?.diagnostics.filter((d) => d.severity === "error").length ?? 0;

  return (
    <main className="main">
      <header className="topbar drag" data-tauri-drag-region>
        {!ui.sidebar && (
          <button
            className="icon-btn"
            title={`Show sidebar (${mod}B)`}
            onClick={() => toggle("sidebar")}
          >
            <PanelLeftOpen size={16} />
          </button>
        )}
        <div className="breadcrumbs" data-tauri-drag-region>
          <span className="dot" style={{ background: project.meta.color }} />
          <span>{project.name}</span>
          {active && (
            <>
              <ChevronRight size={13} />
              <span className="current">{active}</span>
            </>
          )}
        </div>
        <div className="spacer" data-tauri-drag-region />
        {git?.isRepo && (
          <SyncBadge
            status={git}
            error={sync?.error}
            checkedAt={sync?.checkedAt}
            onClick={() => setUi({ sidebar: true, sidebarTab: "git" })}
          />
        )}
        <button
          className={`ai-btn${ui.chat ? " active" : ""}`}
          onClick={() => toggle("chat")}
          title={`AI assistant (${mod}J)`}
        >
          <Sparkles size={14} /> AI assistant
        </button>
        <button
          className="btn primary"
          onClick={() => compile()}
          disabled={compiling}
          title={`Compile (${mod}↵)`}
        >
          {compiling ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <Play size={13} fill="currentColor" />
          )}
          {compiling ? "Compiling" : "Compile"}
        </button>
        <button
          className={`icon-btn framed${ui.pdf ? " active" : ""}`}
          title="Toggle PDF"
          onClick={() => toggle("pdf")}
        >
          <PanelRight size={15} />
        </button>
        <Dropdown
          align="end"
          items={[
            {
              label: "Download PDF…",
              icon: <Download size={14} />,
              right: `${mod}⇧S`,
              onSelect: downloadPdf,
            },
            {
              label: "Export as ZIP…",
              icon: <FileArchive size={14} />,
              onSelect: exportZipFlow,
            },
            {
              label: "Show in Finder",
              icon: <FolderOpen size={14} />,
              onSelect: async () =>
                revealItemInDir(await api.projectPath(project.name)),
            },
            { separator: true },
            {
              label: "Project settings…",
              icon: <Settings2 size={14} />,
              onSelect: () => openDialog({ kind: "project-settings" }),
            },
            {
              label: "Clear build cache",
              icon: <Trash size={14} />,
              onSelect: async () => {
                await api.cleanBuild(project.name);
                void compile();
              },
            },
          ]}
          trigger={
            <button className="icon-btn framed" title="More">
              <MoreHorizontal size={15} />
            </button>
          }
        />
      </header>

      <div
        className="panes"
        ref={panes}
        style={{ cursor: dragging ? "col-resize" : undefined }}
      >
        <div
          className="pane"
          style={{
            flex: ui.pdf ? `0 0 ${split * 100}%` : 1,
            pointerEvents: dragging ? "none" : undefined,
          }}
        >
          <Tabs />
          {active ? <ActiveView path={active} /> : <NoFile />}
          {ui.logs && <Logs />}
          <StatusBar errors={errors} />
        </div>
        {ui.pdf && (
          <>
            <div
              className={`splitter${dragging ? " active" : ""}`}
              onMouseDown={() => setDragging(true)}
            />
            <div
              className="pane"
              style={{ flex: 1, pointerEvents: dragging ? "none" : undefined }}
            >
              <PdfViewer />
            </div>
          </>
        )}
        {ui.chat && <ChatPanel />}
      </div>
      {tabs.length === 0 && null}
    </main>
  );
}

function Tabs() {
  const { tabs, active, docs, setActive, closeTab } = useProject();
  if (!tabs.length) return <div className="tabs" />;
  return (
    <div className="tabs">
      {tabs.map((t) => {
        const d = docs[t];
        const dirty = d && d.content !== d.saved;
        return (
          <div
            key={t}
            className={`tab${t === active ? " active" : ""}`}
            onClick={() => setActive(t)}
            onAuxClick={(e) => e.button === 1 && closeTab(t)}
            title={t}
          >
            {fileIcon(t, 13)}
            <span>{basename(t)}</span>
            {dirty ? (
              <span className="dirty" />
            ) : (
              <button
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t);
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ActiveView({ path }: { path: string }) {
  const kind = tabKind(path);
  const project = useProject((s) => s.project);
  if (kind === "text") return <Editor path={path} />;
  if (kind === "image")
    return <ImagePreview project={project!.name} path={path} />;
  return (
    <div className="empty">
      <div className="empty-icon">{fileIcon(path, 20)}</div>
      <h3>{basename(path)}</h3>
      <p>This file can’t be edited here.</p>
      <button
        className="btn"
        onClick={async () =>
          revealItemInDir(await api.projectPath(project!.name, path))
        }
      >
        Show in Finder
      </button>
    </div>
  );
}

function ImagePreview({ project, path }: { project: string; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    api.readBinary(project, path).then((buf) => {
      u = URL.createObjectURL(new Blob([buf]));
      setUrl(u);
    });
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [project, path]);
  return (
    <div className="preview-image">{url && <img src={url} alt={path} />}</div>
  );
}

function NoFile() {
  return (
    <div className="empty" style={{ background: "var(--bg-elevated)" }}>
      <h3>No file open</h3>
      <p>Pick a file in the sidebar, or press {mod}K to search.</p>
    </div>
  );
}

function Logs() {
  const { result, openFile, project } = useProject();
  const setUi = useApp((s) => s.setUi);
  const [raw, setRaw] = useState(false);
  const items = result?.diagnostics ?? [];
  return (
    <div className="logs">
      <div className="logs-head">
        <strong style={{ fontSize: 12 }}>Logs</strong>
        <div className="seg" style={{ margin: 0, width: 160 }}>
          <button className={!raw ? "on" : ""} onClick={() => setRaw(false)}>
            Issues
          </button>
          <button className={raw ? "on" : ""} onClick={() => setRaw(true)}>
            Raw log
          </button>
        </div>
        <div className="grow" />
        <button className="icon-btn sm" onClick={() => setUi({ logs: false })}>
          <X size={13} />
        </button>
      </div>
      <div className="logs-body">
        {raw ? (
          <pre className="raw-log">{result?.log || "No log yet."}</pre>
        ) : items.length === 0 ? (
          <div className="muted" style={{ padding: 12 }}>
            {result ? "No issues. 🎉" : "Compile to see issues."}
          </div>
        ) : (
          items.map((d, i) => (
            <button
              key={i}
              className="log-item"
              onClick={() => {
                const file = d.file ?? project?.meta.mainFile;
                if (file && d.line)
                  void openFile(file.replace(/^\.\//, ""), d.line);
              }}
            >
              {d.severity === "error" ? (
                <AlertCircle
                  size={14}
                  style={{ color: "var(--red)", flex: "none", marginTop: 2 }}
                />
              ) : d.severity === "warning" ? (
                <AlertTriangle
                  size={14}
                  style={{ color: "var(--orange)", flex: "none", marginTop: 2 }}
                />
              ) : (
                <Info
                  size={14}
                  style={{
                    color: "var(--text-tertiary)",
                    flex: "none",
                    marginTop: 2,
                  }}
                />
              )}
              <span className="msg">{d.message}</span>
              {(d.file || d.line) && (
                <span className="loc">
                  {d.file ?? ""}
                  {d.line ? `:${d.line}` : ""}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function StatusBar({ errors }: { errors: number }) {
  const {
    result,
    compiling,
    compileStatus,
    project,
    cursorLine,
    active,
    docs,
    forwardSearch,
  } = useProject();
  const toggle = useApp((s) => s.toggle);
  const warnings =
    result?.diagnostics.filter((d) => d.severity === "warning").length ?? 0;
  const words = useMemo(() => {
    const text = active ? docs[active]?.content : "";
    if (!text || !active?.endsWith(".tex")) return null;
    const body = text
      .replace(/%.*$/gm, "")
      .replace(/\\(begin|end)\{[^}]*\}/g, " ")
      .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, " ")
      .replace(/[{}$\\&_^~#]/g, " ");
    return body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }, [active, docs]);

  return (
    <div className="statusbar">
      <button onClick={() => toggle("logs")}>
        {compiling ? (
          <>
            <Loader2 size={11} className="spin" />{" "}
            {compileStatus ?? "Compiling"}
          </>
        ) : result ? (
          result.ok ? (
            <>
              <CheckCircle2 size={11} style={{ color: "var(--green)" }} />{" "}
              Compiled in {(result.durationMs / 1000).toFixed(1)}s
            </>
          ) : (
            <span className="err">
              <AlertCircle size={11} /> Failed
            </span>
          )
        ) : (
          <>
            <Terminal size={11} /> Not compiled
          </>
        )}
      </button>
      {errors > 0 && (
        <button className="err" onClick={() => toggle("logs")}>
          <AlertCircle size={11} /> {errors}
        </button>
      )}
      {warnings > 0 && (
        <button className="warn" onClick={() => toggle("logs")}>
          <AlertTriangle size={11} /> {warnings}
        </button>
      )}
      <div className="grow" />
      {active?.endsWith(".tex") && (
        <button
          title={`Or ${mod}-click in the editor`}
          onClick={() => active && forwardSearch(active, cursorLine)}
        >
          Show in PDF →
        </button>
      )}
      {words != null && <span>{words.toLocaleString()} words</span>}
      {active && <span>Ln {cursorLine}</span>}
      <span>
        {project?.meta.engine === "tectonic"
          ? "Tectonic"
          : project?.meta.engine.replace("latexmk-", "")}
      </span>
    </div>
  );
}
