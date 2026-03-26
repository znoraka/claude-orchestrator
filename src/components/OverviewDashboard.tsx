import { memo, useMemo } from "react";
import type { Workspace, Session, SessionUsage } from "../types";
import WorkspaceCard from "./WorkspaceCard";
import { getServerPort } from "../lib/bridge";

interface Props {
  workspaces: Workspace[];
  sessionUsage: Map<string, SessionUsage>;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  youngestDescendantMap?: Map<string, Session>;
}

export default memo(function OverviewDashboard({
  workspaces,
  sessionUsage,
  onSelectSession,
  onNewSession,
  youngestDescendantMap,
}: Props) {
  const allSessions = useMemo(
    () => workspaces.flatMap((w) => w.worktrees.flatMap((wt) => wt.sessions.filter((s) => !s.archived))),
    [workspaces]
  );

  const serverPort = getServerPort();
  const runningCount = allSessions.filter((s) => s.status === "running" || s.status === "starting").length;
  const waitingCount = allSessions.filter((s) => s.hasQuestion).length;
  const totalCost = useMemo(
    () => [...sessionUsage.values()].reduce((sum, u) => sum + (u.costUsd ?? 0), 0),
    [sessionUsage]
  );

  if (workspaces.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center animate-fade-in-up">
        <div className="text-center">
          <div className="w-20 h-20 bg-[var(--bg-tertiary)] flex items-center justify-center border border-[var(--border-subtle)] mx-auto mb-6">
            <svg className="w-9 h-9 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-[var(--text-primary)] mb-2 tracking-wider uppercase">
            Claude Orchestrator
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mb-8">
            Manage multiple Claude CLI sessions across projects
          </p>
          <button
            onClick={onNewSession}
            className="px-6 py-2.5 bg-[var(--accent-color)] hover:bg-[var(--accent-hover)] text-black font-bold uppercase tracking-wider text-sm border-2 border-[var(--accent-color)] shadow-[4px_4px_0px_rgba(255, 122, 0,0.3)]"
          >
            New Session
          </button>
          <div className="mt-6 flex items-center justify-center gap-4 text-xs text-[var(--text-tertiary)]">
            <span>
              <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] font-mono text-[10px] border border-[var(--border-subtle)]">⌘N</kbd> New
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] font-mono text-[10px] border border-[var(--border-subtle)]">⌘K</kbd> Search
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 animate-fade-in-up">
      {/* Stats bar */}
      <div className="flex items-center gap-6 mb-6 pb-2">
        <div className="flex items-center gap-2">
          {runningCount > 0 ? (
            <span className="w-2 h-2 bg-[var(--status-running)] animate-pulse" />
          ) : (
            <span className="w-2 h-2 bg-[var(--status-stopped)]" />
          )}
          <span className="text-sm font-medium text-[var(--text-primary)]">
            {runningCount > 0 ? `${runningCount} running` : "Idle"}
          </span>
        </div>
        {waitingCount > 0 && (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-[var(--status-waiting)] animate-amber-pulse" />
            <span className="text-sm font-medium text-[var(--status-waiting)]">
              {waitingCount} waiting
            </span>
          </div>
        )}
        {totalCost > 0 && (
          <div className="text-sm text-[var(--text-secondary)] ml-auto">
            <span className="text-[var(--text-tertiary)]">Today </span>
            <span className="font-medium text-[var(--text-primary)]">${totalCost.toFixed(2)}</span>
          </div>
        )}
        {serverPort && (
          <button
            onClick={() => {
              navigator.clipboard.writeText(`http://localhost:${serverPort}`);
            }}
            title="Click to copy URL"
            className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
            </svg>
            <span className="font-mono">:{serverPort}</span>
          </button>
        )}
        <button
          onClick={onNewSession}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white ml-2"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          New Session
        </button>
      </div>

      {/* Workspace grid */}
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {workspaces.map((ws) => (
          <WorkspaceCard
            key={ws.id}
            workspace={ws}
            sessionUsage={sessionUsage}
            onSelectSession={onSelectSession}
            youngestDescendantMap={youngestDescendantMap}
          />
        ))}
      </div>
    </div>
  );
});
