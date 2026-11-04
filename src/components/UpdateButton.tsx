import { ArrowDownToLine, Loader2 } from "lucide-react";
import { useUpdater } from "@/stores/updater";

export function UpdateButton() {
  const { phase, version, progress, install } = useUpdater();
  if (phase !== "available" && phase !== "downloading") return null;
  const busy = phase === "downloading";
  return (
    <button
      className="update-btn"
      disabled={busy}
      title={`QuillTex ${version} is available`}
      onClick={() => void install()}
    >
      {busy ? <Loader2 size={13} className="spin" /> : <ArrowDownToLine size={13} />}
      <span>{busy ? `Updating${progress ? ` ${Math.round(progress * 100)}%` : "…"}` : "Update"}</span>
    </button>
  );
}
