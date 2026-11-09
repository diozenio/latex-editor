// Front matter of rich-text documents (.md): `key: value` lines between `---`.
// Mirrors crates/core/src/markdown.rs, which reads the same keys when typesetting.

export interface DocSettings {
  title: string;
  author: string;
  date: string;
  font: string;
  fontSize: string;
  spacing: string;
  margins: string;
  paper: string;
  numbered: string;
}

const DEFAULTS: DocSettings = {
  title: "",
  author: "",
  date: "",
  font: "serif",
  fontSize: "12",
  spacing: "1.15",
  margins: "2.5cm",
  paper: "a4",
  numbered: "false",
};

export function splitFrontMatter(src: string): {
  front: string;
  body: string;
} {
  const m = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { front: "", body: src };
  return { front: m[0], body: src.slice(m[0].length) };
}

export function readSettings(front: string): DocSettings {
  const out = { ...DEFAULTS };
  for (const line of front.split(/\r?\n/)) {
    const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!m || !(m[1] in out)) continue;
    out[m[1] as keyof DocSettings] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

export function countWords(markdown: string): number {
  return splitFrontMatter(markdown)
    .body.replace(/<[^>]+>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>`|~-]/g, " ")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
