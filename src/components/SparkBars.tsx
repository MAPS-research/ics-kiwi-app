/** Inline SVG bar chart (no chart dependency). Null values render as gaps; `shaded` marks e.g. outage periods. */
export interface SparkBar { x: number; y: number; width: number; height: number; value: number | null }

export function sparkBarGeometry(
  values: readonly (number | null)[],
  opts: { width: number; height: number; gap?: number; max?: number },
): SparkBar[] {
  const { width, height } = opts;
  const gap = opts.gap ?? 2;
  if (!values.length || width <= 0 || height <= 0) return [];
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const max = opts.max ?? Math.max(0, ...finite);
  const barWidth = Math.max(1, (width - gap * (values.length - 1)) / values.length);
  return values.map((value, i) => {
    const v = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
    const h = v === null || max <= 0 ? 0 : (Math.min(v, max) / max) * height;
    const x = Math.round(i * (barWidth + gap) * 100) / 100;
    return { x, y: Math.round((height - h) * 100) / 100, width: Math.round(barWidth * 100) / 100, height: Math.round(h * 100) / 100, value: v };
  });
}

export function SparkBars({
  values,
  labels,
  shaded,
  width = 160,
  height = 36,
  max,
  ariaLabel,
}: {
  values: readonly (number | null)[];
  labels?: readonly string[];
  shaded?: readonly boolean[];
  width?: number;
  height?: number;
  max?: number;
  ariaLabel: string;
}) {
  const bars = sparkBarGeometry(values, { width, height, max });
  return (
    <svg className="spark-bars" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
      {bars.map((bar, i) => (
        <g key={i}>
          {shaded?.[i] && <rect className="spark-shade" x={bar.x} y={0} width={bar.width} height={height} />}
          <rect className={bar.value === null ? "spark-bar spark-missing" : "spark-bar"} x={bar.x} y={bar.value === null ? height - 1 : bar.y} width={bar.width} height={bar.value === null ? 1 : bar.height}>
            <title>{`${labels?.[i] ?? `#${i + 1}`}: ${bar.value === null ? "no data" : bar.value}`}</title>
          </rect>
        </g>
      ))}
    </svg>
  );
}
