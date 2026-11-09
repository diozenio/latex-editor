import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  ArrowUp,
  BookOpen,
  Check,
  Copy,
  FilePlus,
  Loader2,
  Plus,
  Sparkles,
  Square,
  Table,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { hasKey, type MessageKey, useT } from "@/lib/i18n";
import { T } from "@/lib/i18n/T";
import { api, errorMessage } from "@/lib/ipc";
import { matches } from "@/lib/keybinds";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import { Select } from "./ui/Select";

type Part =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: "running" | "done" | "error";
      result?: string;
    };

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

const streams = new Map<string, { sawDelta: boolean }>();

function update(key: string, fn: (msgs: Msg[]) => Msg[], sessionId?: string) {
  const s = useChats.getState();
  const chat = s.get(key);
  s.set(key, {
    messages: fn(chat.messages),
    sessionId: sessionId ?? chat.sessionId,
  });
}

function withLastAssistant(msgs: Msg[], fn: (m: Msg) => Msg): Msg[] {
  const last = msgs[msgs.length - 1];
  if (last?.role === "assistant") return [...msgs.slice(0, -1), fn(last)];
  return [
    ...msgs,
    fn({ id: crypto.randomUUID(), role: "assistant", parts: [] }),
  ];
}

function appendText(m: Msg, text: string): Msg {
  const last = m.parts[m.parts.length - 1];
  if (last?.kind === "text")
    return {
      ...m,
      parts: [
        ...m.parts.slice(0, -1),
        { kind: "text", text: last.text + text },
      ],
    };
  return { ...m, parts: [...m.parts, { kind: "text", text }] };
}

function handleEvent(id: string, ev: any) {
  const st = streams.get(id) ?? { sawDelta: false };
  streams.set(id, st);
  const key = id;
  switch (ev.type) {
    case "system":
      if (ev.session_id) update(key, (m) => m, ev.session_id);
      break;
    case "stream_event": {
      const e = ev.event;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
        st.sawDelta = true;
        update(key, (msgs) =>
          withLastAssistant(msgs, (m) => appendText(m, e.delta.text)),
        );
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
              if (b.type === "text" && !st.sawDelta)
                out = appendText(out, b.text);
              if (b.type === "tool_use")
                out = {
                  ...out,
                  parts: [
                    ...out.parts,
                    {
                      kind: "tool",
                      id: b.id,
                      name: b.name,
                      input: b.input ?? {},
                      status: "running",
                    },
                  ],
                };
            }
            return out;
          }),
        ev.session_id,
      );
      st.sawDelta = false;
      break;
    }
    case "user": {
      const blocks: any[] = Array.isArray(ev.message?.content)
        ? ev.message.content
        : [];
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const text = Array.isArray(b.content)
          ? b.content.map((c: any) => c.text ?? "").join("\n")
          : String(b.content ?? "");
        update(key, (msgs) =>
          msgs.map((m) => ({
            ...m,
            parts: m.parts.map((p) =>
              p.kind === "tool" && p.id === b.tool_use_id
                ? { ...p, status: b.is_error ? "error" : "done", result: text }
                : p,
            ),
          })),
        );
        if (!b.is_error) followTool(key, b.tool_use_id);
      }
      break;
    }
    case "result":
      if (ev.is_error && ev.result) {
        update(key, (msgs) =>
          withLastAssistant(msgs, (m) => appendText(m, `\n\n⚠️ ${ev.result}`)),
        );
      }
      if (ev.session_id) update(key, (m) => m, ev.session_id);
      break;
  }
}

function followTool(key: string, toolId: string) {
  const part = useChats
    .getState()
    .get(key)
    .messages.flatMap((m) => m.parts)
    .find((p) => p.kind === "tool" && p.id === toolId);
  if (
    part?.kind !== "tool" ||
    part.name.replace(/^mcp__quilltex__/, "") !== "rename_project"
  )
    return;
  const { project, new_name } = part.input as {
    project?: string;
    new_name?: string;
  };
  if (project && new_name?.trim())
    void useProject.getState().followRename(project, new_name.trim());
}

