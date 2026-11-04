import { save } from "@tauri-apps/plugin-dialog";
import {
  Download,
  FileText,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { basename, mod } from "@/lib/format";
import { api } from "@/lib/ipc";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Zoom = "fit" | number;
interface PageSize {
  w: number;
  h: number;
}

export async function downloadPdf() {
  const { project, result } = useProject.getState();
  const app = useApp.getState();
  if (!project) return;
  if (!result?.pdf) {
    app.toast("Compile the project first", "error");
    return;
  }
  const stem = basename(project.meta.mainFile).replace(/\.tex$/i, "");
  const dest = await save({
    defaultPath: `${project.name === stem ? stem : `${project.name}`}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!dest) return;
  try {
    await api.savePdfAs(project.name, dest);
    app.toast("PDF saved", "success");
  } catch (e) {
    app.fail(e);
  }
}

export function PdfViewer() {
  const {
    project,
    session,
    result,
    pdfVersion,
    compiling,
    highlights,
    compile,
    inverseSearch,
  } = useProject();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [zoom, setZoom] = useState<Zoom>(() => {
    try {
      const z = localStorage.getItem("quilltex.pdfZoom");
      return z && z !== "fit" ? Number(z) : "fit";
    } catch {
      return "fit";
    }
  });
  const [width, setWidth] = useState(600);
  const [page, setPage] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const savedScroll = useRef<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!project || !result?.pdf) return;
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const buf = await api.readBinary(project.name, result.pdf!);
        const d = await pdfjs.getDocument({
          data: new Uint8Array(buf),
          isEvalSupported: false,
        }).promise;
        loaded = d;
        if (cancelled) return void d.destroy();
        const s: PageSize[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          const vp = (await d.getPage(i)).getViewport({ scale: 1 });
          s.push({ w: vp.width, h: vp.height });
        }
        if (cancelled) return void d.destroy();
        if (scroller.current)
          savedScroll.current = {
            top: scroller.current.scrollTop,
            left: scroller.current.scrollLeft,
          };
        setSizes(s);
        setDoc((old) => {
          if (old) setTimeout(() => old.destroy(), 1000);
          return d;
        });
      } catch {}
    })();
    return () => {
      cancelled = true;
      void loaded;
    };
  }, [project?.name, pdfVersion]);

  useEffect(() => {
    setDoc(null);
    setSizes([]);
  }, [session]);

  useLayoutEffect(() => {
    if (savedScroll.current && scroller.current) {
      scroller.current.scrollTop = savedScroll.current.top;
      scroller.current.scrollLeft = savedScroll.current.left;
      savedScroll.current = null;
    }
  }, [doc]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxW = sizes.reduce((m, s) => Math.max(m, s.w), 0) || 612;
  const scale = zoom === "fit" ? Math.max(0.2, (width - 40) / maxW) : zoom;

  const setZoomPersist = (z: Zoom) => {
    setZoom(z);
    try {
      localStorage.setItem("quilltex.pdfZoom", String(z));
    } catch {}
  };

  useEffect(() => {
    const first = highlights.spots[0];
    const el = scroller.current;
    if (!first || !el || !sizes.length) return;
    let top = 16;
    for (let i = 0; i < first.page - 1; i++) top += sizes[i].h * scale + 16;
    el.scrollTo({
      top: Math.max(0, top + first.y * scale - el.clientHeight / 3),
      behavior: "smooth",
    });
  }, [highlights.nonce]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el || !sizes.length) return;
    let y = 16;
    const mid = el.scrollTop + el.clientHeight / 3;
    for (let i = 0; i < sizes.length; i++) {
      y += sizes[i].h * scale + 16;
      if (y > mid) return setPage(i + 1);
    }
  }, [sizes, scale]);

  const z = typeof zoom === "number" ? zoom : scale;
  const errors =
    result?.diagnostics.filter((d) => d.severity === "error").length ?? 0;

  return (
    <div className="pane" style={{ flex: 1, background: "var(--bg-content)" }}>
      <div className="pdf-toolbar">
        <button
          className="icon-btn sm"
          title={`Recompile (${mod}↵)`}
          onClick={() => compile()}
          disabled={compiling}
        >
          <RefreshCw size={13} className={compiling ? "spin" : ""} />
        </button>
        <span className="muted" style={{ marginLeft: 4 }}>
          {doc ? `${page} / ${doc.numPages}` : "—"}
        </span>
        <div className="grow" />
        <button
          className="icon-btn sm"
          title="Zoom out"
          onClick={() => setZoomPersist(Math.max(0.3, +(z - 0.1).toFixed(2)))}
        >
          <Minus size={13} />
        </button>
        <span className="zoom">{Math.round(z * 100)}%</span>
        <button
          className="icon-btn sm"
          title="Zoom in"
          onClick={() => setZoomPersist(Math.min(4, +(z + 0.1).toFixed(2)))}
        >
          <Plus size={13} />
        </button>
        <button
          className={`icon-btn sm${zoom === "fit" ? " active" : ""}`}
          title="Fit width"
          onClick={() => setZoomPersist("fit")}
        >
          <Maximize2 size={12} />
        </button>
        <button
          className="icon-btn sm"
          title="Download PDF"
          onClick={downloadPdf}
          disabled={!result?.pdf}
        >
          <Download size={13} />
        </button>
      </div>
      <div className="pdf-scroll" ref={scroller} onScroll={onScroll}>
        {doc ? (
          sizes.map((s, i) => (
            <PdfPage
              key={i}
              doc={doc}
              index={i + 1}
              size={s}
              scale={scale}
              spots={highlights.spots.filter((h) => h.page === i + 1)}
              nonce={highlights.nonce}
              onInverse={(x, y) => inverseSearch(i + 1, x, y)}
            />
          ))
        ) : (
          <div className="empty" style={{ height: "100%" }}>
            {compiling ? (
              <>
                <Loader2 size={20} className="spin" />
                <p>
                  Compiling… The first run downloads LaTeX packages and can take
                  a minute.
                </p>
              </>
            ) : (
              <>
                <div className="empty-icon">
                  <FileText size={20} />
                </div>
                <h3>{errors ? "Compilation failed" : "No PDF yet"}</h3>
                <p>
                  {errors
                    ? "Check the logs below the editor."
                    : `Press ${mod}↵ to compile.`}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const PdfPage = memo(function PdfPage({
  doc,
  index,
  size,
  scale,
  spots,
  nonce,
  onInverse,
}: {
  doc: PDFDocumentProxy;
  index: number;
  size: PageSize;
  scale: number;
  spots: { x: number; y: number; w: number; h: number }[];
  nonce: number;
  onInverse: (x: number, y: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(index <= 2);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => e.isIntersecting && setVisible(true),
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: ReturnType<
      Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]
    > | null = null;
    (async () => {
      const p = await doc.getPage(index);
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const vp = p.getViewport({ scale: scale * dpr });
      const off = document.createElement("canvas");
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      task = p.render({ canvasContext: off.getContext("2d")!, viewport: vp });
      try {
        await task.promise;
      } catch {
        return;
      }
      const c = canvas.current;
      if (cancelled || !c) return;
      c.width = off.width;
      c.height = off.height;
      c.getContext("2d")!.drawImage(off, 0, 0);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index, scale, visible]);

  const w = size.w * scale;
  const h = size.h * scale;
  return (
    <div
      ref={wrap}
      className="pdf-page"
      style={{ width: w, height: h }}
      title={`${mod}-click to jump to the source`}
      onClick={(e) => {
        if (!(e.metaKey || e.ctrlKey)) return;
        const r = e.currentTarget.getBoundingClientRect();
        onInverse((e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
      }}
    >
      <canvas ref={canvas} style={{ width: w, height: h }} />
      {spots.map((s, i) => (
        <div
          key={`${nonce}-${i}`}
          className="pdf-highlight"
          style={{
            left: s.x * scale - 2,
            top: s.y * scale - 2,
            width: s.w * scale + 4,
            height: Math.max(8, s.h * scale) + 4,
          }}
        />
      ))}
    </div>
  );
});
