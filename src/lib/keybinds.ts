import { create } from "zustand";
import { isMac } from "./format";
import { type MessageKey, t, useT } from "./i18n";
import { api } from "./ipc";

export type KeyScope = "global" | "local";

export interface KeyAction {
  id: string;
  label: MessageKey;
  group: MessageKey;
  scope: KeyScope;
  default: string;
  menu?: boolean;
  repeat?: boolean;
}

export const ACTIONS: KeyAction[] = [
  {
    id: "command-palette",
    label: "keys.action.command-palette",
    group: "keys.group.general",
    scope: "global",
    default: "Mod+K",
    menu: true,
  },
  {
    id: "settings",
    label: "keys.action.settings",
    group: "keys.group.general",
    scope: "global",
    default: "Mod+,",
    menu: true,
  },
  {
    id: "toggle-sidebar",
    label: "keys.action.toggle-sidebar",
    group: "keys.group.view",
    scope: "global",
    default: "Mod+B",
    menu: true,
  },
  {
    id: "toggle-pdf",
    label: "keys.action.toggle-pdf",
    group: "keys.group.view",
    scope: "global",
    default: "Mod+Shift+P",
    menu: true,
  },
  {
    id: "toggle-chat",
    label: "keys.action.toggle-chat",
    group: "keys.group.view",
    scope: "global",
    default: "Mod+J",
    menu: true,
  },
  {
    id: "toggle-git",
    label: "keys.action.toggle-git",
    group: "keys.group.view",
    scope: "global",
    default: "Mod+Shift+G",
    menu: true,
  },
  {
    id: "zoom-in",
    label: "keys.action.zoom-in",
    group: "keys.group.view",
    scope: "global",
    default: "Mod++",
    repeat: true,
  },
  {
    id: "zoom-out",
    label: "keys.action.zoom-out",
    group: "keys.group.view",
    scope: "global",
    default: "Mod+-",
    repeat: true,
  },
  {
    id: "zoom-reset",
    label: "keys.action.zoom-reset",
    group: "keys.group.view",
    scope: "global",
    default: "Mod+0",
  },
  {
    id: "compile",
    label: "keys.action.compile",
    group: "keys.group.project",
    scope: "global",
    default: "Mod+Enter",
    menu: true,
  },
  {
    id: "save",
    label: "keys.action.save",
    group: "keys.group.project",
    scope: "global",
    default: "Mod+S",
    menu: true,
  },
  {
    id: "close-file",
    label: "keys.action.close-file",
    group: "keys.group.project",
    scope: "global",
    default: "Mod+W",
    menu: true,
  },
  {
    id: "new-file",
    label: "keys.action.new-file",
    group: "keys.group.project",
    scope: "global",
    default: "Mod+N",
    menu: true,
  },
  {
    id: "new-project",
    label: "keys.action.new-project",
    group: "keys.group.project",
    scope: "global",
    default: "Mod+Shift+N",
    menu: true,
  },
  {
    id: "import-zip",
    label: "keys.action.import-zip",
    group: "keys.group.project",
    scope: "global",
    default: "Mod+Shift+O",
    menu: true,
  },
  {
    id: "download-pdf",
    label: "keys.action.download-pdf",
    group: "keys.group.project",
    scope: "global",
    default: "Mod+Shift+S",
    menu: true,
  },
  {
    id: "chat-send",
    label: "keys.action.chat-send",
    group: "keys.group.text",
    scope: "local",
    default: "Enter",
  },
  {
    id: "git-commit",
    label: "keys.action.git-commit",
    group: "keys.group.text",
    scope: "local",
    default: "Mod+Enter",
  },
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
const STORAGE_KEY = "quilltex.keybinds";
const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift"];

function loadOverrides(): Record<string, string | null> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const out: Record<string, string | null> = {};
    for (const [id, v] of Object.entries(raw)) {
      if (!BY_ID.has(id)) continue;
      if (typeof v === "string" || v === null) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

interface KeybindState {
  overrides: Record<string, string | null>;
  setBinding: (id: string, combo: string | null) => void;
  reset: (id: string) => void;
  resetAll: () => void;
}

function persist(overrides: Record<string, string | null>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {}
}

export const useKeybinds = create<KeybindState>((set, get) => ({
  overrides: loadOverrides(),
  setBinding(id, combo) {
    const overrides = { ...get().overrides, [id]: combo };
    persist(overrides);
    set({ overrides });
  },
  reset(id) {
    const { [id]: _removed, ...overrides } = get().overrides;
    persist(overrides);
    set({ overrides });
  },
  resetAll() {
    persist({});
    set({ overrides: {} });
  },
}));

export function bindingFor(
  id: string,
  overrides = useKeybinds.getState().overrides,
): string | null {
  return id in overrides ? overrides[id] : (BY_ID.get(id)?.default ?? null);
}

export function isCustomized(
  id: string,
  overrides: Record<string, string | null>,
) {
  return id in overrides && overrides[id] !== BY_ID.get(id)?.default;
}

export function parseCombo(combo: string) {
  const mods = new Set<string>();
  let key = combo;
  for (;;) {
    const m = MODIFIERS.find(
      (x) => key.startsWith(`${x}+`) && key.length > x.length + 1,
    );
    if (!m) break;
    mods.add(m);
    key = key.slice(m.length + 1);
  }
  return { mods, key };
}

function keyName(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "Dead", "Process"].includes(e.key))
    return null;
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^Numpad\d$/.test(e.code)) return e.code.slice(6);
  if (e.key === " ") return "Space";
  if (e.key.length === 1) return e.key.toUpperCase();
  return e.key;
}

