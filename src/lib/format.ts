import { getLanguage, t } from "./i18n";

export const isMac =
  typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
export const mod = isMac ? "⌘" : "Ctrl+";

export function timeAgo(ms: number): string {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return t("time.justNow");
  const language = getLanguage();
  const rtf = new Intl.RelativeTimeFormat(language, {
    numeric: "auto",
    style: "narrow",
  });
  const m = Math.round(s / 60);
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return rtf.format(-h, "hour");
  const d = Math.round(h / 24);
  if (d < 7) return rtf.format(-d, "day");
  return new Date(ms).toLocaleDateString(language, {
    month: "short",
    day: "numeric",
    year: d > 300 ? "numeric" : undefined,
  });
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function compactNumber(n: number): string {
  return new Intl.NumberFormat(getLanguage(), {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1000;
    i++;
  } while (v >= 1000 && i < units.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
