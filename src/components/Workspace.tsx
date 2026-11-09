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
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
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
import { t, useT } from "@/lib/i18n";
import { api } from "@/lib/ipc";
import { useHint, useShortcut } from "@/lib/keybinds";
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
    app.toast(t("workspace.exported"), "success");
  } catch (e) {
    app.fail(e);
  }
}

export function Workspace() {
  const t = useT();
  const sidebarHint = useHint("common.toggleSidebar", "toggle-sidebar");
  const chatHint = useHint("common.aiAssistant", "toggle-chat");
  const compileHint = useHint("common.compile", "compile");
  const kDownload = useShortcut("download-pdf");
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
  const editorPane = useRef<HTMLDivElement>(null);
  const [chatHeight, setChatHeight] = useState(() => {
    try {
      return Number(localStorage.getItem("quilltex.chatHeight")) || 320;
    } catch {
      return 320;
    }
  });
  const [draggingChat, setDraggingChat] = useState(false);

  useEffect(() => {
    if (!draggingChat) return;
    const move = (e: MouseEvent) => {
      const r = editorPane.current?.getBoundingClientRect();
      if (!r) return;
      setChatHeight(
        Math.min(r.height - 160, Math.max(160, r.bottom - e.clientY)),
      );
    };
    const up = () => setDraggingChat(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [draggingChat]);

  useEffect(() => {
    if (draggingChat) return;
    try {
      localStorage.setItem("quilltex.chatHeight", String(chatHeight));
    } catch {}
  }, [draggingChat, chatHeight]);

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
        <div className="breadcrumbs" data-tauri-drag-region>
          <button
            className="icon-btn"
            title={sidebarHint}
            onClick={() => toggle("sidebar")}
          >
            {ui.sidebar ? (
              <PanelLeftClose size={16} />
            ) : (
              <PanelLeftOpen size={16} />
            )}
          </button>
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
          title={chatHint}
        >
          <Sparkles size={14} /> {t("common.aiAssistant")}
        </button>
        <button
          className="btn primary"
          onClick={() => compile()}
          disabled={compiling}
          title={compileHint}
        >
          {compiling ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <Play size={13} fill="currentColor" />
          )}
          {compiling ? t("workspace.compiling") : t("common.compile")}
        </button>
        <button
          className={`icon-btn framed${ui.commentMarks ? " active" : ""}`}
          title={
            ui.commentMarks ? t("comments.hideMarks") : t("comments.showMarks")
          }
          onClick={() => setUi({ commentMarks: !ui.commentMarks })}
        >
          <MessageSquare size={15} />
        </button>
        <button
          className={`icon-btn framed${ui.pdf ? " active" : ""}`}
          title={t("workspace.togglePdf")}
          onClick={() => toggle("pdf")}
        >
          <PanelRight size={15} />
        </button>
        <Dropdown
          align="end"
          items={[
            {
              label: t("workspace.downloadPdf"),
              icon: <Download size={14} />,
              right: kDownload,
              onSelect: downloadPdf,
            },
            {
              label: t("workspace.exportZip"),
              icon: <FileArchive size={14} />,
              onSelect: exportZipFlow,
            },
            {
              label: t("common.showInFinder"),
              icon: <FolderOpen size={14} />,
              onSelect: async () =>
                revealItemInDir(await api.projectPath(project.name)),
            },
            { separator: true },
            {
              label: t("workspace.projectSettings"),
              icon: <Settings2 size={14} />,
              onSelect: () => openDialog({ kind: "project-settings" }),
            },
            {
              label: t("workspace.clearBuildCache"),
              icon: <Trash size={14} />,
              onSelect: async () => {
                await api.cleanBuild(project.name);
                void compile();
              },
            },
          ]}
          trigger={
            <button className="icon-btn framed" title={t("common.more")}>
              <MoreHorizontal size={15} />
            </button>
          }
        />
      </header>

      <div
        className="panes"
        ref={panes}
        style={{
          cursor: dragging
            ? "col-resize"
            : draggingChat
              ? "row-resize"
              : undefined,
        }}
      >
        <div
          className="pane"
          ref={editorPane}
          style={{
            flex: ui.pdf ? `0 0 ${split * 100}%` : 1,
            pointerEvents: dragging || draggingChat ? "none" : undefined,
          }}
        >
          <Tabs />
          {active ? <ActiveView path={active} /> : <NoFile />}
          {ui.chat && (
            <>
              <div
                className={`splitter-h${draggingChat ? " active" : ""}`}
                style={{ pointerEvents: "auto" }}
                onMouseDown={() => setDraggingChat(true)}
              />
              <ChatPanel docked height={chatHeight} />
            </>
          )}
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
  const t = useT();
  const kind = tabKind(path);
  const project = useProject((s) => s.project);
  if (kind === "text") return <Editor path={path} />;
  if (kind === "image")
    return <ImagePreview project={project!.name} path={path} />;
  return (
    <div className="empty">
      <div className="empty-icon">{fileIcon(path, 20)}</div>
      <h3>{basename(path)}</h3>
      <p>{t("workspace.cantEdit")}</p>
      <button
        className="btn"
        onClick={async () =>
          revealItemInDir(await api.projectPath(project!.name, path))
        }
      >
        {t("common.showInFinder")}
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
  const t = useT();
  const kPalette = useShortcut("command-palette");
  return (
    <div className="empty" style={{ background: "var(--bg-elevated)" }}>
      <h3>{t("workspace.noFile")}</h3>
      <p>
        {kPalette
          ? t("workspace.noFileHintKey", { key: kPalette })
          : t("workspace.noFileHint")}
      </p>
    </div>
  );
}

function Logs() {
  const t = useT();
  const { result, openFile, project } = useProject();
  const setUi = useApp((s) => s.setUi);
  const [raw, setRaw] = useState(false);
  const items = result?.diagnostics ?? [];
  return (
    <div className="logs">
      <div className="logs-head">
        <strong style={{ fontSize: 12 }}>{t("logs.title")}</strong>
        <div className="seg" style={{ margin: 0, width: 160 }}>
          <button className={!raw ? "on" : ""} onClick={() => setRaw(false)}>
            {t("logs.issues")}
          </button>
          <button className={raw ? "on" : ""} onClick={() => setRaw(true)}>
            {t("logs.raw")}
          </button>
        </div>
        <div className="grow" />
        <button className="icon-btn sm" onClick={() => setUi({ logs: false })}>
          <X size={13} />
        </button>
      </div>
      <div className="logs-body">
        {raw ? (
          <pre className="raw-log">{result?.log || t("logs.noLog")}</pre>
        ) : items.length === 0 ? (
          <div className="muted" style={{ padding: 12 }}>
            {result ? t("logs.noIssues") : t("logs.compileToSee")}
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
  const t = useT();
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
            {compileStatus ?? t("status.compiling")}
          </>
        ) : result ? (
          result.ok ? (
            <>
              <CheckCircle2 size={11} style={{ color: "var(--green)" }} />{" "}
              {t("status.compiledIn", {
                seconds: (result.durationMs / 1000).toFixed(1),
              })}
            </>
          ) : (
            <span className="err">
              <AlertCircle size={11} /> {t("status.failed")}
            </span>
          )
        ) : (
          <>
            <Terminal size={11} /> {t("status.notCompiled")}
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
          title={t("status.jumpHint", { mod })}
          onClick={() => active && forwardSearch(active, cursorLine)}
        >
          {t("status.showInPdf")}
        </button>
      )}
      {words != null && <span>{t("status.words", { count: words })}</span>}
      {active && <span>{t("status.line", { line: cursorLine })}</span>}
      <span>
        {project?.meta.engine === "tectonic"
          ? "Tectonic"
          : project?.meta.engine.replace("latexmk-", "")}
      </span>
    </div>
  );
}