export function eventToCombo(e: KeyboardEvent): string | null {
  const key = keyName(e);
  if (!key) return null;
  if (!isMac && e.metaKey) return null;
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey && !(key === "+" && e.code === "Equal")) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function candidates(e: KeyboardEvent): string[] {
  const combo = eventToCombo(e);
  if (!combo) return [];
  const { mods, key } = parseCombo(combo);
  if (key === "=" && e.code === "Equal")
    return [combo, [...mods, "+"].join("+")];
  return [combo];
}

export function matches(id: string, e: KeyboardEvent): boolean {
  const bound = bindingFor(id);
  return !!bound && candidates(e).includes(bound);
}

const MAC_KEYS: Record<string, string> = {
  Enter: "↵",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Tab: "⇥",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

export function formatComboParts(combo: string): string[] {
  const { mods, key } = parseCombo(combo);
  if (isMac) {
    return [
      mods.has("Mod") && "⌘",
      mods.has("Ctrl") && "⌃",
      mods.has("Alt") && "⌥",
      mods.has("Shift") && "⇧",
      MAC_KEYS[key] ?? key,
    ].filter((p): p is string => !!p);
  }
  return [
    (mods.has("Mod") || mods.has("Ctrl")) && "Ctrl",
    mods.has("Alt") && "Alt",
    mods.has("Shift") && "Shift",
    key === "+" ? "Plus" : key.replace("Arrow", ""),
  ].filter((p): p is string => !!p);
}

export function formatCombo(combo: string): string {
  const parts = formatComboParts(combo);
  return isMac ? parts.join("") : parts.join("+");
}

export function useShortcut(id: string): string {
  const overrides = useKeybinds((s) => s.overrides);
  const bound = bindingFor(id, overrides);
  return bound ? formatCombo(bound) : "";
}

export function useHint(label: MessageKey, id: string): string {
  const translate = useT();
  const s = useShortcut(id);
  return s ? `${translate(label)} (${s})` : translate(label);
}

const ACCEL_KEYS: Record<string, string> = {
  Enter: "Enter",
  Escape: "Escape",
  Space: "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  "-": "Minus",
  "=": "Equal",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "`": "Backquote",
};

export function toAccelerator(combo: string): string | null {
  const { mods, key } = parseCombo(combo);
  const k =
    /^[A-Z0-9]$/.test(key) || /^F\d{1,2}$/.test(key) ? key : ACCEL_KEYS[key];
  if (!k) return null;
  const parts = [
    mods.has("Mod") && "CmdOrCtrl",
    mods.has("Ctrl") && "Ctrl",
    mods.has("Alt") && "Alt",
    mods.has("Shift") && "Shift",
    k,
  ].filter(Boolean);
  return parts.join("+");
}

const MENU_LABELS = [
  "about",
  "settings",
  "storage",
  "uninstall",
  "hide",
  "hideOthers",
  "quit",
  "file",
  "new-project",
  "import-zip",
  "clone-repo",
  "new-file",
  "save",
  "export-zip",
  "download-pdf",
  "close-file",
  "edit",
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
  "view",
  "command-palette",
  "toggle-sidebar",
  "toggle-pdf",
  "toggle-chat",
  "toggle-git",
  "compile",
  "fullscreen",
  "window",
  "minimize",
  "maximize",
] as const;

export function syncMenu() {
  if (!isMac) return;
  const { overrides } = useKeybinds.getState();
  const accels: Record<string, string> = {};
  for (const a of ACTIONS) {
    if (!a.menu) continue;
    const bound = bindingFor(a.id, overrides);
    accels[a.id] = (bound && toAccelerator(bound)) || "";
  }
  const labels: Record<string, string> = {};
  for (const id of MENU_LABELS) labels[`menu.${id}`] = t(`menu.${id}`);
  void api.setMenuAccelerators(accels, labels).catch(() => {});
}

export function validate(
  action: KeyAction,
  combo: string,
  overrides: Record<string, string | null>,
  replacing?: string,
): string | null {
  const { mods, key } = parseCombo(combo);
  if (key === "Escape") return t("keys.errEscape");
  if (action.scope === "global") {
    const hasMod = mods.has("Mod") || mods.has("Ctrl") || mods.has("Alt");
    if (!hasMod && !/^F\d{1,2}$/.test(key)) return t("keys.errNeedsModifier");
  }
  if (combo !== replacing) {
    for (const other of ACTIONS) {
      if (other.scope !== action.scope) continue;
      if (other.id !== action.id && bindingFor(other.id, overrides) === combo)
        return t("keys.errInUse", { label: t(other.label) });
    }
  }
  return null;
}

let recording = false;
export function setRecording(on: boolean) {
  recording = on;
}

export function installGlobalKeybinds(run: (id: string) => void) {
  const onKey = (e: KeyboardEvent) => {
    if (recording || e.isComposing) return;
    const cands = candidates(e);
    if (!cands.length) return;
    const scoped = (e.target as HTMLElement | null)
      ?.closest?.("[data-keys]")
      ?.getAttribute("data-keys");
    const hit = (id: string) => {
      const bound = bindingFor(id);
      return !!bound && cands.includes(bound);
    };
    if (scoped?.split(" ").some(hit)) return;
    const action = ACTIONS.find((a) => a.scope === "global" && hit(a.id));
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && !action.repeat) return;
    run(action.id);
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
