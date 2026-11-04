import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  api,
  type CompileResult,
  type FileNode,
  type PdfSpot,
  type ProjectSummary,
  type RepoStatus,
} from "@/lib/ipc";
import { useApp } from "./app";

export type TabKind = "text" | "image" | "pdf" | "binary";

export interface Doc {
  content: string;
  saved: string;
  version: number;
}

const TEXT_EXT =
  /\.(tex|bib|cls|sty|bst|txt|md|bbx|cbx|dtx|ins|ltx|latexmkrc|gitignore|csv|tsv|json|yaml|yml|toml|xml|svg|lua|py|r|m|tikz|pgf|def|cfg|clo|fd)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function tabKind(path: string): TabKind {
  if (IMAGE_EXT.test(path)) return "image";
  if (/\.pdf$/i.test(path)) return "pdf";
  if (TEXT_EXT.test(path) || !/\.[^/]+$/.test(path.split("/").pop() ?? ""))
    return "text";
  return "binary";
}

interface ProjectState {
  project: ProjectSummary | null;
  session: number;
  tree: FileNode[];
  tabs: string[];
  active: string | null;
  docs: Record<string, Doc>;
  compiling: boolean;
  compileStatus: string | null;
  result: CompileResult | null;
  pdfVersion: number;
  highlights: { spots: PdfSpot[]; nonce: number };
  jump: { path: string; line: number; nonce: number } | null;
  git: RepoStatus | null;
  cursorLine: number;

