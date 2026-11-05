import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Loader2, PanelLeftClose, PanelLeftOpen, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "@/components/ChatPanel";
import { CommandPalette } from "@/components/CommandPalette";
import { Dialogs } from "@/components/Dialogs";
import { treeActions } from "@/components/FileTree";
import { Home, importZipFlow } from "@/components/Home";
import { downloadPdf } from "@/components/PdfViewer";
import { SettingsDialog } from "@/components/Settings";
import { Sidebar } from "@/components/Sidebar";
import { Toasts } from "@/components/ui/Toasts";
import { exportZipFlow, Workspace } from "@/components/Workspace";
import { t as translate, useLanguage, useT } from "@/lib/i18n";
import { api, type SyncStatus } from "@/lib/ipc";
import {
  installGlobalKeybinds,
  syncMenu,
  useHint,
  useKeybinds,
  useShortcut,
} from "@/lib/keybinds";
import { clampFontSize, FONT_BASE } from "@/lib/themes";
import { useApp } from "@/stores/app";
import { projectExists, useProject } from "@/stores/project";
import { useUpdater } from "@/stores/updater";

function runAction(id: string) {
  const app = useApp.getState();
  const proj = useProject.getState();
  switch (id) {
    case "settings":
      return app.setUi({ settings: "general" });
    case "storage":
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
      return proj.commit();
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
      return app.setUi({
        sidebar: true,
        sidebarTab: app.ui.sidebarTab === "git" ? "files" : "git",
      });
    case "compile":
      return proj.project && proj.compile();
    case "zoom-in":
    case "zoom-out":
    case "zoom-reset": {
      const settings = app.settings;
      if (!settings) return;
      const cur = clampFontSize(settings.editorFontSize);
      const next =
        id === "zoom-reset"
          ? FONT_BASE
          : clampFontSize(cur + (id === "zoom-in" ? 1 : -1));
      if (next !== cur) return void app.saveSettings({ editorFontSize: next });
    }
  }
}

const roots: {
  gone: string | null;
  added: string | null;
  timer?: ReturnType<typeof setTimeout>;
} = { gone: null, added: null };

function rootChanged(project: string) {
  const app = useApp.getState();
  if (project === app.current) roots.gone = project;
  else if (!app.projects.some((p) => p.name === project)) roots.added = project;
  else return;
  clearTimeout(roots.timer);
  roots.timer = setTimeout(async () => {
    const { gone, added } = roots;
    roots.gone = roots.added = null;
    if (
      !gone ||
      gone !== useApp.getState().current ||
      (await projectExists(gone))
    )
      return;
    if (added && (await projectExists(added)))
      return void useProject.getState().followRename(gone, added);
    if (gone !== useApp.getState().current) return;
    useApp.getState().toast(translate("app.rootGone", { name: gone }), "error");
    useApp.getState().openProject(null);
  }, 600);
}

export default function App() {
  const t = useT();
  const [ready, setReady] = useState(false);
  const { current, ui, toggle } = useApp();
  const sidebarKey = useShortcut("toggle-sidebar");
  const chatHint = useHint("common.aiAssistant", "toggle-chat");
  const sidebarHint = sidebarKey
    ? `${t("common.toggleSidebar")} (${sidebarKey})`
    : t("common.toggleSidebar");
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

  useEffect(() => {
    const p = useProject.getState();
    if (!current) p.unload();
    else if (p.project?.name !== current) void p.load(current);
  }, [current]);

  useEffect(() => {
    const unsubs = [
      listen<string>("menu", (e) => void runAction(e.payload)),
      listen<{ project: string; paths: string[] }>("fs-changed", (e) => {
        const { project, paths } = e.payload;
        if (paths.includes("")) rootChanged(project);
        if (project === useApp.getState().current)
          void useProject.getState().onExternalChange(paths);
        clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(
          () => void useApp.getState().refreshProjects(),
          600,
        );
      }),
      listen<SyncStatus>("sync-status", (e) => {
        useApp.getState().setSync(e.payload);
        if (
          e.payload.project === useApp.getState().current &&
          e.payload.status
        ) {
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
              app.toast(
                translate("toast.imported", { name: created.name }),
                "success",
              );
            }
            await app.refreshProjects();
            return;
          }
          const dpr = window.devicePixelRatio || 1;
          const el = document.elementFromPoint(
            p.position.x / dpr,
            p.position.y / dpr,
          );
          const dir = el?.closest("[data-dir]")?.getAttribute("data-dir") ?? "";
          const added = await api.importFiles(proj.name, p.paths, dir);
          await useProject.getState().refreshTree();
          app.toast(
            translate("app.filesAdded", { count: added.length }),
            "success",
          );
        } catch (e) {
          app.fail(e);
        }
      }),
    ];
    return () => unsubs.forEach((u) => u.then((f) => f()));
  }, []);

  useEffect(() => {
    const recheck = () => {
      if (Date.now() - useUpdater.getState().checkedAt > 30 * 60_000)
        void useUpdater.getState().check();
    };
    recheck();
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, []);

  useEffect(() => {
    const onFocus = () => {
      const name = useApp.getState().current;
      if (name) void api.syncNow(name);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => installGlobalKeybinds(runAction), []);

  useEffect(() => {
    syncMenu();
    const offKeys = useKeybinds.subscribe((s, prev) => {
      if (s.overrides !== prev.overrides) syncMenu();
    });
    const offLang = useLanguage.subscribe((s, prev) => {
      if (s.language !== prev.language) syncMenu();
    });
    return () => {
      offKeys();
      offLang();
    };
  }, []);

  if (!ready) {
    return (
      <div
        className="app"
        style={{ alignItems: "center", justifyContent: "center" }}
      >
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
          <header className="topbar drag" data-tauri-drag-region>
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
            <div className="spacer" data-tauri-drag-region />
            <button
              className={`ai-btn${ui.chat ? " active" : ""}`}
              onClick={() => toggle("chat")}
              title={chatHint}
            >
              <Sparkles size={14} /> {t("common.aiAssistant")}
            </button>
          </header>
          <div className="panes">
            <Home />
            {ui.chat && <ChatPanel />}
          </div>
        </main>
      )}
      {dropping && (
        <div className="drop-overlay">
          {current ? t("app.dropFiles") : t("app.dropZip")}
        </div>
      )}
      <Dialogs />
      <SettingsDialog />
      <CommandPalette />
      <Toasts />
    </div>
  );
}
