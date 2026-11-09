import { Download, Eye, Maximize2, Minus, Plus } from "lucide-react";
import MarkdownIt from "markdown-it";
import { useEffect, useMemo, useRef, useState } from "react";
import { readSettings, splitFrontMatter } from "@/lib/frontMatter";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/ipc";
import { useProject } from "@/stores/project";
import { downloadPdf } from "./PdfViewer";

// A live, paginated look at a Markdown document that mirrors what
// crates/core/src/markdown.rs typesets, without waiting for a compile.

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

const PX_PER_MM = 96 / 25.4;
const PAPER: Record<string, [number, number]> = {
  a4: [210, 297],
  letter: [215.9, 279.4],
  a5: [148, 210],
};

type Zoom = "fit" | number;

interface Layout {
  pageW: number;
  pageH: number;
  margin: number;
  fontSize: number;
  lineHeight: number;
  sans: boolean;
  numbered: boolean;
}

function layoutOf(front: string): Layout {
  const s = readSettings(front);
  const [w, h] = PAPER[s.paper] ?? PAPER.a4;
  const m = /^(\d+(?:\.\d+)?)(cm|mm|in|pt)$/.exec(s.margins.trim());
  const marginMm = m
    ? Number(m[1]) *
      ({ cm: 10, mm: 1, in: 25.4, pt: 25.4 / 72.27 } as const)[
        m[2] as "cm" | "mm" | "in" | "pt"
      ]
    : 25;
  const size = Math.min(12, Math.max(10, Number(s.fontSize) || 12));
  const stretch = Number(s.spacing);
  return {
    pageW: w * PX_PER_MM,
    pageH: h * PX_PER_MM,
    margin: marginMm * PX_PER_MM,
    fontSize: size,
    lineHeight: 1.2 * (stretch >= 0.5 && stretch <= 4 ? stretch : 1.15),
    sans: s.font === "sans",
    numbered: s.numbered === "true",
  };
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

function renderHtml(src: string): string {
  const { front, body } = splitFrontMatter(src);
  const s = readSettings(front);
  let title = "";
  if (s.title.trim()) {
    const date =
      s.date.trim() === "today"
        ? new Date().toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })
        : s.date;
    title = `<div class="docp-title"><div class="t">${escapeHtml(s.title)}</div><div class="a">${escapeHtml(s.author)}</div><div class="d">${escapeHtml(date)}</div></div>`;
  }
  return (
    title +
    inlineTags(md.render(body)).replace(
      /<li>(\s*<p>)?\[([ xX])\]\s?/g,
      (_, p: string | undefined, c: string) =>
        `<li class="task${c.trim() ? " done" : ""}">${p ?? ""}`,
    )
  );
}

// Same names and values as color_hex in crates/core/src/markdown.rs.
const COLORS: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  gray: "808080",
  grey: "808080",
  silver: "C0C0C0",
  red: "FF0000",
  darkred: "8B0000",
  maroon: "800000",
  crimson: "DC143C",
  orange: "FFA500",
  darkorange: "FF8C00",
  gold: "FFD700",
  yellow: "FFFF00",
  olive: "808000",
  lime: "00FF00",
  green: "008000",
  darkgreen: "006400",
  teal: "008080",
  cyan: "00FFFF",
  aqua: "00FFFF",
  blue: "0000FF",
  darkblue: "00008B",
  navy: "000080",
  indigo: "4B0082",
  purple: "800080",
  violet: "EE82EE",
  magenta: "FF00FF",
  fuchsia: "FF00FF",
  pink: "FFC0CB",
  brown: "A52A2A",
};

