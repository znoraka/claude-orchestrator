import { useState, useEffect } from "react";
import { invoke } from "../lib/bridge";
import UsageChart from "./UsageChart";

interface DailyUsage {
  date: string;
  costUsd: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

interface ProjectUsage {
  directory: string;
  costUsd: number;
  totalTokens: number;
  sessionCount: number;
}

interface UsageDashboard {
  history: DailyUsage[];
  projects: ProjectUsage[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export default function UsagePanel({ onClose }: { onClose: () => void }) {
  const [history, setHistory] = useState<DailyUsage[]>([]);
  const [projects, setProjects] = useState<ProjectUsage[]>([]);
  const [mode, setMode] = useState<"cost" | "tokens">("cost");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<UsageDashboard>("get_usage_dashboard", { days: 14 })
      .then((data) => {
        setHistory(data.history);
        setProjects(data.projects);
      })
      .catch((err) => console.error("Failed to load usage:", err))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dialog-backdrop animate-backdrop"
      onMouseDown={onClose}
    >
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl p-6 w-[calc(100vw-2rem)] max-w-[640px] max-h-[80vh] shadow-[0_16px_48px_rgba(0,0,0,0.5)] ring-1 ring-white/[0.04] flex flex-col gap-4 overflow-hidden animate-scale-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            Usage & Costs
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMode("cost")}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                mode === "cost"
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              Cost
            </button>
            <button
              onClick={() => setMode("tokens")}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                mode === "tokens"
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              Tokens
            </button>
            <button
              onClick={onClose}
              className="ml-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-sm"
            >
              ✕
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-xs text-[var(--text-secondary)]">
            Loading usage data...
          </div>
        ) : (
          <>
            {/* Chart */}
            <div>
              <h3 className="text-xs font-medium text-[var(--text-secondary)] mb-2">
                Last 14 Days
              </h3>
              <UsageChart data={history} mode={mode} />
            </div>

            {/* Project table */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              <h3 className="text-xs font-medium text-[var(--text-secondary)] mb-2">
                By Project
              </h3>
              {projects.length === 0 ? (
                <div className="text-xs text-[var(--text-secondary)] py-4 text-center">
                  No project data
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[var(--text-tertiary)] border-b border-[var(--border-color)] bg-[var(--bg-primary)]/50">
                      <th className="text-left py-1.5 font-medium">
                        Directory
                      </th>
                      <th className="text-right py-1.5 font-medium">
                        Sessions
                      </th>
                      <th className="text-right py-1.5 font-medium">Tokens</th>
                      <th className="text-right py-1.5 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p) => (
                      <tr
                        key={p.directory}
                        className="border-b border-[var(--border-color)] border-opacity-50"
                      >
                        <td
                          className="py-1.5 text-[var(--text-primary)] truncate max-w-[300px] font-mono"
                          title={p.directory}
                        >
                          {p.directory}
                        </td>
                        <td className="py-1.5 text-right text-[var(--text-secondary)]">
                          {p.sessionCount}
                        </td>
                        <td className="py-1.5 text-right text-[var(--text-secondary)]">
                          {formatTokens(p.totalTokens)}
                        </td>
                        <td className="py-1.5 text-right text-[var(--text-primary)] font-medium">
                          ${p.costUsd.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-[var(--border-color)]">
                      <td className="py-1.5 text-[var(--text-primary)] font-semibold">
                        Total
                      </td>
                      <td className="py-1.5 text-right text-[var(--text-secondary)] font-semibold">
                        {projects.reduce((s, p) => s + p.sessionCount, 0)}
                      </td>
                      <td className="py-1.5 text-right text-[var(--text-secondary)] font-semibold">
                        {formatTokens(projects.reduce((s, p) => s + p.totalTokens, 0))}
                      </td>
                      <td className="py-1.5 text-right text-[var(--accent)] font-semibold">
                        ${projects.reduce((s, p) => s + p.costUsd, 0).toFixed(2)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
