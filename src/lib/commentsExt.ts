import {
  type Extension,
  Facet,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  showTooltip,
  type Tooltip,
} from "@codemirror/view";
import { animate } from "motion";
import { createPopover } from "@/components/CommentPopover";
import { t } from "@/lib/i18n";
import { useApp } from "@/stores/app";
import { type Anchor, quoteOf, useComments } from "@/stores/comments";

interface Mark extends Anchor {
  resolved: boolean;
  orphaned: boolean;
}

interface CommentsField {
  marks: Mark[];
  visible: boolean;
  popover: number | null;
}

export const setComments = StateEffect.define<CommentsField>();

const field = StateField.define<CommentsField>({
  create: () => ({ marks: [], visible: true, popover: null }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setComments)) continue;
      const len = tr.state.doc.length;
      return {
        visible: e.value.visible,
        popover:
          e.value.popover == null ? null : Math.min(e.value.popover, len),
        marks: e.value.marks.map((m) => ({
          ...m,
          from: Math.min(m.from, len),
          to: Math.min(Math.max(m.to, m.from), len),
        })),
      };
    }
    if (!tr.docChanged) return value;
    return {
      ...value,
      popover:
        value.popover == null ? null : tr.changes.mapPos(value.popover, 1),
      marks: value.marks.map((m) => {
        const from = tr.changes.mapPos(m.from, 1);
        const to = Math.max(from, tr.changes.mapPos(m.to, -1));
        return { ...m, from, to };
      }),
    };
  },
});

const pathFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? "",
});

export const view: { current: EditorView | null; path: string | null } = {
  current: null,
  path: null,
};

export function commentAnchors(state: EditorView["state"]): Anchor[] {
  return state.field(field).marks.map(({ id, from, to }) => ({
    id,
    from,
    to,
    quote: quoteOf(state.sliceDoc(from, to)),
  }));
}

export function addCommentAtSelection(): boolean {
  return view.current ? addComment(view.current) : false;
}

export function addComment(v: EditorView): boolean {
  const path = v.state.facet(pathFacet);
  if (!path) return false;
  const sel = v.state.selection.main;
  let { from, to } = sel;
  if (from === to) {
    const line = v.state.doc.lineAt(from);
    from = line.from;
    to = line.to;
  }
  useComments.getState().startDraft({
    file: path,
    from,
    to,
    quote: quoteOf(v.state.sliceDoc(from, to)),
  });
  useApp.getState().setUi({ commentMarks: true });
  return true;
}

class CountMarker extends GutterMarker {
  constructor(
    readonly count: number,
    readonly resolved: boolean,
  ) {
    super();
  }
  eq(other: CountMarker) {
    return other.count === this.count && other.resolved === this.resolved;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-comment-badge${this.resolved ? " resolved" : ""}`;
    el.textContent = String(this.count);
    animate(el, { opacity: [0, 1], scale: [0.6, 1] }, { duration: 0.2 });
    return el;
  }
}

function gutterMarkers(v: EditorView) {
  const { marks, visible } = v.state.field(field);
  if (!visible) return RangeSet.empty;
  const lines = new Map<number, { count: number; open: number }>();
  for (const m of marks) {
    const at = v.state.doc.lineAt(m.from).from;
    const entry = lines.get(at) ?? { count: 0, open: 0 };
    entry.count++;
    if (!m.resolved) entry.open++;
    lines.set(at, entry);
  }
  return RangeSet.of(
    [...lines]
      .sort((a, b) => a[0] - b[0])
      .map(([at, e]) => new CountMarker(e.count, e.open === 0).range(at)),
  );
}

function createTip(v: EditorView) {
  const dom = document.createElement("div");
  dom.className = "cm-comment-tip";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = t("comments.add");
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    addComment(v);
  });
  dom.append(btn);
  animate(
    dom,
    { opacity: [0, 1], y: [-4, 0], scale: [0.94, 1] },
    { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
  );
  return {
    dom,
    mount: () => dom.parentElement?.classList.add("cm-comment-tooltip"),
  };
}

const buttonTooltip = StateField.define<Tooltip | null>({
  create: () => null,
  update(prev, tr) {
    const { main } = tr.state.selection;
    const { visible, popover } = tr.state.field(field);
    if (main.empty || !visible || popover != null) return null;
    if (prev && prev.pos === main.to) return prev;
    return {
      pos: main.to,
      above: false,
      strictSide: true,
      arrow: false,
      create: createTip,
    };
  },
  provide: (f) => showTooltip.from(f),
});

function createPopoverTip(v: EditorView) {
  return createPopover(v, v.state.facet(pathFacet));
}

const popoverTooltip = StateField.define<Tooltip | null>({
  create: () => null,
  update(_, tr) {
    const { visible, popover } = tr.state.field(field);
    if (!visible || popover == null) return null;
    return {
      pos: popover,
      above: false,
      arrow: false,
      create: createPopoverTip,
    };
  },
  provide: (f) => showTooltip.from(f),
});

function threadsAt(v: EditorView, pos: number) {
  return v.state
    .field(field)
    .marks.filter((m) => !m.orphaned && m.from <= pos && pos <= m.to);
}

export function commentsExtension(path: string): Extension {
  return [
    pathFacet.of(path),
    field,
    buttonTooltip,
    popoverTooltip,
    EditorView.decorations.compute([field], (state) => {
      const { marks, visible } = state.field(field);
      if (!visible) return Decoration.none;
      return Decoration.set(
        marks
          .filter((m) => !m.orphaned && m.to > m.from)
          .map((m) =>
            Decoration.mark({
              class: `cm-comment${m.resolved ? " resolved" : ""}`,
            }).range(m.from, m.to),
          ),
        true,
      );
    }),
    gutter({
      class: "cm-comment-gutter",
      markers: gutterMarkers,
      lineMarkerChange: (u) =>
        u.docChanged || u.transactions.some((tr) => tr.effects.length > 0),
      initialSpacer: () => new CountMarker(0, false),
      domEventHandlers: {
        click(v, line) {
          const at = v.state.doc.lineAt(line.from);
          const hit = v.state
            .field(field)
            .marks.find((m) => v.state.doc.lineAt(m.from).from === at.from);
          if (!hit) return false;
          focusThread(hit.id);
          return true;
        },
      },
    }),
    EditorView.domEventHandlers({
      mousedown(e) {
        if ((e.target as HTMLElement).closest(".cm-comment")) return false;
        const comments = useComments.getState();
        if (comments.activeId) comments.focus(null);
        if (comments.draft) comments.cancelDraft();
        return false;
      },
      click(e, v) {
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
        if (!(e.target as HTMLElement).closest(".cm-comment")) return false;
        const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const hit = threadsAt(v, pos)[0];
        if (hit) focusThread(hit.id);
        return false;
      },
    }),
  ];
}

function focusThread(id: string) {
  useComments.getState().focus(id);
}
