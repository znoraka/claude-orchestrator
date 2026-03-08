import { useState } from "react";
import type { SessionUsage } from "../types";

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 200_000;

function contextWindowForModel(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

function getColor(pct: number) {
  if (pct > 0.95) return "rgba(239,68,68,0.8)";
  if (pct > 0.8) return "rgba(217,119,6,0.6)";
  if (pct > 0.5) return "rgba(217,119,6,0.35)";
  return "rgba(148,163,184,0.35)";
}

export default function ContextPieChart({ usage, model }: { usage: SessionUsage | undefined; model?: string }) {
  const [hover, setHover] = useState(false);
  const maxTokens = Math.max(contextWindowForModel(model), usage?.contextTokens ?? 0);
  const pct = usage && usage.contextTokens > 0 ? usage.contextTokens / maxTokens : 0;
  const color = getColor(pct);
  const size = 28;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const filled = circ * Math.min(1, pct);

  return (
    <div
      className="relative flex items-center justify-center"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <svg width={size} height={size} className="transition-opacity duration-300" style={{ opacity: pct > 0 ? 1 : 0.3 }}>
        {/* Background ring */}
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke="rgba(148,163,184,0.12)" strokeWidth={stroke}
        />
        {/* Usage arc */}
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={`${filled} ${circ - filled}`}
          strokeDashoffset={circ / 4}
          strokeLinecap="round"
          className="transition-all duration-500"
        />
        {/* Center text */}
        <text
          x={size / 2} y={size / 2}
          textAnchor="middle" dominantBaseline="central"
          fill="var(--text-tertiary)"
          fontSize={8} fontWeight={500}
        >
          {pct > 0 ? `${Math.round(pct * 100)}` : ""}
        </text>
      </svg>

      {/* Tooltip */}
      {hover && usage && usage.contextTokens > 0 && (
        <div
          className="absolute right-full mr-2 top-1/2 -translate-y-1/2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs whitespace-nowrap z-50 shadow-lg"
        >
          <div className="font-medium text-[var(--text-primary)] mb-1">
            Context: {usage.contextTokens.toLocaleString()} / {maxTokens.toLocaleString()} ({Math.round(pct * 100)}%)
          </div>
          <div className="text-[var(--text-tertiary)] space-y-0.5">
            <div>Input: {usage.inputTokens.toLocaleString()}</div>
            <div>Output: {usage.outputTokens.toLocaleString()}</div>
            <div>Cache read: {usage.cacheReadInputTokens.toLocaleString()}</div>
            <div>Cache write: {usage.cacheCreationInputTokens.toLocaleString()}</div>
          </div>
        </div>
      )}
    </div>
  );
}
