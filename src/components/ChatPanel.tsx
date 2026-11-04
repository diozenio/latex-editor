import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowUp, Check, Loader2, Plus, Sparkles, Square, Wrench, X, AlertCircle, Terminal } from "lucide-react";
import { create } from "zustand";
import { api, errorMessage } from "@/lib/ipc";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";

type Part =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; status: "running" | "done" | "error"; result?: string };

interface Msg {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
}

interface Chat {
  messages: Msg[];
  sessionId: string | null;
}

interface ChatStore {
  chats: Record<string, Chat>;
  running: Record<string, boolean>;
  get: (key: string) => Chat;
  set: (key: string, chat: Chat) => void;
  setRunning: (key: string, v: boolean) => void;
}

const useChats = create<ChatStore>((set, get) => ({
  chats: {},
  running: {},
  get: (key) => get().chats[key] ?? { messages: [], sessionId: null },
  set: (key, chat) => set({ chats: { ...get().chats, [key]: chat } }),
  setRunning: (key, v) => set({ running: { ...get().running, [key]: v } }),
}));

// One stream state per running chat.
const streams = new Map<string, { sawDelta: boolean }>();

function update(key: string, fn: (msgs: Msg[]) => Msg[], sessionId?: string) {
  const s = useChats.getState();
  const chat = s.get(key);
  s.set(key, { messages: fn(chat.messages), sessionId: sessionId ?? chat.sessionId });
}

function withLastAssistant(msgs: Msg[], fn: (m: Msg) => Msg): Msg[] {
  const last = msgs[msgs.length - 1];
  if (last?.role === "assistant") return [...msgs.slice(0, -1), fn(last)];
  return [...msgs, fn({ id: crypto.randomUUID(), role: "assistant", parts: [] })];
}

