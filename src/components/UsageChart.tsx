import { useMemo, useState } from "react";

interface DailyUsage {
  date: string;
  costUsd: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

interface UsageChartProps {
  data: DailyUsage[];
  mode: "cost" | "tokens";
}

export default function UsageChart({ data, mode }: UsageChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const { bars, maxVal } = useMemo(() => {
    const values = data.map((d) =>
      mode === "cost" ? d.costUsd : d.totalTokens
    );
    const max = Math.max(...values, 0.01);
    return {
      bars: values,
      maxVal: max,
    };
  }, [data, mode]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-xs text-[var(--text-secondary)]">
        No usage data available
      </div>
    );
  }

  const width = 560;
  const height = 160;
  const padding = { top: 10, right: 10, bottom: 24, left: 10 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const barGap = 2;
  const barWidth = Math.max(4, (chartW - barGap * (bars.length - 1)) / bars.length);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ maxHeight: 200 }}
      >
        {bars.map((val, i) => {
          const barH = (val / maxVal) * chartH;
          const x = padding.left + i * (barWidth + barGap);
          const y = padding.top + chartH - barH;
          const d = data[i];
          const isHovered = hoveredIdx === i;

          return (
            <g
              key={d.date}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              {/* Invisible hit area */}
              <rect
                x={x}
                y={padding.top}
                width={barWidth}
                height={chartH}
                fill="transparent"
              />
              {/* Visible bar */}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barH, 1)}
                rx={2}
                fill={isHovered ? "var(--accent-hover)" : "var(--accent)"}
                opacity={isHovered ? 1 : 0.8}
              />
              {/* Date label (every other for space, or all if few) */}
              {(data.length <= 7 || i % 2 === 0) && (
                <text
                  x={x + barWidth / 2}
                  y={height - 4}
                  textAnchor="middle"
                  fill="var(--text-tertiary)"
                  fontSize={9}
                >
                  {d.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {hoveredIdx !== null && data[hoveredIdx] && (
        <div
          className="absolute top-0 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-1 text-xs shadow-lg pointer-events-none z-10"
          style={{
            left: `${((hoveredIdx + 0.5) / bars.length) * 100}%`,
            transform: "translateX(-50%)",
          }}
        >
          <div className="font-medium text-[var(--text-primary)]">
            {data[hoveredIdx].date}
          </div>
          <div className="text-[var(--text-secondary)]">
            ${data[hoveredIdx].costUsd.toFixed(2)} &middot;{" "}
            {formatTokens(data[hoveredIdx].totalTokens)} tokens
          </div>
        </div>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