function colorHex(c: string): string | null {
  const v = c.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v.slice(1);
  if (/^#[0-9a-f]{3}$/.test(v))
    return [...v.slice(1)].map((x) => x + x).join("");
  return COLORS[v] ?? null;
}

function span(color: string | undefined) {
  const hex = color && colorHex(color);
  return hex ? `<span style="color:#${hex}">` : "<span>";
}

// markdown-it escapes all HTML; only these tags are turned back on, outside code.
function inlineTags(html: string): string {
  return html
    .split(/(<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/&lt;(\/?)u&gt;/gi, "<$1u>")
            .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
            .replace(
              /&lt;span\s+style\s*=\s*(?:&quot;|')([^&']*)(?:&quot;|')\s*&gt;/gi,
              (_, style: string) =>
                span(/(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style)?.[1]),
            )
            .replace(/&lt;span\s*&gt;/gi, "<span>")
            .replace(
              /&lt;font\s+color\s*=\s*(?:&quot;|')?([#\w]+)(?:&quot;|')?\s*&gt;/gi,
              (_, color: string) => span(color),
            )
            .replace(/&lt;\/(?:span|font)&gt;/gi, "</span>"),
    )
    .join("");
}

const blobs = new Map<string, Promise<string | null>>();

function imageUrl(project: string, path: string) {
  const key = `${project}/${path}`;
  let url = blobs.get(key);
  if (!url) {
    url = api.readBinary(project, path).then(
      (buf) => URL.createObjectURL(new Blob([buf])),
      () => {
        blobs.delete(key);
        return null;
      },
    );
    blobs.set(key, url);
  }
  return url;
}

// Images become centered figures, or a framed placeholder when missing, like the PDF.
async function resolveImages(root: HTMLElement, project: string) {
  await Promise.all(
    [...root.querySelectorAll("img")].map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      const alt = img.getAttribute("alt") ?? "";
      if (/^[a-z]+:/i.test(src)) {
        img.replaceWith(document.createTextNode(alt || src));
        return;
      }
      let path = src;
      try {
        path = decodeURI(src);
      } catch {}
      const url = await imageUrl(project, path);
      if (!url) {
        const box = document.createElement("span");
        box.className = "docp-missing";
        box.textContent = `[image: ${path}]`;
        img.replaceWith(box);
        return;
      }
      const fig = document.createElement("span");
      fig.className = "docp-fig";
      const el = document.createElement("img");
      el.src = url;
      fig.append(el);
      if (alt.trim()) {
        const cap = document.createElement("span");
        cap.className = "cap";
        cap.textContent = alt;
        fig.append(cap);
      }
      img.replaceWith(fig);
      await el.decode().catch(() => {});
    }),
  );
}

function numberHeadings(root: HTMLElement) {
  const n = [0, 0, 0];
  for (const h of root.querySelectorAll("h1, h2, h3")) {
    const level = Number(h.tagName[1]) - 1;
    n[level]++;
    for (let i = level + 1; i < 3; i++) n[i] = 0;
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = n.slice(0, level + 1).join(".");
    h.prepend(num);
  }
}

interface Chunk {
  el: HTMLElement;
  // Table rows that start a page repeat the header, as longtable does.
  head?: HTMLElement;
}

// Long lists and tables are cut into items/rows so they can flow across pages.
function chunks(root: HTMLElement): Chunk[] {
  const out: Chunk[] = [];
  for (const child of [...root.children] as HTMLElement[]) {
    if (/^(UL|OL)$/.test(child.tagName) && child.children.length > 1) {
      const items = [...child.children];
      const start = Number(child.getAttribute("start")) || 1;
      items.forEach((li, i) => {
        const list = child.cloneNode(false) as HTMLElement;
        if (child.tagName === "OL")
          list.setAttribute("start", String(start + i));
        if (i > 0) list.classList.add("cont");
        if (i < items.length - 1) list.classList.add("more");
        list.append(li);
        out.push({ el: list });
      });
      child.remove();
    } else if (child.tagName === "TABLE") {
      const head = child.querySelector("thead");
      const rows = [...child.querySelectorAll("tbody > tr")];
      rows.forEach((tr, i) => {
        const table = child.cloneNode(false) as HTMLElement;
        if (i === 0 && head) table.append(head.cloneNode(true));
        else table.classList.add("cont");
        if (i < rows.length - 1) table.classList.add("more");
        const tbody = document.createElement("tbody");
        tbody.append(tr);
        table.append(tbody);
        out.push({
          el: table,
          head: i > 0 && head ? (head as HTMLElement) : undefined,
        });
      });
      if (!rows.length) out.push({ el: child });
      else child.remove();
    } else {
      out.push({ el: child });
    }
  }
  root.replaceChildren(...out.map((c) => c.el));
  return out;
}

function paginate(root: HTMLElement, contentH: number): string[] {
  const list = chunks(root);
  const pages: Chunk[][] = [[]];
  let pageTop = 0;
  for (const c of list) {
    const page = pages[pages.length - 1];
    const bottom = c.el.offsetTop + c.el.offsetHeight;
    if (page.length && bottom - pageTop > contentH) {
      const next: Chunk[] = [c];
      // Keep headings with the text that follows them.
      while (
        page.length > 1 &&
        /^H[1-6]$/.test(page[page.length - 1].el.tagName)
      )
        next.unshift(page.pop()!);
      pages.push(next);
      pageTop = next[0].el.offsetTop;
    } else {
      page.push(c);
    }
  }
  return pages.map((page) =>
    page
      .map((c, i) => {
        if (i === 0 && c.head) {
          const table = c.el.cloneNode(true) as HTMLElement;
          table.prepend(c.head.cloneNode(true));
          table.classList.remove("cont");
          return table.outerHTML;
        }
        return c.el.outerHTML;
      })
      .join(""),
  );
}

