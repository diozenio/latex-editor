import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Dropdown } from "./Menu";

export interface SelectOption {
  value: string;
  label: ReactNode;
}

export function Select({
  value,
  options,
  onChange,
  width,
  title,
  disabled,
  ghost,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  width?: number;
  title?: string;
  disabled?: boolean;
  ghost?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <Dropdown
      align={ghost ? "start" : "end"}
      items={options.map((o) => ({
        label: typeof o.label === "string" ? o.label : undefined,
        right: o.value === value ? <Check size={13} /> : undefined,
        onSelect: () => onChange(o.value),
      }))}
      trigger={
        <button
          type="button"
          className={ghost ? "model-select" : "select select-trigger"}
          style={width ? { width } : undefined}
          title={title}
          disabled={disabled}
        >
          <span className="select-value">{current?.label ?? value}</span>
          <ChevronDown size={12} />
        </button>
      }
    />
  );
}