function appendText(m: Msg, text: string): Msg {
  const last = m.parts[m.parts.length - 1];
  if (last?.kind === "text") return { ...m, parts: [...m.parts.slice(0, -1), { kind: "text", text: last.text + text }] };
  return { ...m, parts: [...m.parts, { kind: "text", text }] };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function handleEvent(key: string, ev: any) {
  const st = streams.get(key) ?? { sawDelta: false };
  streams.set(key, st);
  switch (ev.type) {
    case "system":
      if (ev.session_id) update(key, (m) => m, ev.session_id);
      break;
    case "stream_event": {
      const e = ev.event;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
        st.sawDelta = true;
        update(key, (msgs) => withLastAssistant(msgs, (m) => appendText(m, e.delta.text)));
      }
      break;
    }
    case "assistant": {
      const blocks: any[] = ev.message?.content ?? [];
      update(
        key,
        (msgs) =>
          withLastAssistant(msgs, (m) => {
            let out = m;
            for (const b of blocks) {
              if (b.type === "text" && !st.sawDelta) out = appendText(out, b.text);
              if (b.type === "tool_use")
                out = { ...out, parts: [...out.parts, { kind: "tool", id: b.id, name: b.name, input: b.input ?? {}, status: "running" }] };
            }
            return out;
          }),
        ev.session_id,
      );
      st.sawDelta = false;
      break;
    }
    case "user": {
      const blocks: any[] = Array.isArray(ev.message?.content) ? ev.message.content : [];
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const text = Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join("\n") : String(b.content ?? "");
        update(key, (msgs) =>
          msgs.map((m) => ({
            ...m,
            parts: m.parts.map((p) =>
              p.kind === "tool" && p.id === b.tool_use_id ? { ...p, status: b.is_error ? "error" : "done", result: text } : p,
            ),
          })),
        );
      }
      break;
    }
    case "result":
      if (ev.is_error && ev.result) {
        update(key, (msgs) => withLastAssistant(msgs, (m) => appendText(m, `\n\n⚠️ ${ev.result}`)));
      }
      if (ev.session_id) update(key, (m) => m, ev.session_id);
      break;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let listening = false;
function ensureListeners() {
  if (listening) return;
  listening = true;
  void listen<{ chatId: string; event: unknown }>("chat-event", (e) => handleEvent(e.payload.chatId, e.payload.event));
  void listen<{ chatId: string; ok: boolean; error: string | null }>("chat-done", (e) => {
    const { chatId, error } = e.payload;
    const s = useChats.getState();
    s.setRunning(chatId, false);
    streams.delete(chatId);
    if (error) update(chatId, (msgs) => withLastAssistant(msgs, (m) => appendText(m, `\n\n⚠️ ${error.slice(0, 600)}`)));
    // Mark tools that never reported as done.
    update(chatId, (msgs) =>
      msgs.map((m) => ({ ...m, parts: m.parts.map((p) => (p.kind === "tool" && p.status === "running" ? { ...p, status: "done" } : p)) })),
    );
    void api.chatSave(chatId, useChats.getState().get(chatId));
  });
}

const SUGGESTIONS = [
  "Fix the compile errors in this project",
  "Add an introduction section with a short motivation",
  "Create a new article project called “Notes” with a bibliography",
  "Convert this table to booktabs style",
];

export function ChatPanel() {
  const toggle = useApp((s) => s.toggle);
  const info = useApp((s) => s.info);
  const setUi = useApp((s) => s.setUi);
  const project = useProject((s) => s.project);
  const key = project ? `project-${project.name}` : "global";
  const chat = useChats((s) => s.chats[key]) ?? { messages: [], sessionId: null };
  const running = useChats((s) => !!s.running[key]);
  const [input, setInput] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const loaded = useRef(new Set<string>());

  useEffect(ensureListeners, []);

  useEffect(() => {
    if (loaded.current.has(key)) return;
    loaded.current.add(key);
    api.chatLoad<Chat>(key).then((c) => {
      if (c && !useChats.getState().chats[key]) useChats.getState().set(key, c);
    });
  }, [key]);

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [chat.messages]);

  const send = async (text = input) => {
    text = text.trim();
    if (!text || running) return;
    setInput("");
    const { active, cursorLine } = useProject.getState();
    const context = project
      ? `Open project: "${project.name}" (main file ${project.meta.mainFile}). Open file: ${active ?? "none"} (cursor at line ${cursorLine}).`
      : "No project is open; the user is on the project list.";
    update(key, (m) => [...m, { id: crypto.randomUUID(), role: "user", parts: [{ kind: "text", text }] }]);
    useChats.getState().setRunning(key, true);
    try {
      await useProject.getState().saveAll();
      await api.chatSend(key, text, chat.sessionId, context);
    } catch (e) {
      useChats.getState().setRunning(key, false);
      update(key, (msgs) => withLastAssistant(msgs, (m) => appendText(m, `⚠️ ${errorMessage(e)}`)));
    }
  };

  const reset = () => {
    useChats.getState().set(key, { messages: [], sessionId: null });
    void api.chatSave(key, { messages: [], sessionId: null });
  };

  return (
    <aside className="chat">
      <div className="chat-head">
        <span className="title">
          <Sparkles size={14} /> Assistant
        </span>
        <button className="icon-btn sm" title="New chat" onClick={reset} disabled={running}>
          <Plus size={14} />
        </button>
        <button className="icon-btn sm" title="Close" onClick={() => toggle("chat")}>
          <X size={14} />
        </button>
      </div>
      <div className="chat-body" ref={body}>
        {!info?.claude ? (
          <div className="empty">
            <div className="empty-icon">
              <Terminal size={20} />
            </div>
            <h3>Claude Code not found</h3>
            <p>
              The assistant runs your local Claude Code. Install it, sign in once with <code>claude</code>, then reopen this
              panel.
            </p>
            <button className="btn" onClick={() => setUi({ settings: "claude" })}>
              Open settings
            </button>
          </div>
        ) : chat.messages.length === 0 ? (
          <div style={{ marginTop: "auto" }}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>How can I help?</div>
            <div className="muted">
              I can create and edit projects, write LaTeX, fix compile errors and commit, all through Folio’s own tools.
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          chat.messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.parts.map((p, i) =>
                p.kind === "text" ? (
                  <div key={i} className="bubble">
                    {m.role === "assistant" ? renderMarkdown(p.text) : p.text}
                  </div>
                ) : (
                  <ToolCard key={i} part={p} />
                ),
              )}
            </div>
          ))
        )}
        {running && (
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      <div className="chat-input">
        <div className="chat-box">
          <textarea
            rows={2}
            placeholder={project ? `Ask about “${project.name}”…` : "Ask anything about your projects…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={!info?.claude}
          />
          <div className="row">
            <span className="ctx">{project ? `Context: ${project.name}` : "Context: all projects"}</span>
            {running ? (
              <button className="send-btn" title="Stop" onClick={() => api.chatCancel(key)}>
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button className="send-btn" disabled={!input.trim()} onClick={() => send()}>
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

const TOOL_LABELS: Record<string, string> = {
  list_projects: "Listed projects",
  create_project: "Created project",
  import_zip: "Imported ZIP",
  export_zip: "Exported ZIP",
  rename_project: "Renamed project",
  delete_project: "Deleted project",
  list_files: "Listed files",
  read_file: "Read",
  write_file: "Wrote",
  edit_file: "Edited",
  create_folder: "Created folder",
  move_path: "Moved",
  delete_path: "Deleted",
  compile: "Compiled",
  get_compile_log: "Read log",
  set_main_file: "Set main file",
  git_status: "Git status",
  git_commit: "Committed",
  git_log: "Git log",
  git_diff: "Diff",
  git_branches: "Branches",
  git_create_branch: "Created branch",
  git_checkout: "Switched branch",
  git_merge: "Merged",
  git_pull: "Pulled",
  git_push: "Pushed",
  git_init: "Initialized git",
};

function ToolCard({ part }: { part: Extract<Part, { kind: "tool" }> }) {
  const short = part.name.replace(/^mcp__folio__/, "");
  const arg = (part.input.path ?? part.input.name ?? part.input.project ?? part.input.message ?? "") as string;
  const open = () => {
    const proj = part.input.project as string | undefined;
    const path = part.input.path as string | undefined;
    if (proj && path && useProject.getState().project?.name === proj) void useProject.getState().openFile(path);
  };
  return (
    <div className={`tool-card${part.status === "error" ? " error" : ""}`} title={part.result ?? ""} onClick={open}>
      {part.status === "running" ? (
        <Loader2 size={13} className="spin" />
      ) : part.status === "error" ? (
        <AlertCircle size={13} style={{ color: "var(--red)" }} />
      ) : (
        <Check size={13} style={{ color: "var(--green)" }} />
      )}
      <span className="t-name">{TOOL_LABELS[short] ?? short}</span>
      <span className="t-arg">{String(arg)}</span>
      <Wrench size={12} style={{ opacity: 0.4 }} />
    </div>
  );
}

/** Tiny, safe markdown: fenced code, inline code, bold. No HTML injection. */
function renderMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/```[a-zA-Z]*\n?/);
  parts.forEach((chunk, i) => {
    if (i % 2 === 1) {
      out.push(<pre key={i}>{chunk.replace(/\n$/, "")}</pre>);
      return;
    }
    const segs = chunk.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
    segs.forEach((s, j) => {
      if (s.startsWith("`") && s.endsWith("`") && s.length > 2) out.push(<code key={`${i}-${j}`}>{s.slice(1, -1)}</code>);
      else if (s.startsWith("**") && s.endsWith("**") && s.length > 4) out.push(<strong key={`${i}-${j}`}>{s.slice(2, -2)}</strong>);
      else if (s) out.push(s);
    });
  });
  return out;
}
