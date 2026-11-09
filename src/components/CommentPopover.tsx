import type { EditorView, TooltipView } from "@codemirror/view";
import { Check, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { timeAgo } from "@/lib/format";
import { useT } from "@/lib/i18n";
import {
  type CommentMessage,
  type CommentThread,
  useComments,
} from "@/stores/comments";

const ease = [0.16, 1, 0.3, 1] as const;
const enter = { duration: 0.22, ease };

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?"
  );
}

function hue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      className="cm-avatar"
      style={{ background: `hsl(${hue(name)} 55% 46%)` }}
    >
      {initials(name)}
    </span>
  );
}

function Box({
  placeholder,
  submit,
  initial = "",
  autoFocus,
  onCancel,
  onSubmit,
}: {
  placeholder: string;
  submit: string;
  initial?: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  onSubmit: (text: string) => void;
}) {
  const t = useT();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const send = () => {
    if (!text.trim()) return;
    onSubmit(text);
    setText("");
  };
  return (
    <div className="comment-box">
      <textarea
        ref={ref}
        className="textarea"
        rows={2}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="comment-box-actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        )}
        <button
          type="button"
          className="btn primary"
          disabled={!text.trim()}
          onClick={send}
        >
          {submit}
        </button>
      </div>
    </div>
  );
}

function Message({
  thread,
  message,
}: {
  thread: CommentThread;
  message: CommentMessage;
}) {
  const t = useT();
  const { editMessage, deleteMessage } = useComments();
  const [editing, setEditing] = useState(false);
  const isOnly = thread.messages.length === 1;
  return (
    <motion.div
      layout="position"
      className="comment-msg"
      initial="rest"
      animate="rest"
      whileHover="hover"
      exit={{ opacity: 0, height: 0 }}
      transition={enter}
    >
      <div className="comment-msg-head">
        <Avatar name={message.author} />
        <strong className="comment-author">{message.author}</strong>
        <span className="comment-time">
          {timeAgo(message.createdAt)}
          {message.editedAt ? ` · ${t("comments.edited")}` : ""}
        </span>
        <div className="grow" />
        <motion.div
          className="comment-msg-actions"
          variants={{
            rest: { opacity: 0, x: 6, pointerEvents: "none" },
            hover: { opacity: 1, x: 0, pointerEvents: "auto" },
          }}
          transition={{ duration: 0.16, ease }}
        >
          <button
            type="button"
            className="icon-btn sm"
            title={t("comments.edit")}
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            className="icon-btn sm danger"
            title={isOnly ? t("comments.deleteThread") : t("comments.delete")}
            onClick={(e) => {
              e.stopPropagation();
              deleteMessage(thread.id, message.id);
            }}
          >
            <Trash2 size={13} />
          </button>
        </motion.div>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {editing ? (
          <motion.div
            key="edit"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={enter}
          >
            <Box
              autoFocus
              initial={message.text}
              placeholder={t("comments.placeholder")}
              submit={t("common.save")}
              onCancel={() => setEditing(false)}
              onSubmit={(text) => {
                editMessage(thread.id, message.id, text);
                setEditing(false);
              }}
            />
          </motion.div>
        ) : (
          <motion.div
            key="text"
            className="comment-text"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={enter}
          >
            {message.text}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Thread({
  thread,
  line,
  active,
}: {
  thread: CommentThread;
  line: number;
  active: boolean;
}) {
  const t = useT();
  const { reply, setResolved, focus, deleteThread } = useComments();
  return (
    <motion.div
      layout
      className={`comment-thread${active ? " active" : ""}${thread.resolved ? " resolved" : ""}`}
      onClick={() => focus(thread.id)}
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={enter}
    >
      <div className="comment-thread-head">
        <div className="comment-quote static" title={thread.quote}>
          <span className="comment-line">
            {thread.orphaned ? t("comments.orphan") : `L${line}`}
          </span>
          <span className="comment-quote-text">
            {thread.quote.trim() || "…"}
          </span>
        </div>
        <button
          type="button"
          className="icon-btn sm"
          title={thread.resolved ? t("comments.reopen") : t("comments.resolve")}
          onClick={(e) => {
            e.stopPropagation();
            setResolved(thread.id, !thread.resolved);
          }}
        >
          {thread.resolved ? <RotateCcw size={14} /> : <Check size={14} />}
        </button>
        <button
          type="button"
          className="icon-btn sm"
          title={t("comments.deleteThread")}
          onClick={(e) => {
            e.stopPropagation();
            deleteThread(thread.id);
          }}
        >
          <Trash2 size={14} />
        </button>
        {active && (
          <button
            type="button"
            className="icon-btn sm"
            title={t("common.close")}
            onClick={(e) => {
              e.stopPropagation();
              focus(null);
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {thread.messages.map((m) => (
          <Message key={m.id} thread={thread} message={m} />
        ))}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {active && (
          <motion.div
            key="reply"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={enter}
            style={{ overflow: "hidden" }}
          >
            <Box
              placeholder={t("comments.reply")}
              submit={t("comments.replyBtn")}
              onSubmit={(text) => reply(thread.id, text)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function Popover({ view, path }: { view: EditorView; path: string }) {
  const t = useT();
  const { threads, activeId, draft, addThread, cancelDraft, focus } =
    useComments();
  const doc = view.state.doc;
  const lineOf = (pos: number) => doc.lineAt(Math.min(pos, doc.length)).number;

  const draftHere = draft && draft.file === path ? draft : null;
  const current = threads.find((th) => th.id === activeId && th.file === path);
  const line = current ? lineOf(current.from) : null;
  const group =
    line == null
      ? []
      : threads
          .filter((th) => th.file === path && lineOf(th.from) === line)
          .sort((a, b) => a.createdAt - b.createdAt);

  const close = () => {
    focus(null);
    cancelDraft();
    view.focus();
  };

  return (
    <motion.div
      className="comment-popover"
      initial={{ opacity: 0, y: -6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={enter}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) close();
      }}
    >
      {draftHere ? (
        <motion.div
          className="comment-thread active"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={enter}
        >
          <div className="comment-thread-head">
            <div className="comment-quote static">
              <span className="comment-line">L{lineOf(draftHere.from)}</span>
              <span className="comment-quote-text">
                {draftHere.quote.trim() || "…"}
              </span>
            </div>
          </div>
          <Box
            autoFocus
            placeholder={t("comments.placeholder")}
            submit={t("comments.send")}
            onCancel={close}
            onSubmit={addThread}
          />
        </motion.div>
      ) : (
        <AnimatePresence initial={false}>
          {group.map((th) => (
            <Thread
              key={th.id}
              thread={th}
              line={lineOf(th.from)}
              active={th.id === activeId}
            />
          ))}
        </AnimatePresence>
      )}
    </motion.div>
  );
}

export function createPopover(view: EditorView, path: string): TooltipView {
  const dom = document.createElement("div");
  dom.classList.add("cm-comment-tooltip");
  const root = createRoot(dom);
  root.render(<Popover view={view} path={path} />);
  return {
    dom,
    destroy: () => queueMicrotask(() => root.unmount()),
  };
}
