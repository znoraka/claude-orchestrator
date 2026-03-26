import { memo, useMemo } from "react";
import type { Workspace, Session, SessionUsage } from "../types";
import { repoColor } from "./SessionTab";
import SessionStatusBadge, { type SessionStatus } from "./SessionStatusBadge";
import { worktreeName } from "../utils/workspaces";

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function sessionStatus(session: Session): SessionStatus {
  if (session.hasQuestion) return "waiting";
  if (session.status === "running") return "running";
  if (session.status === "starting") return "starting";
  if (session.exitCode !== undefined && session.exitCode !== 0) return "error";
  return "stopped";
}

interface WorkspaceCardProps {
  workspace: Workspace;
  sessionUsage: Map<string, SessionUsage>;
  onSelectSession: (id: string) => void;
  youngestDescendantMap?: Map<string, Session>;
}

export default memo(function WorkspaceCard({
  workspace,
  sessionUsage,
  onSelectSession,
  youngestDescendantMap,
}: WorkspaceCardProps) {
  const repoName = workspace.directory.split("/").filter(Boolean).pop() || workspace.directory;
  const color = repoColor(workspace.directory);

  const allSessions = useMemo(
    () => workspace.worktrees.flatMap((wt) => wt.sessions.filter((s) => !s.archived)),
    [workspace]
  );

  const costToday = useMemo(() => {
    return allSessions.reduce((sum, s) => {
      const youngest = youngestDescendantMap?.get(s.id);
      const usage = youngest ? sessionUsage.get(youngest.id) : sessionUsage.get(s.id);
      return sum + (usage?.costUsd ?? 0);
    }, 0);
  }, [allSessions, sessionUsage, youngestDescendantMap]);

  const runningCount = allSessions.filter((s) => s.status === "running" || s.status === "starting").length;
  const waitingCount = allSessions.filter((s) => s.hasQuestion).length;

  // Show top sessions: prioritize running/waiting, then most recent
  const displaySessions = useMemo(() => {
    const important = allSessions.filter((s) => !s.parentSessionId && (s.status === "running" || s.status === "starting" || s.hasQuestion));
    const rest = allSessions.filter((s) => !s.parentSessionId && !important.includes(s));
    return [...important, ...rest].slice(0, 4);
  }, [allSessions]);

  return (
    <div
      className="border border-[var(--card-border)] p-4 flex flex-col gap-3 hover:border-[var(--accent-color)] cursor-default"
      style={{ background: "var(--card-bg)" }}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 shrink-0" style={{ background: color }} />
        <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-primary)] truncate flex-1">
          {repoName}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {runningCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--status-running)] font-medium">
              <span className="w-1.5 h-1.5 bg-[var(--status-running)] animate-pulse" />
              {runningCount}
            </span>
          )}
          {waitingCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--status-waiting)] font-medium">
              <span className="w-1.5 h-1.5 bg-[var(--status-waiting)]" />
              {waitingCount} waiting
            </span>
          )}
        </div>
      </div>

      {/* Worktree label for non-main worktrees */}
      {workspace.worktrees.length === 1 && !workspace.worktrees[0].isMain && (
        <div className="text-[10px] text-[var(--text-tertiary)] -mt-1">
          {worktreeName(workspace.worktrees[0].path)}
        </div>
      )}

      {/* Session list */}
      <div className="flex flex-col gap-1">
        {displaySessions.length === 0 ? (
          <div className="text-xs text-[var(--text-tertiary)] py-2 text-center">No sessions</div>
        ) : (
          displaySessions.map((session) => {
            const youngest = youngestDescendantMap?.get(session.id);
            const effectiveSession = youngest
              ? { ...session, hasQuestion: youngest.hasQuestion, status: youngest.status, exitCode: youngest.exitCode }
              : session;
            const status = sessionStatus(effectiveSession);
            const usage = youngest ? sessionUsage.get(youngest.id) : sessionUsage.get(session.id);
            const ts = session.lastMessageAt || session.lastActiveAt || session.createdAt;

            return (
              <button
                key={session.id}
                onClick={() => onSelectSession(session.id)}
                className={`flex items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--bg-hover)] group ${
                  status === "waiting" ? "bg-amber-500/5" : ""
                }`}
              >
                <SessionStatusBadge status={status} size="md" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-[var(--text-primary)] truncate font-medium">
                    {session.name}
                  </div>
                  {status === "waiting" && (
                    <div className="text-[10px] text-[var(--status-waiting)]">Needs input</div>
                  )}
                  {status === "running" && (
                    <div className="text-[10px] text-[var(--status-running)]">Working…</div>
                  )}
                  {status === "stopped" && ts && (
                    <div className="text-[10px] text-[var(--text-tertiary)]">{timeAgo(ts)}</div>
                  )}
                </div>
                {usage && usage.costUsd > 0 && (
                  <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">
                    ${usage.costUsd.toFixed(2)}
                  </span>
                )}
              </button>
            );
          })
        )}
        {allSessions.filter((s) => !s.parentSessionId).length > 4 && (
          <div className="text-[10px] text-[var(--text-tertiary)] px-2">
            +{allSessions.filter((s) => !s.parentSessionId).length - 4} more
          </div>
        )}
      </div>

      {/* Footer */}
      {costToday > 0 && (
        <div className="text-[10px] text-[var(--text-tertiary)] border-t border-[var(--card-border)] pt-2 mt-1">
          ${costToday.toFixed(2)} today
        </div>
      )}
    </div>
  );
});
