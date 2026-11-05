import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import type { EditorView, Panel, ViewUpdate } from "@codemirror/view";
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronRight,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "@/lib/i18n";

const MAX_COUNT = 5000;

function countMatches(state: EditorState, query: SearchQuery) {
  if (!query.valid) return { total: 0, current: 0 };
  const sel = state.selection.main;
  let total = 0;
  let current = 0;
  const cursor = query.getCursor(state);
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    total++;
    if (r.value.from === sel.from && r.value.to === sel.to) current = total;
    if (total >= MAX_COUNT) break;
  }
  return { total, current };
}

function Toggle({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`icon-btn sm${active ? " active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Find({ view, state }: { view: EditorView; state: EditorState }) {
  const external = getSearchQuery(state);
  const [search, setSearch] = useState(external.search);
  const [replace, setReplace] = useState(external.replace);
  const [caseSensitive, setCase] = useState(external.caseSensitive);
  const [regexp, setRegexp] = useState(external.regexp);
  const [wholeWord, setWord] = useState(external.wholeWord);
  const [showReplace, setShowReplace] = useState(external.replace !== "");

  useEffect(() => {
    setSearch(external.search);
    setReplace(external.replace);
    setCase(external.caseSensitive);
    setRegexp(external.regexp);
    setWord(external.wholeWord);
  }, [
    external.search,
    external.replace,
    external.caseSensitive,
    external.regexp,
    external.wholeWord,
  ]);

  const push = (
    next: Partial<ConstructorParameters<typeof SearchQuery>[0]>,
  ) => {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search,
          replace,
          caseSensitive,
          regexp,
          wholeWord,
          ...next,
        }),
      ),
    });
  };

  const { total, current } = countMatches(state, external);
  const empty = search === "";
  const status = empty
    ? ""
    : total === 0
      ? t("editor.search.noResults")
      : `${current || "?"}/${total}${total >= MAX_COUNT ? "+" : ""}`;

  const onKeyDown = (e: React.KeyboardEvent, onEnter: () => void) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSearchPanel(view);
      view.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey && e.currentTarget.getAttribute("name") === "search")
        findPrevious(view);
      else onEnter();
    }
  };

  return (
    <div className="find-panel">
      <button
        type="button"
        className={`icon-btn sm find-expand${showReplace ? " open" : ""}`}
        title={t("editor.search.replace")}
        aria-label={t("editor.search.replace")}
        onClick={() => setShowReplace((v) => !v)}
      >
        <ChevronRight size={14} />
      </button>
      <div className="find-rows">
        <div className="find-row">
          <div className="find-field">
            <input
              name="search"
              main-field="true"
              className="find-input"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              placeholder={t("editor.search.find")}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                push({ search: e.target.value });
              }}
              onKeyDown={(e) => onKeyDown(e, () => findNext(view))}
            />
            <Toggle
              active={caseSensitive}
              label={t("editor.search.matchCase")}
              onClick={() => {
                setCase(!caseSensitive);
                push({ caseSensitive: !caseSensitive });
              }}
            >
              <CaseSensitive size={18} />
            </Toggle>
            <Toggle
              active={wholeWord}
              label={t("editor.search.byWord")}
              onClick={() => {
                setWord(!wholeWord);
                push({ wholeWord: !wholeWord });
              }}
            >
              <WholeWord size={18} />
            </Toggle>
            <Toggle
              active={regexp}
              label={t("editor.search.regexp")}
              onClick={() => {
                setRegexp(!regexp);
                push({ regexp: !regexp });
              }}
            >
              <Regex size={16} />
            </Toggle>
          </div>
          <span
            className={`find-status${total === 0 && !empty ? " none" : ""}`}
          >
            {status}
          </span>
          <button
            type="button"
            className="icon-btn sm"
            title={t("editor.search.previous")}
            aria-label={t("editor.search.previous")}
            onClick={() => findPrevious(view)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            title={t("editor.search.next")}
            aria-label={t("editor.search.next")}
            onClick={() => findNext(view)}
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            title={t("editor.search.close")}
            aria-label={t("editor.search.close")}
            onClick={() => {
              closeSearchPanel(view);
              view.focus();
            }}
          >
            <X size={14} />
          </button>
        </div>
        {showReplace && (
          <div className="find-row">
            <div className="find-field">
              <input
                name="replace"
                className="find-input"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                placeholder={t("editor.search.replace")}
                value={replace}
                onChange={(e) => {
                  setReplace(e.target.value);
                  push({ replace: e.target.value });
                }}
                onKeyDown={(e) => onKeyDown(e, () => replaceNext(view))}
              />
            </div>
            <button
              type="button"
              className="icon-btn sm"
              title={t("editor.search.replaceOne")}
              aria-label={t("editor.search.replaceOne")}
              onClick={() => replaceNext(view)}
            >
              <Replace size={14} />
            </button>
            <button
              type="button"
              className="icon-btn sm"
              title={t("editor.search.replaceAll")}
              aria-label={t("editor.search.replaceAll")}
              onClick={() => replaceAll(view)}
            >
              <ReplaceAll size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "find-host";
  let root: Root | null = createRoot(dom);
  const render = (state: EditorState) =>
    root?.render(<Find view={view} state={state} />);
  render(view.state);
  return {
    dom,
    top: true,
    update(u: ViewUpdate) {
      render(u.state);
    },
    destroy() {
      const r = root;
      root = null;
      queueMicrotask(() => r?.unmount());
    },
  };
}
