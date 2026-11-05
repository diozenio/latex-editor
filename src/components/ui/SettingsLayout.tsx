import { Loader2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";

export function Page({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="sp-page">
      <header className="sp-head">
        <h3>{title}</h3>
        {actions}
      </header>
      <div className="sp-sections">{children}</div>
    </div>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sp-section">
      {(title || description || actions) && (
        <div className="sp-section-head">
          <div className="sp-section-text">
            {title && <h4>{title}</h4>}
            {description && <p>{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return <div className="sp-rows">{children}</div>;
}

export function Row({
  title,
  description,
  leading,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="sp-row">
      {leading}
      <div className="sp-row-text">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </div>
      {children && <div className="sp-control">{children}</div>}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="sp-note">{children}</p>;
}

export function RefreshButton({
  loading,
  title,
  onClick,
}: {
  loading: boolean;
  title?: string;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      className="btn sm icon"
      title={title ?? t("common.refresh")}
      disabled={loading}
      onClick={onClick}
    >
      {loading ? (
        <Loader2 size={13} className="spin" />
      ) : (
        <RefreshCw size={13} />
      )}
    </button>
  );
}