  load: (name: string) => Promise<void>;
  followRename: (from: string, to: string) => Promise<void>;
  unload: () => void;
  refreshTree: () => Promise<void>;
  refreshGit: () => Promise<void>;
  refreshMeta: () => Promise<void>;
  openFile: (path: string, line?: number) => Promise<void>;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  edit: (path: string, content: string) => void;
  save: (path: string) => Promise<void>;
  saveAll: () => Promise<void>;
  commit: () => Promise<void>;
  compile: () => Promise<void>;
  scheduleCompile: () => void;
  onExternalChange: (paths: string[]) => Promise<void>;
  forwardSearch: (path: string, line: number) => Promise<void>;
  inverseSearch: (page: number, x: number, y: number) => Promise<void>;
  renamed: (from: string, to: string) => void;
  removed: (path: string) => void;
  setCursorLine: (line: number) => void;
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const writing = new Map<string, string>();
const writeChains = new Map<string, Promise<void>>();
const AUTOSAVE_MS = 250;
let compileTimer: ReturnType<typeof setTimeout> | undefined;
let compileQueued = false;

export function projectExists(name: string) {
  return api.projectSummary(name).then(
    () => true,
    () => false,
  );
}

export const useProject = create<ProjectState>((set, get) => ({
  project: null,
  session: 0,
  tree: [],
  tabs: [],
  active: null,
  docs: {},
  compiling: false,
  compileStatus: null,
  result: null,
  pdfVersion: 0,
  highlights: { spots: [], nonce: 0 },
  jump: null,
  git: null,
  cursorLine: 1,

  async load(name) {
    const fail = useApp.getState().fail;
    try {
      const project = await api.projectSummary(name);
      set({
        project,
        session: get().session + 1,
        tree: [],
        tabs: [],
        active: null,
        docs: {},
        result: null,
        compiling: false,
        git: null,
        pdfVersion: Date.now(),
      });
      await Promise.all([get().refreshTree(), get().refreshGit()]);
      let restored: string[] = [];
      try {
        restored = JSON.parse(
          localStorage.getItem(`quilltex.tabs.${name}`) || "[]",
        );
      } catch {}
      const exists = (p: string) =>
        flatten(get().tree).some((n) => n.path === p);
      const toOpen = restored.filter(exists);
      if (!toOpen.length && exists(project.meta.mainFile))
        toOpen.push(project.meta.mainFile);
      for (const p of toOpen) await get().openFile(p);
      if (
        exists(project.meta.mainFile) &&
        get().tabs.includes(project.meta.mainFile)
      )
        get().setActive(project.meta.mainFile);
      void get().compile();
    } catch (e) {
      fail(e);
    }
  },

  async followRename(from, to) {
    if (from === to || get().project?.name === to) return;
    moveTabs(from, to);
    const app = useApp.getState();
    if (get().project?.name === from) {
      try {
        const project = await api.projectSummary(to);
        if (get().project?.name !== from) return;
        set({ project });
        if (app.current === from) app.openProject(to);
        void get().saveAll();
        await Promise.all([get().refreshTree(), get().refreshGit()]);
        void api.syncNow(to);
      } catch (e) {
        app.fail(e);
      }
    }
    await app.refreshProjects();
  },

  unload() {
    saveTimers.forEach((t) => clearTimeout(t));
    saveTimers.clear();
    void get().saveAll();
    set({
      project: null,
      session: get().session + 1,
      tree: [],
      tabs: [],
      active: null,
      docs: {},
      result: null,
      git: null,
    });
  },

  async refreshTree() {
    const p = get().project;
    if (!p) return;
    try {
      set({ tree: await api.fileTree(p.name) });
    } catch (e) {
      useApp.getState().fail(e);
    }
  },

  async refreshGit() {
    const p = get().project;
    if (!p) return;
    try {
      const git = await api.gitStatus(p.name);
      set({ git });
    } catch {
      set({ git: null });
    }
  },

  async refreshMeta() {
    const p = get().project;
    if (!p) return;
    set({ project: await api.projectSummary(p.name) });
  },

  async openFile(path, line) {
    const p = get().project;
    if (!p) return;
    const kind = tabKind(path);
    if (kind === "text" && !get().docs[path]) {
      try {
        const content = await api.readText(p.name, path);
        set({
          docs: {
            ...get().docs,
            [path]: { content, saved: content, version: 1 },
          },
        });
      } catch (e) {
        useApp.getState().fail(e);
        return;
      }
    }
    const tabs = get().tabs.includes(path) ? get().tabs : [...get().tabs, path];
    set({ tabs, active: path });
    persistTabs(p.name, tabs);
    if (line) set({ jump: { path, line, nonce: Date.now() } });
  },

  closeTab(path) {
    const { tabs, active, docs, project } = get();
    const doc = docs[path];
    if (doc && doc.content !== doc.saved) void get().save(path);
    const idx = tabs.indexOf(path);
    const next = tabs.filter((t) => t !== path);
    const { [path]: _, ...rest } = docs;
    set({
      tabs: next,
      docs: rest,
      active:
        active === path
          ? (next[Math.min(idx, next.length - 1)] ?? null)
          : active,
    });
    if (project) persistTabs(project.name, next);
  },

  setActive(path) {
    set({ active: path });
  },

  edit(path, content) {
    const doc = get().docs[path];
    if (!doc || doc.content === content) return;
    set({ docs: { ...get().docs, [path]: { ...doc, content } } });
    clearTimeout(saveTimers.get(path));
    saveTimers.set(
      path,
      setTimeout(() => void get().save(path), AUTOSAVE_MS),
    );
  },

  save(path) {
    clearTimeout(saveTimers.get(path));
    const project = get().project;
    const session = get().session;
    const snapshot = get().docs[path];
    const run = (writeChains.get(path) ?? Promise.resolve()).then(async () => {
      const same = get().session === session && !!get().project;
      const p = same ? get().project : project;
      const doc = (same && get().docs[path]) || snapshot;
      if (!p || !doc || doc.content === doc.saved) return;
      const content = doc.content;
      writing.set(path, content);
      try {
        await api.writeText(p.name, path, content);
        const cur =
          get().session === session && get().project
            ? get().docs[path]
            : undefined;
        if (cur)
          set({ docs: { ...get().docs, [path]: { ...cur, saved: content } } });
      } catch (e) {
        useApp.getState().fail(e);
      } finally {
        setTimeout(
          () => writing.get(path) === content && writing.delete(path),
          1000,
        );
      }
    });
    writeChains.set(path, run);
    return run;
  },

  async saveAll() {
    await Promise.all(Object.keys(get().docs).map((p) => get().save(p)));
  },

  async commit() {
    const p = get().project;
    if (!p) return;
    if (p.meta.autoCompile) await get().compile();
    else await get().saveAll();
  },

  scheduleCompile() {
    clearTimeout(compileTimer);
    compileTimer = setTimeout(() => void get().compile(), 900);
  },

  async compile() {
    const p = get().project;
    if (!p) return;
    if (get().compiling) {
      compileQueued = true;
      return;
    }
    clearTimeout(compileTimer);
    await get().saveAll();
    const session = get().session;
    set({ compiling: true, compileStatus: null });
    const unlisten = await listen<{ project: string; message: string }>(
      "compile-status",
      (e) => {
        if (e.payload.project === p.name && get().session === session)
          set({ compileStatus: e.payload.message });
      },
    );
    try {
      const result = await api.compile(p.name);
      if (get().session !== session) return;
      set({ result, pdfVersion: result.pdf ? Date.now() : get().pdfVersion });
      const errors = result.diagnostics.filter(
        (d) => d.severity === "error",
      ).length;
      if (!result.ok && errors) useApp.getState().setUi({ logs: true });
    } catch (e) {
      if (get().session === session) {
        set({
          result: {
            ok: false,
            pdf: null,
            log: String(e),
            diagnostics: [
              { severity: "error", file: null, line: null, message: String(e) },
            ],
            durationMs: 0,
          },
        });
        useApp.getState().setUi({ logs: true });
      }
    } finally {
      unlisten();
      set({ compiling: false, compileStatus: null });
      if (compileQueued) {
        compileQueued = false;
        get().scheduleCompile();
      }
    }
  },

  async onExternalChange(paths) {
    const p = get().project;
    if (!p) return;
    if (paths.includes("") && !(await projectExists(p.name))) return;
    const fileChanges = paths.filter((x) => x !== ".git" && x !== "");
    if (fileChanges.length) await get().refreshTree();
    void get().refreshGit();
    if (fileChanges.some((x) => x === ".quilltex/project.json"))
      void get().refreshMeta();

    let texChanged = false;
    for (const path of fileChanges) {
      const doc = get().docs[path];
      if (!doc) continue;
      let disk: string;
      try {
        disk = await api.readText(p.name, path);
      } catch {
        continue;
      }
      if (disk === writing.get(path)) continue;
      if (disk === doc.saved || disk === doc.content) {
        if (disk !== doc.saved)
          set({ docs: { ...get().docs, [path]: { ...doc, saved: disk } } });
        continue;
      }
      if (doc.content === doc.saved) {
        set({
          docs: {
            ...get().docs,
            [path]: { content: disk, saved: disk, version: doc.version + 1 },
          },
        });
        texChanged ||= /\.(tex|bib)$/i.test(path);
      } else {
        useApp
          .getState()
          .toast(
            `${path} changed on disk while you had unsaved edits. Your version is kept.`,
            "error",
          );
      }
    }
    if (
      !texChanged &&
      fileChanges.some((x) => /\.(tex|bib|cls|sty)$/i.test(x) && !get().docs[x])
    )
      texChanged = true;
    if (texChanged && p.meta.autoCompile) get().scheduleCompile();
  },

  async forwardSearch(path, line) {
    const p = get().project;
    if (!p) return;
    try {
      const spots = await api.synctexForward(p.name, path, line);
      if (spots.length) {
        set({ highlights: { spots, nonce: Date.now() } });
        useApp.getState().setUi({ pdf: true });
      }
    } catch {}
  },

  async inverseSearch(page, x, y) {
    const p = get().project;
    if (!p) return;
    try {
      const spot = await api.synctexInverse(p.name, page, x, y);
      if (spot) await get().openFile(spot.file, spot.line);
    } catch {}
  },

  renamed(from, to) {
    const { tabs, docs, active, project } = get();
    const map = (p: string) =>
      p === from
        ? to
        : p.startsWith(from + "/")
          ? to + p.slice(from.length)
          : p;
    const nextDocs: Record<string, Doc> = {};
    for (const [k, v] of Object.entries(docs)) nextDocs[map(k)] = v;
    const nextTabs = tabs.map(map);
    set({
      tabs: nextTabs,
      docs: nextDocs,
      active: active ? map(active) : null,
    });
    if (project) persistTabs(project.name, nextTabs);
  },

  removed(path) {
    for (const t of get().tabs.filter(
      (t) => t === path || t.startsWith(path + "/"),
    )) {
      const { [t]: _, ...rest } = get().docs;
      set({ docs: rest });
      get().closeTab(t);
    }
  },

  setCursorLine(line) {
    set({ cursorLine: line });
  },
}));

function moveTabs(from: string, to: string) {
  try {
    const tabs = localStorage.getItem(`quilltex.tabs.${from}`);
    if (tabs !== null) localStorage.setItem(`quilltex.tabs.${to}`, tabs);
    localStorage.removeItem(`quilltex.tabs.${from}`);
  } catch {}
}

function persistTabs(project: string, tabs: string[]) {
  try {
    localStorage.setItem(`quilltex.tabs.${project}`, JSON.stringify(tabs));
  } catch {}
}

export function flatten(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((n) => [n, ...(n.children ? flatten(n.children) : [])]);
}
