export interface BarSegment {
  key: string;
  label: string;
  value: number;
  display: string;
  color: string;
}

function percentOf(part: number, total: number): string {
  if (!total || !part) return "0%";
  const pct = (part / total) * 100;
  return pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

export function SegmentedBar({
  segments,
  total,
  loading,
  title,
}: {
  segments: BarSegment[];
  total: number;
  loading?: boolean;
  title?: string;
}) {
  const used = segments.reduce((sum, s) => sum + s.value, 0);
  const rest = Math.max(0, total - used);
  return (
    <div className={`meter${loading ? " loading" : ""}`}>
      <div className="meter-bar" title={title}>
        {segments.map((s) =>
          s.value > 0 ? (
            <div
              key={s.key}
              className="meter-seg"
              title={`${s.label} · ${s.display}`}
              style={{ flexGrow: s.value, background: s.color }}
            />
          ) : null,
        )}
        {rest > 0 && <div className="meter-rest" style={{ flexGrow: rest }} />}
      </div>
      <div
        className="meter-legend"
        style={{
          gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))`,
        }}
      >
        {segments.map((s) => (
          <div className="meter-item" key={s.key}>
            <span className="name">
              <i className="meter-dot" style={{ background: s.color }} />
              {s.label}
            </span>
            <strong>{s.display}</strong>
            <span className="pct">{percentOf(s.value, total)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