let listening = false;
function ensureListeners() {
  if (listening) return;
  listening = true;
  void listen<{ chatId: string; event: unknown }>("chat-event", (e) =>
    handleEvent(e.payload.chatId, e.payload.event),
  );
  void listen<{ chatId: string; ok: boolean; error: string | null }>(
    "chat-done",
    (e) => {
      const { chatId, error } = e.payload;
      const key = chatId;
      const s = useChats.getState();
      s.setRunning(key, false);
      streams.delete(chatId);
      if (error)
        update(key, (msgs) =>
          withLastAssistant(msgs, (m) =>
            appendText(m, `\n\n⚠️ ${error.slice(0, 600)}`),
          ),
        );
      update(key, (msgs) =>
        msgs.map((m) => ({
          ...m,
          parts: m.parts.map((p) =>
            p.kind === "tool" && p.status === "running"
              ? { ...p, status: "done" }
              : p,
          ),
        })),
      );
      void api.chatSave(key, useChats.getState().get(key));
    },
  );
}

const MODELS: [string, string][] = [
  ["", "chat.modelDefault"],
  ["claude-fable-5-1", "Fable 5.1"],
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-haiku-5-5", "Haiku 5.5"],
];

const SUGGESTIONS: {
  icon: ReactNode;
  label: MessageKey;
  prompt: MessageKey;
}[] = [
  {
    icon: <Wrench size={13} />,
    label: "chat.suggest.fix.label",
    prompt: "chat.suggest.fix.prompt",
  },
  {
    icon: <FilePlus size={13} />,
    label: "chat.suggest.intro.label",
    prompt: "chat.suggest.intro.prompt",
  },
  {
    icon: <BookOpen size={13} />,
    label: "chat.suggest.article.label",
    prompt: "chat.suggest.article.prompt",
  },
  {
    icon: <Table size={13} />,
    label: "chat.suggest.table.label",
    prompt: "chat.suggest.table.prompt",
  },
];

