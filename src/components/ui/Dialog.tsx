import * as D from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  corner,
  wide,
  tall,
  bare,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Controls pinned to the top-right corner of the header. */
  corner?: ReactNode;
  wide?: boolean;
  tall?: boolean;
  bare?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="dialog-overlay" />
        <D.Content className={`dialog${wide ? " wide" : ""}${tall ? " tall" : ""}`} aria-describedby={undefined}>
          {bare ? (
            <>
              <D.Title style={{ display: "none" }}>{title}</D.Title>
              {children}
            </>
          ) : (
            <>
              <div className="dialog-head">
                {corner && <div className="dialog-corner">{corner}</div>}
                <D.Title asChild>
                  <h2>{title}</h2>
                </D.Title>
                {description && <p>{description}</p>}
              </div>
              <div className="dialog-body">{children}</div>
              {footer && <div className="dialog-foot">{footer}</div>}
            </>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
