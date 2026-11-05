import { ArrowDownToLine, Loader2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useUpdater } from "@/stores/updater";

export function UpdateButton() {
  const t = useT();
  const { phase, version, progress, install } = useUpdater();
  if (phase !== "available" && phase !== "downloading") return null;
  const busy = phase === "downloading";
  return (
    <button
      className="update-btn"
      disabled={busy}
      title={t("update.available", { version: version ?? "" })}
      onClick={() => void install()}
    >
      {busy ? <Loader2 size={13} className="spin" /> : <ArrowDownToLine size={13} />}
      <span>{busy ? (progress ? t("update.updatingPct", { pct: Math.round(progress * 100) }) : t("update.updating")) : t("update.button")}</span>
    </button>
  );
}
