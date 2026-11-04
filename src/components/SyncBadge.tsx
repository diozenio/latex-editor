import { ArrowDown, ArrowUp, ArrowUpDown, Check, CircleDot, CloudOff, Loader2, Cloud } from "lucide-react";
import type { RepoStatus } from "@/lib/ipc";
import { timeAgo } from "@/lib/format";

export type SyncState = "none" | "local" | "synced" | "ahead" | "behind" | "diverged" | "error" | "checking";

export function syncState(status: RepoStatus | null | undefined, error?: string | null): SyncState {
  if (!status || !status.isRepo) return "none";
  if (!status.remoteUrl) return "local";
  if (error) return "error";
  if (status.ahead && status.behind) return "diverged";
  if (status.behind) return "behind";
  if (status.ahead) return "ahead";
  return "synced";
}

export function SyncBadge({
  status,
  error,
  checkedAt,
  busy,
  compact,
  onClick,
}: {
  status: RepoStatus | null | undefined;
  error?: string | null;
  checkedAt?: number;
  busy?: boolean;
  compact?: boolean;
  onClick?: () => void;
}) {
  const state = busy ? "checking" : syncState(status, error);
  if (state === "none") return null;
  const dirty = status?.files.length ?? 0;
  const map: Record<SyncState, { cls: string; icon: JSX.Element; label: string; title: string }> = {
    none: { cls: "", icon: <></>, label: "", title: "" },
    checking: { cls: "muted", icon: <Loader2 size={12} className="spin" />, label: "Syncing", title: "Talking to origin…" },
    local: { cls: "muted", icon: <Cloud size={12} />, label: "Local only", title: "No remote. Publish to GitHub to sync." },
    synced: { cls: "green", icon: <Check size={12} />, label: "Synced", title: "Up to date with origin" },
    ahead: { cls: "blue", icon: <ArrowUp size={12} />, label: `${status?.ahead} to push`, title: `${status?.ahead} commit(s) not on origin yet` },
    behind: { cls: "orange", icon: <ArrowDown size={12} />, label: `${status?.behind} to pull`, title: `origin has ${status?.behind} new commit(s)` },
    diverged: {
      cls: "red",
      icon: <ArrowUpDown size={12} />,
      label: `↑${status?.ahead} ↓${status?.behind}`,
      title: "Your branch and origin have diverged. Pull to merge.",
    },
    error: { cls: "red", icon: <CloudOff size={12} />, label: "Offline", title: error ?? "" },
  };
  const m = map[state];
  const title = `${m.title}${dirty ? ` · ${dirty} uncommitted change(s)` : ""}${checkedAt ? ` · checked ${timeAgo(checkedAt)}` : ""}`;
  const content = (
    <>
      {m.icon}
      {!compact && <span>{m.label}</span>}
      {dirty > 0 && state !== "checking" && <CircleDot size={10} style={{ marginLeft: compact ? 0 : 2, opacity: 0.7 }} />}
    </>
  );
  return onClick ? (
    <button className={`tag ${m.cls}`} title={title} onClick={onClick}>
      {content}
    </button>
  ) : (
    <span className={`tag ${m.cls}`} title={title}>
      {content}
    </span>
  );
}
