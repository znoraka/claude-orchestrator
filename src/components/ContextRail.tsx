import { memo, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionUsage } from "../types";

interface GitFile {
  path: string;
  status: string;
  staged: boolean;
}

interface GitStatusResult {
  branch: string;
  files: GitFile[];
  isGitRepo: boolean;
}

interface Props {
  directory: string;
  sessionUsage: Map<string, SessionUsage>;
  activeSessionId: string | null;
  defaultTab?: "git" | "cost";
  onTabChange?: (tab: "git" | "cost") => void;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "M") return <span className="text-[var(--status-waiting)] font-mono text-[10px] w-3">M</span>;
  if (status === "A" || status === "?") return <span className="text-[var(--status-running)] font-mono text-[10px] w-3">A</span>;
  if (status === "D") return <span className="text-[var(--danger)] font-mono text-[10px] w-3">D</span>;
  return <span className="text-[var(--text-tertiary)] font-mono text-[10px] w-3">{status}</span>;
}

const ContextRail = memo(function ContextRail({
  directory,
  sessionUsage,
  activeSessionId,
  defaultTab = "git",
  onTabChange,
}: Props) {
  const [activeTab, setActiveTab] = useState<"git" | "cost">(defaultTab);
  const [gitFiles, setGitFiles] = useState<GitFile[]>([]);
  const [gitBranch, setGitBranch] = useState<string>("");
  const [gitLoading, setGitLoading] = useState(false);

  useEffect(() => {
    if (activeTab !== "git" || !directory) return;
    let cancelled = false;
    setGitLoading(true);

    const fetch = async () => {
      try {
        const result = await invoke<GitStatusResult>("get_git_status", { directory });
        if (cancelled) return;
        setGitBranch(result.branch);
        setGitFiles(result.files);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setGitLoading(false);
      }
    };

    fetch();
    const interval = setInterval(fetch, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [directory, activeTab]);

  const handleTabChange = (tab: "git" | "cost") => {
    setActiveTab(tab);
    onTabChange?.(tab);
  };

  const totalCost = [...sessionUsage.values()].reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
  const activeUsage = activeSessionId ? sessionUsage.get(activeSessionId) : undefined;

  return (
    <div
      className="flex flex-col h-full border-l border-[var(--border-subtle)]"
      style={{ background: "var(--rail-bg)", width: 320 }}
    >
      {/* Tab bar */}
      <div className="flex items-center border-b border-[var(--border-subtle)] px-3 pt-2 gap-1 shrink-0">
        <button
          onClick={() => handleTabChange("git")}
          className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
            activeTab === "git"
              ? "text-[var(--text-primary)] border-b-2 border-[var(--accent)] -mb-px"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          }`}
        >
          Git
        </button>
        <button
          onClick={() => handleTabChange("cost")}
          className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
            activeTab === "cost"
              ? "text-[var(--text-primary)] border-b-2 border-[var(--accent)] -mb-px"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          }`}
        >
          Cost
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {activeTab === "git" && (
          <div className="flex flex-col gap-2">
            {/* Branch */}
            {gitBranch && (
              <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] pb-2 border-b border-[var(--border-subtle)]">
                <svg className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                </svg>
                <span className="font-mono truncate">{gitBranch}</span>
              </div>
            )}

            {gitLoading && gitFiles.length === 0 && (
              <div className="text-xs text-[var(--text-tertiary)] py-4 text-center">Loading…</div>
            )}

            {!gitLoading && gitFiles.length === 0 && (
              <div className="text-xs text-[var(--text-tertiary)] py-4 text-center">
                No changes
              </div>
            )}

            {gitFiles.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <div className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-1">
                  {gitFiles.length} file{gitFiles.length !== 1 ? "s" : ""} changed
                </div>
                {gitFiles.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-[var(--bg-hover)] group">
                    <StatusIcon status={f.status} />
                    <span className="text-xs text-[var(--text-secondary)] truncate font-mono flex-1">
                      {f.path}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "cost" && (
          <div className="flex flex-col gap-4">
            {/* Active session cost */}
            {activeUsage && (
              <div className="rounded-lg border border-[var(--card-border)] p-3" style={{ background: "var(--card-bg)" }}>
                <div className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2">Current Session</div>
                <div className="text-2xl font-bold text-[var(--text-primary)]">
                  ${activeUsage.costUsd.toFixed(2)}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-[var(--text-tertiary)]">
                  <div>In: {(activeUsage.inputTokens / 1000).toFixed(1)}k</div>
                  <div>Out: {(activeUsage.outputTokens / 1000).toFixed(1)}k</div>
                  <div>Cache: {(activeUsage.cacheReadInputTokens / 1000).toFixed(1)}k</div>
                  <div>Context: {Math.round(activeUsage.contextTokens / 1000)}k</div>
                </div>
              </div>
            )}

            {/* Total today */}
            <div className="rounded-lg border border-[var(--card-border)] p-3" style={{ background: "var(--card-bg)" }}>
              <div className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2">Total Today</div>
              <div className="text-2xl font-bold text-[var(--text-primary)]">
                ${totalCost.toFixed(2)}
              </div>
              <div className="text-[10px] text-[var(--text-tertiary)] mt-1">
                across {sessionUsage.size} session{sessionUsage.size !== 1 ? "s" : ""}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default ContextRail;