function EmptyChat({ onPick }: { onPick: (prompt: string) => void }) {
  const t = useT();
  return (
    <div className="chat-empty">
      <div className="chat-empty-title">{t("chat.emptyTitle")}</div>
      <div className="chat-empty-hint">{t("chat.emptyHint")}</div>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s.label} onClick={() => onPick(t(s.prompt))}>
            {s.icon}
            <span>{t(s.label)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChatPanel({
  docked = false,
  height,
}: {
  docked?: boolean;
  height?: number;
}) {
  const t = useT();
  const toggle = useApp((s) => s.toggle);
  const info = useApp((s) => s.info);
  const setUi = useApp((s) => s.setUi);
  const model = useApp((s) => s.settings?.chatModel ?? "");
  const saveSettings = useApp((s) => s.saveSettings);
  const project = useProject((s) => s.project);
  const key = project?.meta.id ? `project-${project.meta.id}` : "global";
  const chat = useChats((s) => s.chats[key]) ?? {
    messages: [],
    sessionId: null,
  };
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
      ? `Open project: "${project.name}" (main file ${project.meta.mainFile}). Open file: ${active ?? "none"}${active?.endsWith(".md") ? " (a rich-text document)" : ` (cursor at line ${cursorLine})`}.`
      : "No project is open; the user is on the project list.";
    update(key, (m) => [
      ...m,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text }],
      },
    ]);
    useChats.getState().setRunning(key, true);
    try {
      await useProject.getState().saveAll();
      await api.chatSend(key, text, chat.sessionId, context);
    } catch (e) {
      useChats.getState().setRunning(key, false);
      update(key, (msgs) =>
        withLastAssistant(msgs, (m) => appendText(m, `⚠️ ${errorMessage(e)}`)),
      );
    }
  };

  const reset = () => {
    useChats.getState().set(key, { messages: [], sessionId: null });
    void api.chatSave(key, { messages: [], sessionId: null });
  };

  return (
    <aside
      className={`chat${docked ? " docked" : ""}`}
      style={height ? { height } : undefined}
    >
      <div className="chat-head">
        <span className="title">
          <Sparkles size={14} /> {t("chat.title")}
        </span>
        <button
          className="icon-btn sm"
          title={t("chat.newChat")}
          onClick={reset}
          disabled={running}
        >
          <Plus size={14} />
        </button>
        <button
          className="icon-btn sm"
          title={t("common.close")}
          onClick={() => toggle("chat")}
        >
          <X size={18} />
        </button>
      </div>
      <div className="chat-body" ref={body}>
        {!info?.claude ? (
          <div className="empty">
            <div className="empty-icon">
              <Terminal size={20} />
            </div>
            <h3>{t("chat.notFound")}</h3>
            <p>
              <T k="chat.notFoundBody" values={{ cmd: <code>claude</code> }} />
            </p>
            <button
              className="btn"
              onClick={() => setUi({ settings: "claude" })}
            >
              {t("chat.openSettings")}
            </button>
          </div>
        ) : chat.messages.length === 0 ? (
          <EmptyChat onPick={send} />
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
              {m.role === "assistant" &&
                !(running && m === chat.messages[chat.messages.length - 1]) && (
                  <CopyButton text={messageText(m)} />
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
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            rows={2}
            placeholder={
              project
                ? t("chat.placeholderProject", { name: project.name })
                : t("chat.placeholder")
            }
            data-keys="chat-send"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (
                matches("chat-send", e.nativeEvent) &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={!info?.claude}
          />
          <div className="row">
            <span className="ctx">
              {project
                ? t("chat.contextProject", { name: project.name })
                : t("chat.contextAll")}
            </span>
            <Select
              ghost
              title={t("chat.model")}
              value={model}
              disabled={running}
              options={(MODELS.some(([id]) => id === model)
                ? MODELS
                : [...MODELS, [model, model]]
              ).map(([id, label]) => ({
                value: id,
                label: hasKey(label) ? t(label as MessageKey) : label,
              }))}
              onChange={(v) => void saveSettings({ chatModel: v })}
            />
            {running ? (
              <button
                className="send-btn"
                title={t("chat.stop")}
                onClick={() => api.chatCancel(key)}
              >
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                className="send-btn"
                disabled={!input.trim()}
                onClick={() => send()}
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function messageText(m: Msg): string {
  return m.parts
    .flatMap((p) => (p.kind === "text" ? [p.text] : []))
    .join("\n\n")
    .trim();
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      className="btn ghost sm copy-btn"
      title={copied ? t("chat.copied") : t("chat.copy")}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function ToolCard({ part }: { part: Extract<Part, { kind: "tool" }> }) {
  const t = useT();
  const short = part.name.replace(/^mcp__quilltex__/, "");
  const arg = (part.input.path ??
    part.input.name ??
    part.input.project ??
    part.input.message ??
    "") as string;
  const open = () => {
    const proj = part.input.project as string | undefined;
    const path = part.input.path as string | undefined;
    if (proj && path && useProject.getState().project?.name === proj)
      void useProject.getState().openFile(path);
  };
  return (
    <div
      className={`tool-card${part.status === "error" ? " error" : ""}`}
      title={part.result ?? ""}
      onClick={open}
    >
      {part.status === "running" ? (
        <Loader2 size={13} className="spin" />
      ) : part.status === "error" ? (
        <AlertCircle size={13} style={{ color: "var(--red)" }} />
      ) : (
        <Check size={13} style={{ color: "var(--green)" }} />
      )}
      <span className="t-name">
        {hasKey(`chat.tool.${short}`)
          ? t(`chat.tool.${short}` as MessageKey)
          : short}
      </span>
      <span className="t-arg">{String(arg)}</span>
      <Wrench size={12} style={{ opacity: 0.4 }} />
    </div>
  );
}

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
      if (s.startsWith("`") && s.endsWith("`") && s.length > 2)
        out.push(<code key={`${i}-${j}`}>{s.slice(1, -1)}</code>);
      else if (s.startsWith("**") && s.endsWith("**") && s.length > 4)
        out.push(<strong key={`${i}-${j}`}>{s.slice(2, -2)}</strong>);
      else if (s) out.push(s);
    });
  });
  return out;
}
