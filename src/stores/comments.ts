import { create } from "zustand";
import { t } from "@/lib/i18n";
import { api } from "@/lib/ipc";
import { useApp } from "./app";

export interface CommentMessage {
  id: string;
  author: string;
  text: string;
  createdAt: number;
  editedAt?: number;
}

export interface CommentThread {
  id: string;
  file: string;
  from: number;
  to: number;
  quote: string;
  resolved: boolean;
  orphaned?: boolean;
  createdAt: number;
  messages: CommentMessage[];
}

export interface Draft {
  file: string;
  from: number;
  to: number;
  quote: string;
}

export interface Anchor {
  id: string;
  from: number;
  to: number;
  quote: string;
}

interface CommentsState {
  project: string | null;
  threads: CommentThread[];
  activeId: string | null;
  draft: Draft | null;

  load: (project: string) => Promise<void>;
  reload: () => Promise<void>;
  unload: () => void;
  startDraft: (draft: Draft) => void;
  cancelDraft: () => void;
  addThread: (text: string) => void;
  reply: (id: string, text: string) => void;
  editMessage: (id: string, messageId: string, text: string) => void;
  deleteMessage: (id: string, messageId: string) => void;
  deleteThread: (id: string) => void;
  setResolved: (id: string, resolved: boolean) => void;
  focus: (id: string | null) => void;
  reanchor: (file: string, anchors: Anchor[]) => void;
  relocate: (file: string, content: string) => void;
  renamed: (from: string, to: string) => void;
  removed: (path: string) => void;
}

export const COMMENTS_FILE = ".quilltex/comments.json";
const SAVE_MS = 400;
const QUOTE_MAX = 200;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let lastWritten = "";
let pendingCommit: string | null = null;
let counter = 0;

