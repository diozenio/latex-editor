import { ArrowDown, ArrowUp, ArrowUpDown, Check, CircleDot, Cloud, CloudOff, Loader2 } from "lucide-react";
import { timeAgo } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { RepoStatus } from "@/lib/ipc";

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
  const t = useT();
  const state = busy ? "checking" : syncState(status, error);
  if (state === "none") return null;
  const dirty = status?.files.length ?? 0;
  const map: Record<SyncState, { cls: string; icon: JSX.Element; label: string; title: string }> = {
    none: { cls: "", icon: <></>, label: "", title: "" },
    checking: { cls: "muted", icon: <Loader2 size={12} className="spin" />, label: t("sync.syncing"), title: t("sync.syncingTitle") },
    local: { cls: "muted", icon: <Cloud size={12} />, label: t("sync.local"), title: t("sync.localTitle") },
    synced: { cls: "green", icon: <Check size={12} />, label: t("sync.synced"), title: t("sync.syncedTitle") },
    ahead: { cls: "blue", icon: <ArrowUp size={12} />, label: t("sync.ahead", { count: status?.ahead ?? 0 }), title: t("sync.aheadTitle", { count: status?.ahead ?? 0 }) },
    behind: { cls: "orange", icon: <ArrowDown size={12} />, label: t("sync.behind", { count: status?.behind ?? 0 }), title: t("sync.behindTitle", { count: status?.behind ?? 0 }) },
    diverged: {
      cls: "red",
      icon: <ArrowUpDown size={12} />,
      label: `↑${status?.ahead} ↓${status?.behind}`,
      title: t("sync.divergedTitle"),
    },
    error: { cls: "red", icon: <CloudOff size={12} />, label: t("sync.offline"), title: error ?? "" },
  };
  const m = map[state];
  const title = `${m.title}${dirty ? ` · ${t("sync.uncommitted", { count: dirty })}` : ""}${checkedAt ? ` · ${t("sync.checked", { time: timeAgo(checkedAt) })}` : ""}`;
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
