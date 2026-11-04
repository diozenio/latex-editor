import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Loader2, PanelLeftOpen } from "lucide-react";
import { api, type SyncStatus } from "@/lib/ipc";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import { mod } from "@/lib/format";
import { Sidebar } from "@/components/Sidebar";
import { Home, importZipFlow } from "@/components/Home";
import { Workspace, exportZipFlow } from "@/components/Workspace";
import { Dialogs } from "@/components/Dialogs";
import { SettingsDialog } from "@/components/Settings";
import { CommandPalette } from "@/components/CommandPalette";
import { Toasts } from "@/components/ui/Toasts";
import { downloadPdf } from "@/components/PdfViewer";
import { ChatPanel } from "@/components/ChatPanel";
import { treeActions } from "@/components/FileTree";

function runAction(id: string) {
  const app = useApp.getState();
  const proj = useProject.getState();
  switch (id) {
    case "settings":
      return app.setUi({ settings: "general" });
    case "uninstall":
      return app.openDialog({ kind: "uninstall" });
    case "new-project":
      return app.openDialog({ kind: "new-project" });
    case "import-zip":
      return importZipFlow();
    case "clone-repo":
      return app.openDialog({ kind: "clone" });
    case "new-file":
      if (proj.project) {
        app.setUi({ sidebar: true, sidebarTab: "files" });
        setTimeout(() => treeActions.newFile(), 50);
      }
      return;
    case "save":
      return proj.active && proj.save(proj.active);
    case "export-zip":
      return exportZipFlow();
    case "download-pdf":
      return downloadPdf();
    case "command-palette":
      return app.setUi({ palette: !app.ui.palette });
    case "toggle-sidebar":
      return app.toggle("sidebar");
    case "toggle-pdf":
      return app.toggle("pdf");
    case "toggle-chat":
      return app.toggle("chat");
    case "toggle-git":
      return app.setUi({ sidebar: true, sidebarTab: app.ui.sidebarTab === "git" ? "files" : "git" });
    case "compile":
      return proj.project && proj.compile();
  }
}

// Keyboard shortcuts for platforms without a native menu bar handling them.
const SHORTCUTS: Record<string, string> = {
  k: "command-palette",
  b: "toggle-sidebar",
  j: "toggle-chat",
  ",": "settings",
  Enter: "compile",
  "shift+P": "toggle-pdf",
  "shift+G": "toggle-git",
  "shift+N": "new-project",
  "shift+O": "import-zip",
  "shift+S": "download-pdf",
  n: "new-file",
};

export default function App() {
  const [ready, setReady] = useState(false);
  const { current, ui, info, toggle } = useApp();
  const [dropping, setDropping] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    useApp
      .getState()
      .init()
      .then(() => setReady(true))
      .catch((e) => {
        useApp.getState().fail(e);
        setReady(true);
      });
  }, []);

  // Load the project whenever the selection changes.
  useEffect(() => {
    const p = useProject.getState();
    if (current) void p.load(current);
    else p.unload();
  }, [current]);

  useEffect(() => {
    const unsubs = [
      listen<string>("menu", (e) => void runAction(e.payload)),
      listen<{ project: string; paths: string[] }>("fs-changed", (e) => {
        const { project, paths } = e.payload;
        if (project === useApp.getState().current) void useProject.getState().onExternalChange(paths);
        clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => void useApp.getState().refreshProjects(), 600);
      }),
      listen<SyncStatus>("sync-status", (e) => {
        useApp.getState().setSync(e.payload);
        if (e.payload.project === useApp.getState().current && e.payload.status) {
          useProject.setState({ git: e.payload.status });
        }
      }),
      getCurrentWebview().onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") return setDropping(true);
        setDropping(false);
        if (p.type !== "drop" || !p.paths.length) return;
        const app = useApp.getState();
        const proj = useProject.getState().project;
        try {
          if (!proj) {
            for (const z of p.paths.filter((x) => /\.zip$/i.test(x))) {
              const created = await api.importZip(z);
              app.toast(`Imported “${created.name}”`, "success");
            }
            await app.refreshProjects();
            return;
          }
          const dpr = window.devicePixelRatio || 1;
          const el = document.elementFromPoint(p.position.x / dpr, p.position.y / dpr);
          const dir = el?.closest("[data-dir]")?.getAttribute("data-dir") ?? "";
          const added = await api.importFiles(proj.name, p.paths, dir);
          await useProject.getState().refreshTree();
          app.toast(`Added ${added.length} file${added.length === 1 ? "" : "s"}`, "success");
        } catch (e) {
          app.fail(e);
        }
      }),
    ];
    return () => unsubs.forEach((u) => u.then((f) => f()));
  }, []);

  // Refresh git state and fetch when the window regains focus.
  useEffect(() => {
    const onFocus = () => {
      const name = useApp.getState().current;
      if (name) void api.syncNow(name);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (!info || info.platform === "macos") return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = (e.shiftKey ? "shift+" : "") + (e.key.length === 1 && e.shiftKey ? e.key.toUpperCase() : e.key);
      const action = SHORTCUTS[key];
      if (action) {
        e.preventDefault();
        void runAction(action);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [info]);

  if (!ready) {
    return (
      <div className="app" style={{ alignItems: "center", justifyContent: "center" }}>
        <Loader2 className="spin" size={20} />
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar />
      {current ? (
        <Workspace />
      ) : (
        <main className="main">
          <header className="topbar drag no-border" data-tauri-drag-region>
            {!ui.sidebar && (
              <button className="icon-btn" title={`Show sidebar (${mod}B)`} onClick={() => toggle("sidebar")}>
                <PanelLeftOpen size={16} />
              </button>
            )}
            <div className="spacer" data-tauri-drag-region />
            <button className={`ai-btn${ui.chat ? " active" : ""}`} onClick={() => toggle("chat")}>
              ✦ AI assistant
            </button>
          </header>
          <div className="panes">
            <Home />
            {ui.chat && <ChatPanel />}
          </div>
        </main>
      )}
      {dropping && <div className="drop-overlay">{current ? "Drop files to add them to the project" : "Drop a .zip to import it as a project"}</div>}
      <Dialogs />
      <SettingsDialog />
      <CommandPalette />
      <Toasts />
    </div>
  );
}