function uid() {
  return `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function currentAuthor() {
  const user = useApp.getState().settings?.githubUser;
  return user?.name || user?.login || t("comments.you");
}

function parse(raw: string): CommentThread[] {
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.threads)) return [];
    return data.threads.filter(
      (th: CommentThread) =>
        th &&
        typeof th.id === "string" &&
        typeof th.file === "string" &&
        Array.isArray(th.messages) &&
        th.messages.length > 0,
    );
  } catch {
    return [];
  }
}

function serialize(threads: CommentThread[]) {
  return `${JSON.stringify({ version: 1, threads }, null, 2)}\n`;
}

export const useComments = create<CommentsState>((set, get) => {
  const update = (
    fn: (threads: CommentThread[]) => CommentThread[],
    commit?: string,
  ) => {
    set({ threads: fn(get().threads) });
    if (commit) pendingCommit = commit;
    schedule();
  };

  const schedule = () => {
    clearTimeout(saveTimer);
    const { project } = get();
    if (!project) return;
    saveTimer = setTimeout(() => void flush(), SAVE_MS);
  };

  const flush = async () => {
    clearTimeout(saveTimer);
    const { project, threads } = get();
    if (!project) return;
    const text = serialize(threads);
    const message = pendingCommit;
    pendingCommit = null;
    try {
      if (text !== lastWritten) {
        lastWritten = text;
        await api.writeText(project, COMMENTS_FILE, text);
      }
      if (message) await api.gitCommitPaths(project, [COMMENTS_FILE], message);
    } catch (e) {
      useApp.getState().fail(e);
    }
  };

  const read = async (project: string) => {
    try {
      const raw = await api.readText(project, COMMENTS_FILE);
      return { raw, threads: parse(raw) };
    } catch {
      return { raw: "", threads: [] as CommentThread[] };
    }
  };

  return {
    project: null,
    threads: [],
    activeId: null,
    draft: null,

    async load(project) {
      clearTimeout(saveTimer);
      set({ project, threads: [], activeId: null, draft: null });
      lastWritten = "";
      pendingCommit = null;
      const { raw, threads } = await read(project);
      if (get().project !== project) return;
      lastWritten = raw;
      set({ threads });
    },

    async reload() {
      const project = get().project;
      if (!project) return;
      const { raw, threads } = await read(project);
      if (get().project !== project || raw === lastWritten) return;
      if (!raw && get().threads.length) return;
      lastWritten = raw;
      set({
        threads,
        activeId: threads.some((th) => th.id === get().activeId)
          ? get().activeId
          : null,
      });
    },

    unload() {
      void flush();
      set({ project: null, threads: [], activeId: null, draft: null });
      lastWritten = "";
      pendingCommit = null;
    },

    startDraft(draft) {
      set({ draft, activeId: null });
    },

    cancelDraft() {
      set({ draft: null });
    },

    addThread(text) {
      const { draft } = get();
      const body = text.trim();
      if (!draft || !body) return;
      const now = Date.now();
      const thread: CommentThread = {
        id: uid(),
        file: draft.file,
        from: draft.from,
        to: draft.to,
        quote: draft.quote,
        resolved: false,
        createdAt: now,
        messages: [
          { id: uid(), author: currentAuthor(), text: body, createdAt: now },
        ],
      };
      set({ draft: null, activeId: thread.id });
      update((all) => [...all, thread], `add comment on ${draft.file}`);
    },

    reply(id, text) {
      const body = text.trim();
      if (!body) return;
      update(
        (all) =>
          all.map((th) =>
            th.id === id
              ? {
                  ...th,
                  messages: [
                    ...th.messages,
                    {
                      id: uid(),
                      author: currentAuthor(),
                      text: body,
                      createdAt: Date.now(),
                    },
                  ],
                }
              : th,
          ),
        "reply to comment",
      );
    },

    editMessage(id, messageId, text) {
      const body = text.trim();
      if (!body) return;
      update(
        (all) =>
          all.map((th) =>
            th.id === id
              ? {
                  ...th,
                  messages: th.messages.map((m) =>
                    m.id === messageId && m.text !== body
                      ? { ...m, text: body, editedAt: Date.now() }
                      : m,
                  ),
                }
              : th,
          ),
        "edit comment",
      );
    },

    deleteMessage(id, messageId) {
      const thread = get().threads.find((th) => th.id === id);
      if (!thread) return;
      if (thread.messages.length <= 1) return get().deleteThread(id);
      update(
        (all) =>
          all.map((th) =>
            th.id === id
              ? {
                  ...th,
                  messages: th.messages.filter((m) => m.id !== messageId),
                }
              : th,
          ),
        "delete comment",
      );
    },

    deleteThread(id) {
      if (get().activeId === id) set({ activeId: null });
      update(
        (all) => all.filter((th) => th.id !== id),
        "delete comment thread",
      );
    },

    setResolved(id, resolved) {
      update(
        (all) => all.map((th) => (th.id === id ? { ...th, resolved } : th)),
        resolved ? "resolve comment thread" : "reopen comment thread",
      );
    },

    focus(id) {
      set({ activeId: id });
    },

    reanchor(file, anchors) {
      const byId = new Map(anchors.map((a) => [a.id, a]));
      const changed = get().threads.some((th) => {
        const a = th.file === file && byId.get(th.id);
        return (
          a && (a.from !== th.from || a.to !== th.to || a.quote !== th.quote)
        );
      });
      if (!changed) return;
      update((all) =>
        all.map((th) => {
          const a = th.file === file ? byId.get(th.id) : undefined;
          return a
            ? { ...th, from: a.from, to: a.to, quote: a.quote, orphaned: false }
            : th;
        }),
      );
    },

    relocate(file, content) {
      let changed = false;
      const next = get().threads.map((th) => {
        if (th.file !== file) return th;
        const len = th.quote.length;
        if (content.startsWith(th.quote, th.from) && th.to - th.from >= 0) {
          if (!th.orphaned) return th;
          changed = true;
          return { ...th, orphaned: false };
        }
        changed = true;
        if (!th.quote) {
          const at = Math.min(th.from, content.length);
          return { ...th, from: at, to: at, orphaned: true };
        }
        let best = -1;
        for (
          let i = content.indexOf(th.quote);
          i >= 0;
          i = content.indexOf(th.quote, i + 1)
        )
          if (best < 0 || Math.abs(i - th.from) < Math.abs(best - th.from))
            best = i;
        if (best < 0) {
          const at = Math.min(th.from, content.length);
          return { ...th, from: at, to: at, orphaned: true };
        }
        const span = th.to - th.from;
        return {
          ...th,
          from: best,
          to: best + Math.min(span, len),
          orphaned: false,
        };
      });
      if (changed) update(() => next);
    },

    renamed(from, to) {
      const map = (p: string) =>
        p === from
          ? to
          : p.startsWith(`${from}/`)
            ? to + p.slice(from.length)
            : p;
      if (!get().threads.some((th) => map(th.file) !== th.file)) return;
      update((all) => all.map((th) => ({ ...th, file: map(th.file) })));
    },

    removed(path) {
      const gone = (p: string) => p === path || p.startsWith(`${path}/`);
      if (!get().threads.some((th) => gone(th.file))) return;
      update((all) => all.filter((th) => !gone(th.file)));
    },
  };
});

export function quoteOf(text: string) {
  return text.slice(0, QUOTE_MAX);
}

export function lineOf(content: string, pos: number) {
  let line = 1;
  for (let i = content.indexOf("\n"); i >= 0 && i < pos; ) {
    line++;
    i = content.indexOf("\n", i + 1);
  }
  return line;
}