export function DocPreview() {
  const t = useT();
  const project = useProject((s) => s.project);
  const main = project?.meta.mainFile ?? "";
  const open = useProject((s) => s.docs[main]?.content);
  const tree = useProject((s) => s.tree);
  const result = useProject((s) => s.result);
  const [disk, setDisk] = useState("");
  const content = open ?? disk;

  useEffect(() => {
    if (open !== undefined || !project || !main) return;
    api.readText(project.name, main).then(setDisk, () => setDisk(""));
  }, [open === undefined, project?.name, main, tree]);

  const layout = useMemo(
    () => layoutOf(splitFrontMatter(content).front),
    [content],
  );
  const contentW = layout.pageW - 2 * layout.margin;
  const contentH = layout.pageH - 2 * layout.margin;

  const measurer = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<string[]>([]);
  useEffect(() => {
    const el = measurer.current;
    if (!el || !project) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      el.innerHTML = renderHtml(content);
      await resolveImages(el, project.name);
      if (cancelled) return;
      if (layout.numbered) numberHeadings(el);
      setPages(paginate(el, contentH));
      el.replaceChildren();
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [content, project?.name, layout, contentH]);

  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [zoom, setZoom] = useState<Zoom>(() => {
    try {
      const z = localStorage.getItem("quilltex.docZoom");
      return z && z !== "fit" ? Number(z) : "fit";
    } catch {
      return "fit";
    }
  });
  const setZoomPersist = (z: Zoom) => {
    setZoom(z);
    try {
      localStorage.setItem("quilltex.docZoom", String(z));
    } catch {}
  };
  const scale =
    zoom === "fit" ? Math.max(0.2, (width - 32) / layout.pageW) : zoom;

  const pageStyle = {
    width: layout.pageW,
    height: layout.pageH,
    padding: layout.margin,
    fontSize: `${layout.fontSize}pt`,
    lineHeight: layout.lineHeight,
  };

  return (
    <div className="pane" style={{ flex: 1, background: "var(--bg-content)" }}>
      <div className="pdf-toolbar">
        <Eye size={15} style={{ marginLeft: 6 }} />
        <span className="muted" style={{ marginLeft: 6 }}>
          {t("doc.preview")} · {t("doc.pages", { count: pages.length || 1 })}
        </span>
        <div className="grow" />
        <button
          className="icon-btn sm"
          title={t("pdf.zoomOut")}
          onClick={() =>
            setZoomPersist(Math.max(0.3, +(scale - 0.1).toFixed(2)))
          }
        >
          <Minus size={18} />
        </button>
        <span className="zoom">{Math.round(scale * 100)}%</span>
        <button
          className="icon-btn sm"
          title={t("pdf.zoomIn")}
          onClick={() => setZoomPersist(Math.min(4, +(scale + 0.1).toFixed(2)))}
        >
          <Plus size={18} />
        </button>
        <button
          className={`icon-btn sm${zoom === "fit" ? " active" : ""}`}
          title={t("pdf.fitWidth")}
          onClick={() => setZoomPersist("fit")}
        >
          <Maximize2 size={18} />
        </button>
        <button
          className="icon-btn sm"
          title={t("common.downloadPdf")}
          onClick={downloadPdf}
          disabled={!result}
        >
          <Download size={18} />
        </button>
      </div>
      <div
        className="pdf-scroll"
        ref={scroller}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) e.preventDefault();
        }}
      >
        {(pages.length ? pages : [""]).map((html, i) => (
          <div
            key={i}
            className="pdf-page"
            style={{
              width: layout.pageW * scale,
              height: layout.pageH * scale,
            }}
          >
            <div
              className={`docp-page${layout.sans ? " sans" : ""}`}
              style={{ ...pageStyle, transform: `scale(${scale})` }}
            >
              <div
                className="docp-body"
                dangerouslySetInnerHTML={{ __html: html }}
              />
              <div
                className="docp-num"
                style={{ top: layout.margin + contentH + 20 }}
              >
                {i + 1}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div
        ref={measurer}
        aria-hidden
        className={`docp-page docp-body docp-measure${layout.sans ? " sans" : ""}`}
        style={{
          width: contentW,
          fontSize: `${layout.fontSize}pt`,
          lineHeight: layout.lineHeight,
        }}
      />
    </div>
  );
}
