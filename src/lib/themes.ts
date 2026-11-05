import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ensureContrast, mixRgb, parseHex, readableOn, toHex } from "./color";
import type { MessageKey } from "./i18n";

export interface Palette {
  bg: string;
  surface: string;
  sunken: string;
  text: string;
  accent: string;
  command: string;
  env: string;
  string: string;
  number: string;
  math: string;
}

export interface Theme {
  id: string;
  name: string;
  mode: "light" | "dark";
  palette: Palette;
  custom?: boolean;
}

export const PALETTE_FIELDS: [keyof Palette, MessageKey][] = [
  ["bg", "settings.palette.bg"],
  ["surface", "settings.palette.surface"],
  ["sunken", "settings.palette.sunken"],
  ["text", "settings.palette.text"],
  ["accent", "settings.palette.accent"],
  ["command", "settings.palette.command"],
  ["env", "settings.palette.env"],
  ["string", "settings.palette.string"],
  ["number", "settings.palette.number"],
  ["math", "settings.palette.math"],
];

export const BUILTIN_THEMES: Theme[] = [
  {
    id: "nord",
    name: "Nord",
    mode: "dark",
    palette: {
      bg: "#2e3440",
      surface: "#3b4252",
      sunken: "#272c36",
      text: "#eceff4",
      accent: "#88c0d0",
      command: "#c3a5bd",
      env: "#96b1cc",
      string: "#a3be8c",
      number: "#daa08e",
      math: "#ebcb8b",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    mode: "dark",
    palette: {
      bg: "#282a36",
      surface: "#303341",
      sunken: "#21222c",
      text: "#f8f8f2",
      accent: "#bd93f9",
      command: "#ff79c6",
      env: "#8be9fd",
      string: "#f1fa8c",
      number: "#ffb86c",
      math: "#50fa7b",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    mode: "dark",
    palette: {
      bg: "#1a1b26",
      surface: "#24283b",
      sunken: "#16161e",
      text: "#c0caf5",
      accent: "#7aa2f7",
      command: "#bb9af7",
      env: "#7dcfff",
      string: "#9ece6a",
      number: "#ff9e64",
      math: "#f7768e",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    mode: "dark",
    palette: {
      bg: "#282828",
      surface: "#32302f",
      sunken: "#1d2021",
      text: "#ebdbb2",
      accent: "#fabd2f",
      command: "#d3869b",
      env: "#83a598",
      string: "#b8bb26",
      number: "#fe8019",
      math: "#fc6857",
    },
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    mode: "dark",
    palette: {
      bg: "#191724",
      surface: "#1f1d2e",
      sunken: "#13111e",
      text: "#e0def4",
      accent: "#c4a7e7",
      command: "#ebbcba",
      env: "#9ccfd8",
      string: "#f6c177",
      number: "#eb6f92",
      math: "#568da3",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    mode: "dark",
    palette: {
      bg: "#272822",
      surface: "#2f302a",
      sunken: "#1e1f1a",
      text: "#f8f8f2",
      accent: "#a6e22e",
      command: "#fb5e97",
      env: "#66d9ef",
      string: "#e6db74",
      number: "#ae81ff",
      math: "#fd971f",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    mode: "light",
    palette: {
      bg: "#fdf6e3",
      surface: "#fffbed",
      sunken: "#eee8d5",
      text: "#073642",
      accent: "#1e6ca4",
      command: "#5d61a9",
      env: "#1e6ca4",
      string: "#606e00",
      number: "#b54314",
      math: "#bc3074",
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    mode: "light",
    palette: {
      bg: "#f6f8fa",
      surface: "#ffffff",
      sunken: "#eaeef2",
      text: "#1f2328",
      accent: "#0968d8",
      command: "#7e4ed8",
      env: "#0550ae",
      string: "#0a3069",
      number: "#953800",
      math: "#cf222e",
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    mode: "light",
    palette: {
      bg: "#eff1f5",
      surface: "#ffffff",
      sunken: "#e6e9ef",
      text: "#4c4f69",
      accent: "#1c5fe4",
      command: "#8738ed",
      env: "#03709c",
      string: "#307820",
      number: "#b24608",
      math: "#c0278f",
    },
  },
  {
    id: "paper",
    name: "Paper",
    mode: "light",
    palette: {
      bg: "#f4efe6",
      surface: "#fbf8f2",
      sunken: "#ebe4d6",
      text: "#2b2622",
      accent: "#a64c08",
      command: "#7c3aed",
      env: "#0f726b",
      string: "#47720e",
      number: "#b63d0b",
      math: "#be185d",
    },
  },
];

export const BASE_THEMES: { id: string; name: MessageKey }[] = [
  { id: "system", name: "settings.theme.system" },
  { id: "light", name: "settings.theme.light" },
  { id: "dark", name: "settings.theme.dark" },
];

const CUSTOM_KEY = "quilltex.customThemes";
const OVERRIDE_PROPS = [
  "--bg-window",
  "--bg-content",
  "--bg-elevated",
  "--bg-sunken",
  "--bg-hover",
  "--bg-active",
  "--bg-selected",
  "--border",
  "--border-strong",
  "--text",
  "--text-secondary",
  "--text-tertiary",
  "--text-quaternary",
  "--accent",
  "--accent-hover",
  "--accent-soft",
  "--accent-text",
  "--on-accent",
  "--on-red",
  "--red",
  "--green",
  "--orange",
  "--blue-border",
  "--glow",
  "--overlay",
  "--hl-command",
  "--hl-env",
  "--hl-string",
  "--hl-number",
  "--hl-math",
];

export function loadCustomThemes(): Theme[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((t) => t?.id && t?.name && t?.palette)
      .map((t) => ({ ...t, custom: true }));
  } catch {
    return [];
  }
}

export function persistCustomThemes(themes: Theme[]) {
  try {
    localStorage.setItem(
      CUSTOM_KEY,
      JSON.stringify(themes.map(({ custom: _c, ...t }) => t)),
    );
  } catch {}
}

export function newThemeId() {
  return `custom-${Date.now().toString(36)}`;
}

export function findTheme(id: string, custom: Theme[]): Theme | undefined {
  return [...BUILTIN_THEMES, ...custom].find((t) => t.id === id);
}

function mix(a: string, pct: number, b = "transparent") {
  return `color-mix(in srgb, ${a} ${pct}%, ${b})`;
}

const MARGIN = 0.1;

function paletteVars(mode: Theme["mode"], p: Palette): Record<string, string> {
  const bg = parseHex(p.bg);
  const text = parseHex(p.text);
  const base = [bg, parseHex(p.surface), parseHex(p.sunken)];
  const accentRgb = ensureContrast(parseHex(p.accent), base, 4.5 + MARGIN);
  const selected = mixRgb(bg, accentRgb, 0.2);
  const surfaces = [...base, selected];
  const readable = (hex: string, ratio = 4.5) =>
    toHex(ensureContrast(parseHex(hex), surfaces, ratio + MARGIN));
  const tier = (t: number, ratio: number) =>
    toHex(ensureContrast(mixRgb(bg, text, t), surfaces, ratio + MARGIN));
  const accent = toHex(accentRgb);
  const red = readable(mode === "dark" ? "#ff6369" : "#e5484d");
  const status =
    mode === "dark"
      ? { green: "#3fbf6e", orange: "#f59e42" }
      : { green: "#16a34a", orange: "#ea580c" };
  return {
    "--bg-window": mix(p.bg, 70),
    "--bg-content": p.bg,
    "--bg-elevated": p.surface,
    "--bg-sunken": p.sunken,
    "--bg-hover": mix(p.text, 5),
    "--bg-active": mix(p.text, 9),
    "--bg-selected": mix(p.accent, 20),
    "--border": mix(p.text, 9),
    "--border-strong": mix(p.text, 16),
    "--text": readable(p.text, 7),
    "--text-secondary": tier(0.75, 4.5),
    "--text-tertiary": tier(0.55, 4.5),
    "--text-quaternary": tier(0.4, 3),
    "--accent": accent,
    "--accent-hover": mix(accent, 85, p.text),
    "--accent-soft": mix(accent, 16),
    "--accent-text": readable(toHex(mixRgb(parseHex(accent), text, 0.2))),
    "--on-accent": toHex(readableOn(parseHex(accent))),
    "--on-red": toHex(readableOn(parseHex(red))),
    "--red": red,
    "--green": readable(status.green),
    "--orange": readable(status.orange),
    "--blue-border": mix(accent, 38),
    "--glow": "transparent",
    "--overlay":
      mode === "dark" ? "rgba(0, 0, 0, 0.5)" : "rgba(10, 10, 12, 0.25)",
    "--hl-command": readable(p.command),
    "--hl-env": readable(p.env),
    "--hl-string": readable(p.string),
    "--hl-number": readable(p.number),
    "--hl-math": readable(p.math),
  };
}

export function applyTheme(id: string, custom: Theme[]) {
  const root = document.documentElement;
  for (const prop of OVERRIDE_PROPS) root.style.removeProperty(prop);
  const theme = findTheme(id, custom);
  if (!theme) {
    if (id === "light" || id === "dark") root.setAttribute("data-theme", id);
    else root.removeAttribute("data-theme");
    return;
  }
  root.setAttribute("data-theme", theme.mode);
  for (const [k, v] of Object.entries(paletteVars(theme.mode, theme.palette)))
    root.style.setProperty(k, v);
}

const HEX = /^#[0-9a-f]{6}$/i;

export function snapshotTheme(): Theme {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const read = (prop: string, fallback: string) => {
    const v = css.getPropertyValue(prop).trim();
    return HEX.test(v) ? v : fallback;
  };
  const mode =
    root.getAttribute("data-theme") === "dark" ||
    (!root.hasAttribute("data-theme") &&
      matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light";
  return {
    id: "",
    name: "",
    mode,
    palette: {
      bg: read("--bg-content", "#ffffff"),
      surface: read("--bg-elevated", "#ffffff"),
      sunken: read("--bg-sunken", "#f4f4f6"),
      text: read("--text", "#18181b"),
      accent: read("--accent", "#326dcf"),
      command: read("--hl-command", "#7c3aed"),
      env: read("--hl-env", "#2563eb"),
      string: read("--hl-string", "#059669"),
      number: read("--hl-number", "#d97706"),
      math: read("--hl-math", "#db2777"),
    },
  };
}

export const FONT_BASE = 13;
export const FONT_MIN = 11;
export const FONT_MAX = 16;
const MIN_WINDOW = { width: 960, height: 600 };

export function clampFontSize(px: number) {
  if (!Number.isFinite(px)) return FONT_BASE;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
}

export async function applyFontSize(px: number) {
  const scale = clampFontSize(px) / FONT_BASE;
  document.documentElement.style.setProperty("--ui-scale", String(scale));
  try {
    await getCurrentWebview().setZoom(scale);
    await getCurrentWindow().setMinSize(
      new LogicalSize(
        Math.round(MIN_WINDOW.width * Math.max(1, scale)),
        Math.round(MIN_WINDOW.height * Math.max(1, scale)),
      ),
    );
  } catch {}
}
