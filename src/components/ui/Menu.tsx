import * as DM from "@radix-ui/react-dropdown-menu";
import * as CM from "@radix-ui/react-context-menu";
import type { ReactNode } from "react";

export interface MenuEntry {
  label?: string;
  icon?: ReactNode;
  right?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  separator?: boolean;
  heading?: string;
}

function entries<T extends typeof DM | typeof CM>(M: T, items: MenuEntry[]) {
  return items.map((it, i) => {
    if (it.separator) return <M.Separator key={i} className="menu-sep" />;
    if (it.heading) return <M.Label key={i} className="menu-label">{it.heading}</M.Label>;
    return (
      <M.Item
        key={i}
        className={`menu-item${it.danger ? " danger" : ""}`}
        disabled={it.disabled}
        onSelect={() => it.onSelect?.()}
      >
        {it.icon}
        <span>{it.label}</span>
        {it.right && <span className="right">{it.right}</span>}
      </M.Item>
    );
  });
}

export function Dropdown({
  trigger,
  items,
  align = "start",
}: {
  trigger: ReactNode;
  items: MenuEntry[];
  align?: "start" | "end" | "center";
}) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content className="menu" align={align} sideOffset={6}>
          {entries(DM, items)}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export function ContextMenu({ children, items }: { children: ReactNode; items: MenuEntry[] }) {
  return (
    <CM.Root modal={false}>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className="menu">{entries(CM, items)}</CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}
