import { create } from "zustand";
import { api, errorMessage, type AppInfo, type ProjectSummary, type Settings, type SyncStatus } from "@/lib/ipc";

export type Dialog =
  | { kind: "new-project" }
  | { kind: "clone" }
  | { kind: "publish"; project: string }
  | { kind: "uninstall" }
  | { kind: "diff"; project: string; path: string }
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

export type SettingsTab = "general" | "github" | "claude" | "latex" | "uninstall";

interface UI {
  sidebar: boolean;
  pdf: boolean;
  chat: boolean;
  logs: boolean;
  sidebarTab: "files" | "git";
  palette: boolean;
  settings: SettingsTab | null;
}

interface AppState {
  info: AppInfo | null;
  settings: Settings | null;
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
  openProject: (name: string | null) => void;
  setUi: (patch: Partial<UI>) => void;
  toggle: (key: "sidebar" | "pdf" | "chat" | "logs" | "palette") => void;
  openDialog: (d: Dialog | null) => void;
  toast: (message: string, kind?: Toast["kind"]) => void;
  fail: (e: unknown) => void;
  setSync: (s: SyncStatus) => void;
}

const UI_KEY = "folio.ui";

function loadUi(): UI {
  const base: UI = { sidebar: true, pdf: true, chat: false, logs: false, sidebarTab: "files", palette: false, settings: null };
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
  projects: [],
  sync: {},
  current: null,
  ui: loadUi(),
  dialog: null,
  toasts: [],

  async init() {
    const [info, settings] = await Promise.all([api.appInfo(), api.getSettings()]);
    set({ info, settings });
    document.documentElement.classList.add(`platform-${info.platform}`);
    applyTheme(settings.theme);
    // gh may have signed in or out since last launch (e.g. in a terminal).
    void api
      .githubStatus()
      .then(async ({ user }) => {
        set({ settings: { ...get().settings!, githubUser: user } });
        await get().refreshInfo();
      })
      .catch(() => {});
    await get().refreshProjects();
    try {
      const last = localStorage.getItem("folio.lastProject");
      if (last && get().projects.some((p) => p.name === last)) get().openProject(last);
    } catch {
      /* storage unavailable */
    }
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
      if (patch.theme) applyTheme(next.theme);
      if (patch.projectsRoot) {
        await get().refreshInfo();
        await get().refreshProjects();
        set({ current: null });
      }
    } catch (e) {
      get().fail(e);
    }
  },

  openProject(name) {
    set({ current: name });
    try {
      if (name) localStorage.setItem("folio.lastProject", name);
      else localStorage.removeItem("folio.lastProject");
    } catch {
      /* ignore */
    }
  },

  setUi(patch) {
    const ui = { ...get().ui, ...patch };
    set({ ui });
    try {
      const { palette: _p, settings: _s, ...persist } = ui;
      localStorage.setItem(UI_KEY, JSON.stringify(persist));
    } catch {
      /* ignore */
    }
  },

  toggle(key) {
    get().setUi({ [key]: !get().ui[key] } as Partial<UI>);
  },

  openDialog(dialog) {
    set({ dialog });
  },

  toast(message, kind = "info") {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, message }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === "error" ? 7000 : 3500);
  },

  fail(e) {
    get().toast(errorMessage(e), "error");
  },

  setSync(s) {
    set({ sync: { ...get().sync, [s.project]: s } });
  },
}));

export function applyTheme(theme: Settings["theme"]) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}
