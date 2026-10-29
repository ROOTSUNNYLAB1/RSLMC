import { useMemo } from "react";

export interface Point { ts: number; value: number }

function buildPath(points: Point[], width: number, height: number, min: number, max: number): string {
  if (points.length === 0) return "";
  const span = max - min || 1;
  const stepX = points.length > 1 ? width / (points.length - 1) : width;
  return points
    .map((point, index) => {
      const x = index * stepX;
      const y = height - ((point.value - min) / span) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${Math.max(0, Math.min(height, y)).toFixed(2)}`;
    })
    .join(" ");
}

/** Compact inline sparkline used inside stat cards. */
export function Sparkline({ points, color = "var(--green)", height = 26, width = 92, fill = true }: {
  points: number[]; color?: string; height?: number; width?: number; fill?: boolean;
}) {
  const { path, area } = useMemo(() => {
    if (points.length < 2) return { path: "", area: "" };
    const max = Math.max(...points, 1);
    const min = Math.min(...points, 0);
    const mapped = points.map((value, index) => ({ ts: index, value }));
    const line = buildPath(mapped, width, height - 2, min, max);
    return { path: line, area: `${line} L${width},${height} L0,${height} Z` };
  }, [points, width, height]);

  if (!path) return <svg width={width} height={height} aria-hidden />;
  const gradientId = `spark-${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill ? <path d={area} fill={`url(#${gradientId})`} /> : null}
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Larger time-series chart with grid, axis labels and an optional second series. */
export function LineChart({
  series, height = 150, unit = "%", max, min = 0, times,
}: {
  series: { label: string; color: string; points: Point[] }[];
  height?: number; unit?: string; max?: number; min?: number; times?: boolean;
}) {
  const width = 640;
  const padding = { top: 8, right: 6, bottom: 16, left: 30 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const computedMax = useMemo(() => {
    if (max !== undefined) return max;
    const values = series.flatMap((entry) => entry.points.map((point) => point.value));
    return values.length > 0 ? Math.max(...values) * 1.15 || 1 : 1;
  }, [series, max]);

  const hasData = series.some((entry) => entry.points.length > 1);

  if (!hasData) {
    return <div className="chart-empty" style={{ height }}>Waiting for measurements…</div>;
  }

  const allTimestamps = series.flatMap((entry) => entry.points.map((point) => point.ts)).sort((a, b) => a - b);
  const startTs = allTimestamps[0] ?? Date.now();
  const endTs = allTimestamps[allTimestamps.length - 1] ?? Date.now();
  const span = Math.max(1, endTs - startTs);

  const toPath = (points: Point[]) => points.map((point, index) => {
    const x = padding.left + ((point.ts - startTs) / span) * innerWidth;
    const y = padding.top + innerHeight - ((point.value - min) / (computedMax - min || 1)) * innerHeight;
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${Math.max(padding.top, Math.min(padding.top + innerHeight, y)).toFixed(2)}`;
  }).join(" ");

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="Performance chart">
        {gridLines.map((ratio) => {
          const y = padding.top + innerHeight * ratio;
          const value = computedMax - (computedMax - min) * ratio;
          return (
            <g key={ratio}>
              <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#1a1a1f" strokeWidth="1" />
              <text x={4} y={y + 3} fill="#4d4f57" fontSize="8.5" fontFamily="JetBrains Mono, monospace">
                {value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(0)}{unit === "%" ? "%" : ""}
              </text>
            </g>
          );
        })}
        {series.map((entry) => (
          <path key={entry.label} d={toPath(entry.points)} fill="none" stroke={entry.color} strokeWidth="1.6" strokeLinejoin="round" />
        ))}
        {times ? (
          <>
            <text x={padding.left} y={height - 3} fill="#4d4f57" fontSize="8.5" fontFamily="JetBrains Mono, monospace">
              {new Date(startTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </text>
            <text x={width - padding.right} y={height - 3} textAnchor="end" fill="#4d4f57" fontSize="8.5" fontFamily="JetBrains Mono, monospace">
              {new Date(endTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </text>
          </>
        ) : null}
      </svg>
      <div className="chart-legend" style={{ marginTop: 4 }}>
        {series.map((entry) => (
          <span className="item" key={entry.label}>
            <span className="swatch" style={{ background: entry.color }} />
            {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Minimal bar chart used for player-count history and audit volume. */
export function BarChart({ points, color = "var(--blue)", height = 96 }: { points: number[]; color?: string; height?: number }) {
  if (points.length === 0) return <div className="chart-empty" style={{ height }}>No data</div>;
  const max = Math.max(...points, 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height }}>
      {points.map((value, index) => (
        <div
          key={index}
          style={{
            flex: 1, minWidth: 2, height: `${Math.max(3, (value / max) * 100)}%`,
            background: color, opacity: 0.35 + (value / max) * 0.6, borderRadius: 2,
          }}
          title={`${value}`}
        />
      ))}
    </div>
  );
}
