import { create } from "zustand";
import {
  type AppInfo,
  api,
  type Commit,
  errorMessage,
  type ProjectSummary,
  type Settings,
  type SyncStatus,
} from "@/lib/ipc";
import {
  applyFontSize,
  applyTheme,
  loadCustomThemes,
  persistCustomThemes,
  type Theme,
} from "@/lib/themes";

export type Dialog =
  | { kind: "new-project" }
  | { kind: "clone" }
  | { kind: "publish"; project: string }
  | { kind: "uninstall" }
  | { kind: "diff"; project: string; path: string }
  | { kind: "commit"; project: string; commit: Commit }
  | { kind: "merge"; project: string }
  | { kind: "project-settings" }
  | {
      kind: "prompt";
      title: string;
      label?: string;
      initial?: string;
      confirm?: string;
      selectStem?: boolean;
      onSubmit: (value: string) => void | Promise<void>;
    }
  | {
      kind: "confirm";
      title: string;
      message: string;
      confirm?: string;
      danger?: boolean;
      onConfirm: () => void | Promise<void>;
    };

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
}

export type SettingsTab =
  | "general"
  | "appearance"
  | "keybinds"
  | "github"
  | "ai"
  | "latex"
  | "uninstall";

interface UI {
  sidebar: boolean;
  pdf: boolean;
  chat: boolean;
  logs: boolean;
  commentMarks: boolean;
  sidebarTab: "files" | "git";
  palette: boolean;
  settings: SettingsTab | null;
}

interface AppState {
  info: AppInfo | null;
  settings: Settings | null;
  customThemes: Theme[];
  projects: ProjectSummary[];
  sync: Record<string, SyncStatus>;
  current: string | null;
  ui: UI;
  dialog: Dialog | null;
  toasts: Toast[];

  init: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshInfo: () => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  saveCustomTheme: (theme: Theme) => void;
  deleteCustomTheme: (id: string) => Promise<void>;
  openProject: (name: string | null) => void;
  setUi: (patch: Partial<UI>) => void;
  toggle: (key: "sidebar" | "pdf" | "chat" | "logs" | "palette") => void;
  openDialog: (d: Dialog | null) => void;
  toast: (message: string, kind?: Toast["kind"]) => void;
  fail: (e: unknown) => void;
  setSync: (s: SyncStatus) => void;
}

const UI_KEY = "quilltex.ui";

function loadUi(): UI {
  const base: UI = {
    sidebar: true,
    pdf: true,
    chat: false,
    logs: false,
    commentMarks: true,
    sidebarTab: "files",
    palette: false,
    settings: null,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(UI_KEY) || "{}");
    return { ...base, ...saved, palette: false, settings: null };
  } catch {
    return base;
  }
}

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  info: null,
  settings: null,
  customThemes: loadCustomThemes(),
  projects: [],
  sync: {},
  current: null,
  ui: loadUi(),
  dialog: null,
  toasts: [],

  async init() {
    const [info, settings] = await Promise.all([
      api.appInfo(),
      api.getSettings(),
    ]);
    set({ info, settings });
    document.documentElement.classList.add(`platform-${info.platform}`);
    applyTheme(settings.theme, get().customThemes);
    applyFontSize(settings.editorFontSize);
    void api
      .githubStatus()
      .then(async ({ user }) => {
        set({ settings: { ...get().settings!, githubUser: user } });
        await get().refreshInfo();
      })
      .catch(() => {});
    await get().refreshProjects();
    try {
      const last = localStorage.getItem("quilltex.lastProject");
      if (last && get().projects.some((p) => p.name === last))
        get().openProject(last);
    } catch {}
  },

  async refreshProjects() {
    try {
      set({ projects: await api.listProjects() });
    } catch (e) {
      get().fail(e);
    }
  },

  async refreshInfo() {
    set({ info: await api.appInfo() });
  },

  async saveSettings(patch) {
    const cur = get().settings;
    if (!cur) return;
    try {
      const next = await api.saveSettings({ ...cur, ...patch });
      set({ settings: next });
      if (patch.theme) applyTheme(next.theme, get().customThemes);
      if (patch.editorFontSize) applyFontSize(next.editorFontSize);
      if (patch.projectsRoot) {
        await get().refreshInfo();
        await get().refreshProjects();
        set({ current: null });
      }
    } catch (e) {
      get().fail(e);
    }
  },

  saveCustomTheme(theme) {
    const rest = get().customThemes.filter((t) => t.id !== theme.id);
    const customThemes = [...rest, { ...theme, custom: true }];
    persistCustomThemes(customThemes);
    set({ customThemes });
    if (get().settings?.theme === theme.id) applyTheme(theme.id, customThemes);
  },

  async deleteCustomTheme(id) {
    const customThemes = get().customThemes.filter((t) => t.id !== id);
    persistCustomThemes(customThemes);
    set({ customThemes });
    if (get().settings?.theme === id)
      await get().saveSettings({ theme: "system" });
  },

  openProject(name) {
    set({ current: name });
    try {
      if (name) localStorage.setItem("quilltex.lastProject", name);
      else localStorage.removeItem("quilltex.lastProject");
    } catch {}
  },

  setUi(patch) {
    const ui = { ...get().ui, ...patch };
    if (patch.palette) ui.settings = null;
    else if (patch.settings) ui.palette = false;
    set({
      ui,
      ...((patch.palette || patch.settings) && get().dialog
        ? { dialog: null }
        : {}),
    });
    try {
      const { palette: _p, settings: _s, ...persist } = ui;
      localStorage.setItem(UI_KEY, JSON.stringify(persist));
    } catch {}
  },

  toggle(key) {
    get().setUi({ [key]: !get().ui[key] } as Partial<UI>);
  },

  openDialog(dialog) {
    if (dialog) get().setUi({ palette: false, settings: null });
    set({ dialog });
  },

  toast(message, kind = "info") {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, message }] });
    setTimeout(
      () => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
      kind === "error" ? 7000 : 3500,
    );
  },

  fail(e) {
    get().toast(errorMessage(e), "error");
  },

  setSync(s) {
    set({ sync: { ...get().sync, [s.project]: s } });
  },
}));
