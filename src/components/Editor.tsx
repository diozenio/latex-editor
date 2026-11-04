import { useEffect, useRef } from "react";
import { EditorState, type Extension, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  HighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { latex, latexCompletionSource } from "codemirror-lang-latex";
import { useProject } from "@/stores/project";
import { useApp } from "@/stores/app";
import { refCompletion, refreshRefs } from "@/lib/refs";

const theme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "var(--bg-elevated)" },
  ".cm-content": { caretColor: "var(--accent)", padding: "14px 0 40vh" },
  ".cm-line": { padding: "0 20px 0 14px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--bg-selected) !important",
  },
  ".cm-gutters": {
    backgroundColor: "var(--bg-elevated)",
    color: "var(--text-quaternary)",
    border: "none",
    paddingLeft: "6px",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-secondary)" },
  ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--text-quaternary)", padding: "0 4px" },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "1px solid var(--blue-border)", borderRadius: "2px" },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
  ".cm-searchMatch": { backgroundColor: "rgba(250, 204, 21, 0.3)", borderRadius: "2px" },
  ".cm-searchMatch-selected": { backgroundColor: "rgba(250, 204, 21, 0.6)" },
  ".cm-panels": { backgroundColor: "var(--bg-content)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": { padding: "8px 12px", fontFamily: "var(--font-sans)", fontSize: "12px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontFamily: "var(--font-sans)", fontSize: "12px" },
  ".cm-textfield": {
    border: "1px solid var(--border-strong)",
    borderRadius: "6px",
    background: "var(--bg-elevated)",
    padding: "3px 6px",
  },
  ".cm-button": {
    backgroundImage: "none",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)",
    borderRadius: "6px",
    padding: "2px 8px",
  },
  ".cm-tooltip": {
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg-elevated)",
    borderRadius: "8px",
    boxShadow: "var(--shadow-lg)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "12px", padding: "4px" },
  ".cm-tooltip-autocomplete > ul > li": { borderRadius: "5px", padding: "3px 8px !important" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "#fff" },
  ".cm-completionDetail": { color: "var(--text-tertiary)", fontStyle: "normal", marginLeft: "8px" },
  ".cm-diagnostic": { fontFamily: "var(--font-sans)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--red)" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--orange)" },
  ".cm-jump-line": { backgroundColor: "var(--accent-soft)", transition: "background 1s" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.function(t.variableName), t.macroName], color: "var(--hl-command, #7c3aed)" },
  { tag: [t.tagName, t.typeName, t.className], color: "var(--hl-env, #2563eb)", fontWeight: "500" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--text-tertiary)", fontStyle: "italic" },
  { tag: [t.string, t.special(t.string), t.labelName], color: "var(--hl-string, #059669)" },
  { tag: [t.number, t.unit], color: "var(--hl-number, #d97706)" },
  { tag: [t.bracket, t.brace, t.squareBracket, t.paren], color: "var(--text-tertiary)" },
  { tag: [t.heading, t.strong], fontWeight: "650", color: "var(--text)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.operator, t.punctuation, t.separator], color: "var(--text-secondary)" },
  { tag: [t.special(t.variableName), t.atom, t.meta, t.processingInstruction], color: "var(--hl-math, #db2777)" },
  { tag: t.invalid, color: "var(--red)" },
]);

const fontSize = new Compartment();

function extensions(path: string, onChange: (text: string) => void, onLine: (l: number) => void): Extension[] {
  const isTex = /\.(tex|sty|cls|ltx|dtx|bib)$/i.test(path);
  const p = useProject.getState;
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter({ openText: "▾", closedText: "▸" }),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of((e) => e.altKey),
    indentOnInput(),
    syntaxHighlighting(highlight),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorView.lineWrapping,
    theme,
    fontSize.of(EditorView.theme({ "&": { fontSize: `${useApp.getState().settings?.editorFontSize ?? 13}px` } })),
    ...(isTex
      ? [
          latex({ enableAutocomplete: false, autoCloseBrackets: false, enableLinting: false, enableTooltips: true }),
          autocompletion({ override: [refCompletion, latexCompletionSource(true)], activateOnTyping: true }),
        ]
      : [autocompletion()]),
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (void p().save(path), true) },
      { key: "Mod-Enter", preventDefault: true, run: () => (void p().compile(), true) },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        // ⌘/Ctrl-click: jump to this spot in the PDF (SyncTeX).
        if (!(e.metaKey || e.ctrlKey) || !isTex) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        void p().forwardSearch(path, view.state.doc.lineAt(pos).number);
        return false;
      },
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(u.state.doc.toString());
      if (u.selectionSet || u.docChanged) onLine(u.state.doc.lineAt(u.state.selection.main.head).number);
    }),
  ];
}

/** One EditorView; each open file keeps its own EditorState (and undo history). */
export function Editor({ path }: { path: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, { state: EditorState; version: number }>());
  const doc = useProject((s) => s.docs[path]);
  const jump = useProject((s) => s.jump);
  const project = useProject((s) => s.project);
  const tree = useProject((s) => s.tree);
  const editorFontSize = useApp((s) => s.settings?.editorFontSize ?? 13);

  // Mount once.
  useEffect(() => {
    const v = new EditorView({ parent: host.current! });
    view.current = v;
    return () => v.destroy();
  }, []);

  // Swap documents, keeping the outgoing one's state (undo history, cursor).
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const v = view.current;
    if (!v || !doc) return;
    if (shown.current && shown.current !== path) {
      const prev = states.current.get(shown.current);
      if (prev) prev.state = v.state;
    }
    let entry = states.current.get(path);
    if (!entry) {
      entry = {
        state: EditorState.create({
          doc: doc.content,
          extensions: extensions(
            path,
            (text) => useProject.getState().edit(path, text),
            (line) => useProject.getState().setCursorLine(line),
          ),
        }),
        version: doc.version,
      };
      states.current.set(path, entry);
    }
    if (shown.current !== path) {
      v.setState(entry.state);
      shown.current = path;
      v.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, !!doc]);

  // External reloads (disk changed, Claude edited the file…).
  useEffect(() => {
    const v = view.current;
    const entry = states.current.get(path);
    if (!v || !doc || !entry || doc.version === entry.version) return;
    entry.version = doc.version;
    if (v.state.doc.toString() !== doc.content) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc.content } });
    }
  }, [doc?.version, path, doc]);

  // Forget states of closed tabs.
  const tabs = useProject((s) => s.tabs);
  useEffect(() => {
    for (const k of [...states.current.keys()]) if (!tabs.includes(k)) states.current.delete(k);
  }, [tabs]);

  // Go to line.
  useEffect(() => {
    const v = view.current;
    if (!v || !jump || jump.path !== path) return;
    const line = v.state.doc.line(Math.min(Math.max(1, jump.line), v.state.doc.lines));
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    v.focus();
  }, [jump, path]);

  useEffect(() => {
    view.current?.dispatch({
      effects: fontSize.reconfigure(EditorView.theme({ "&": { fontSize: `${editorFontSize}px` } })),
    });
  }, [editorFontSize, path]);

  // Keep \ref / \cite completions fresh.
  useEffect(() => {
    if (project) void refreshRefs(project.name, tree);
  }, [project, tree]);

  return <div className="editor-host" ref={host} />;
}
