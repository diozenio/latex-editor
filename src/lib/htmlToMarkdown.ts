// Turns formatted text pasted from Word, Google Docs or a web page into the
// Markdown that documents (.md) understand, keeping colors as <span style="color: …">.
import TurndownService from "turndown";
import { tables, taskListItems } from "turndown-plugin-gfm";

const DEFAULT_COLORS =
  /^(#000(000)?|black|windowtext|inherit|initial|currentcolor|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(,\s*1\s*)?\))$/i;

function hexColor(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v || DEFAULT_COLORS.test(v)) return null;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
  if (rgb)
    return `#${rgb
      .slice(1, 4)
      .map((n) => Number(n).toString(16).padStart(2, "0"))
      .join("")}`;
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(v) || /^[a-z]+$/.test(v)) return v;
  return null;
}

interface Look {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string | null;
}

function lookOf(el: HTMLElement): Look {
  const s = el.style;
  const weight = s.fontWeight;
  const deco = `${s.textDecoration} ${s.textDecorationLine}`;
  return {
    bold:
      weight === "bold" || weight === "bolder" || Number(weight) >= 600
        ? true
        : weight === "normal" || (Number(weight) > 0 && Number(weight) < 600)
          ? false
          : undefined,
    italic: s.fontStyle === "italic" ? true : undefined,
    underline: /underline/.test(deco) || undefined,
    strike: /line-through/.test(deco) || undefined,
    color: s.color ? hexColor(s.color) : undefined,
  };
}

// Inline styles become the tags turndown knows; colors become marked spans.
function wrap(el: HTMLElement, look: Look) {
  const doc = el.ownerDocument;
  let inner: Node[] = [...el.childNodes];
  const add = (tag: string, attrs?: Record<string, string>) => {
    const w = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) w.setAttribute(k, v);
    w.append(...inner);
    inner = [w];
  };
  if (look.color) add("span", { "data-color": look.color });
  if (look.strike) add("del");
  if (look.underline) add("u");
  if (look.italic) add("em");
  if (look.bold) add("strong");
  return inner;
}

function normalize(root: HTMLElement) {
  for (const el of root.querySelectorAll(
    "style, meta, script, title, img, o\\:p",
  ))
    el.remove();
  // Google Docs wraps the whole selection in <b style="font-weight:normal">.
  for (const el of root.querySelectorAll<HTMLElement>(
    "b[id^='docs-internal-guid']",
  ))
    el.replaceWith(...el.childNodes);
  for (const el of [
    ...root.querySelectorAll<HTMLElement>("[style]"),
  ].reverse()) {
    const look = lookOf(el);
    if (el.tagName === "SPAN" || el.tagName === "FONT") {
      el.replaceWith(...wrap(el, look));
    } else if (/^(B|STRONG)$/.test(el.tagName) && look.bold === false) {
      el.replaceWith(...wrap(el, { ...look, bold: undefined }));
    } else if (
      look.color ||
      look.bold ||
      look.italic ||
      look.underline ||
      look.strike
    ) {
      if (/^H[1-6]$/.test(el.tagName)) look.bold = undefined;
      el.replaceChildren(...wrap(el, look));
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>("font[color]")) {
    const color = hexColor(el.getAttribute("color") ?? "");
    el.replaceWith(...(color ? wrap(el, { color }) : [...el.childNodes]));
  }
  // Tables pasted from documents have no header row; the first row becomes it.
  for (const table of root.querySelectorAll("table")) {
    const first = table.rows[0];
    if (!first || first.parentElement?.tagName === "THEAD") continue;
    for (const td of [...first.cells]) {
      if (td.tagName === "TH") continue;
      const th = root.ownerDocument.createElement("th");
      th.append(...td.childNodes);
      td.replaceWith(th);
    }
  }
  for (const p of root.querySelectorAll("td p, th p, li > p:only-child")) {
    p.after(" ");
    p.replaceWith(...p.childNodes);
  }
}

let service: TurndownService | null = null;

function turndown() {
  if (service) return service;
  service = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
  });
  service.use([tables, taskListItems]);
  service.addRule("underline", {
    filter: ["u", "ins"],
    replacement: (content) => (content.trim() ? `<u>${content}</u>` : content),
  });
  service.addRule("strike", {
    filter: (node) => /^(DEL|S|STRIKE)$/.test(node.nodeName),
    replacement: (content) => (content.trim() ? `~~${content}~~` : content),
  });
  service.addRule("color", {
    filter: (node) =>
      node.nodeName === "SPAN" && node.hasAttribute("data-color"),
    replacement: (content, node) =>
      content.trim()
        ? `<span style="color: ${(node as HTMLElement).getAttribute("data-color")}">${content}</span>`
        : content,
  });
  return service;
}

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  normalize(doc.body);
  return turndown()
    .turndown(doc.body)
    .replace(/ /g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
