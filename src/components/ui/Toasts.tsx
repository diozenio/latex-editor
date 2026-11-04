import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { useApp } from "@/stores/app";

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "error" ? <AlertCircle size={16} /> : t.kind === "success" ? <CheckCircle2 size={16} /> : <Info size={16} />}
          <div className="t-body">{t.message}</div>
        </div>
      ))}
    </div>
  );
}
