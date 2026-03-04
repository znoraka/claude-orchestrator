import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionUsage, Workspace } from "../types";
import { worktreeName } from "../utils/workspaces";
import SessionTab, { directoryColor } from "./SessionTab";
import { useWorktreeBranches } from "../hooks/useWorktreeBranches";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

interface SidebarProps {
  workspaces: Workspace[];
  activeSessionId: string | null;
  activeWorktreePath: string | null;
  sessionUsage: Map<string, SessionUsage>;
  todayCost: number;
  todayTokens: number;
  onSelectSession: (id: string) => void;
  onSelectWorktree: (path: string) => void;
  onCreateSession: () => void;
  onCreateWorktree: (repoDir: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onDeleteSession: (id: string) => void;
  onShowUsage?: () => void;
}

export default function Sidebar({
  workspaces,
  activeSessionId,
  activeWorktreePath,
  sessionUsage,
  todayCost,
  todayTokens,
  onSelectSession,
  onSelectWorktree,
  onCreateSession,
  onCreateWorktree,
  onRenameSession,
  onDeleteSession,
  onShowUsage,
}: SidebarProps) {
  const [filter, setFilter] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(new Set());
  const [expandedWorktrees, setExpandedWorktrees] = useState<Set<string>>(new Set());

  const branches = useWorktreeBranches(workspaces);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Content search state
  const [contentMatchIds, setContentMatchIds] = useState<Set<string>>(new Set());
  const [contentSearching, setContentSearching] = useState(false);
  const contentSearchVersion = useRef(0);

  const allSessions = useMemo(
    () => workspaces.flatMap((w) => w.worktrees.flatMap((wt) => wt.sessions)),
    [workspaces]
  );

  useEffect(() => {
    const q = filter.trim();
    if (!q) {
      setContentMatchIds(new Set());
      setContentSearching(false);
      return;
    }
    const version = ++contentSearchVersion.current;
    setContentSearching(true);
    const timer = setTimeout(async () => {
      try {
        const searchable = allSessions
          .filter((s) => s.claudeSessionId && s.directory)
          .map((s) => ({
            claudeSessionId: s.claudeSessionId!,
            directory: s.directory,
          }));
        const matchedIds = await invoke<string[]>("search_session_content", {
          sessions: searchable,
          query: q,
        });
        if (contentSearchVersion.current === version) {
          setContentMatchIds(new Set(matchedIds));
          setContentSearching(false);
        }
      } catch {
        if (contentSearchVersion.current === version) {
          setContentMatchIds(new Set());
          setContentSearching(false);
        }
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [filter, allSessions]);

  // Filter logic
  const filterQ = filter.toLowerCase().trim();

  const sessionMatchesFilter = useCallback(
    (s: Session): boolean => {
      if (!filterQ) return true;
      if (
        s.name.toLowerCase().includes(filterQ) ||
        (s.directory && s.directory.toLowerCase().includes(filterQ))
      )
        return true;
      if (s.claudeSessionId && contentMatchIds.has(s.claudeSessionId)) return true;
      return false;
    },
    [filterQ, contentMatchIds]
  );

  const contentOnlyIds = useMemo(() => {
    if (!filterQ) return new Set<string>();
    return new Set(
      allSessions
        .filter(
          (s) =>
            !(
              s.name.toLowerCase().includes(filterQ) ||
              (s.directory && s.directory.toLowerCase().includes(filterQ))
            ) &&
            s.claudeSessionId &&
            contentMatchIds.has(s.claudeSessionId)
        )
        .map((s) => s.id)
    );
  }, [allSessions, filterQ, contentMatchIds]);

  const toggleRepo = (repoId: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  };

  const toggleWorktree = (wtPath: string) => {
    setCollapsedWorktrees((prev) => {
      const next = new Set(prev);
      if (next.has(wtPath)) next.delete(wtPath);
      else next.add(wtPath);
      return next;
    });
  };

  const runningSessions = allSessions.filter((s) => s.status === "running").length;

  return (
    <div className="w-64 h-full bg-[var(--bg-secondary)] flex flex-col shrink-0 px-2 pt-4 pb-3">
      {/* Header */}
      <div className="px-2 pb-3 flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-[var(--accent)] flex items-center justify-center text-white text-sm font-bold">
          C
        </div>
        <span className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">
          Claude Sessions
        </span>
      </div>

      {/* New Session button */}
      <div className="px-2 py-2">
        <button
          onClick={onCreateSession}
          className="w-full py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium transition-colors"
        >
          New Session
        </button>
      </div>

      {/* Search */}
      <div className="px-2 pb-2">
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-tertiary)]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
            />
          </svg>
          <input
            ref={searchRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search sessions..."
            className="sidebar-search w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg pl-8 pr-3 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors"
          />
          {contentSearching && (
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-[var(--text-tertiary)] border-t-transparent rounded-full animate-spin" />
          )}
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {workspaces.length > 0 ? (
          workspaces.map((workspace) => {
            const repoName = workspace.directory.split("/").filter(Boolean).pop() || workspace.directory;
            const isRepoCollapsed = collapsedRepos.has(workspace.id);

            // Filter: does this workspace have any matching sessions?
            const filteredWorktrees = filterQ
              ? workspace.worktrees
                  .map((wt) => ({
                    ...wt,
                    sessions: wt.sessions.filter(sessionMatchesFilter),
                  }))
                  .filter((wt) => wt.sessions.length > 0)
              : workspace.worktrees;

            if (filterQ && filteredWorktrees.length === 0) return null;

            const color = directoryColor(workspace.directory);

            return (
              <div
                key={workspace.id}
                className="mb-1.5 rounded-md ml-0.5"
                style={{ borderLeft: `2px solid ${color}` }}
              >
                {/* Repo header */}
                <button
                  onClick={() => toggleRepo(workspace.id)}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-left hover:bg-[var(--bg-hover)] transition-colors group"
                >
                  <svg
                    className={`w-3 h-3 shrink-0 text-[var(--text-tertiary)] transition-transform ${
                      isRepoCollapsed ? "" : "rotate-90"
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <svg
                    className="w-3.5 h-3.5 shrink-0"
                    style={{ color }}
                    viewBox="0 0 16 16"
                    fill="currentColor"
                  >
                    <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
                  </svg>
                  <span className="text-[11px] font-semibold text-[var(--text-primary)] truncate flex-1">
                    {repoName}
                  </span>
                  <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">
                    {workspace.worktrees.reduce((n, wt) => n + wt.sessions.length, 0)}
                  </span>
                </button>

                {/* Worktrees */}
                {!isRepoCollapsed &&
                  filteredWorktrees.map((wt) => {
                    const wtName = wt.isMain ? "main" : worktreeName(wt.path);
                    const branch = branches.get(wt.path) || wt.branch;
                    const isWtCollapsed = collapsedWorktrees.has(wt.path);
                    const isActiveWt = activeWorktreePath === wt.path;

                    return (
                      <div key={wt.path} className="ml-3">
                        {/* Worktree row */}
                        <button
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest(".wt-collapse-btn")) return;
                            onSelectWorktree(wt.path);
                          }}
                          className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left transition-colors group ${
                            isActiveWt
                              ? "bg-[var(--bg-tertiary)]"
                              : "hover:bg-[var(--bg-hover)]"
                          }`}
                        >
                          <button
                            className="wt-collapse-btn shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleWorktree(wt.path);
                            }}
                          >
                            <svg
                              className={`w-2.5 h-2.5 text-[var(--text-tertiary)] transition-transform ${
                                isWtCollapsed ? "" : "rotate-90"
                              }`}
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                          {/* Branch icon */}
                          <svg className="w-3 h-3 shrink-0 text-[var(--text-tertiary)]" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                          </svg>
                          <span className="text-[11px] text-[var(--text-secondary)] truncate flex-1">
                            {wtName}
                            {branch && (
                              <span className="text-[var(--text-tertiary)] ml-1">
                                ({branch})
                              </span>
                            )}
                          </span>
                          <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">
                            {wt.sessions.length}
                          </span>
                        </button>

                        {/* Sessions */}
                        {!isWtCollapsed && (() => {
                          const MAX_INACTIVE = 3;
                          const isExpanded = expandedWorktrees.has(wt.path);
                          const active = wt.sessions.filter((s) => s.status === "running" || s.status === "starting");
                          const inactive = wt.sessions.filter((s) => s.status === "stopped");
                          const hasActive = active.length > 0;
                          // Show: all active + limited inactive (unless expanded or searching)
                          const showAll = isExpanded || !!filterQ;
                          const visibleInactive = showAll ? inactive : inactive.slice(0, hasActive ? 0 : MAX_INACTIVE);
                          const hiddenCount = inactive.length - visibleInactive.length;
                          const visible = [...active, ...visibleInactive];

                          return (
                            <>
                              {visible.map((session) => (
                                <div key={session.id} className="ml-3">
                                  <SessionTab
                                    session={session}
                                    isActive={session.id === activeSessionId}
                                    usage={sessionUsage.get(session.id)}
                                    contentOnly={contentOnlyIds.has(session.id)}
                                    hideDirectory
                                    onClick={() => onSelectSession(session.id)}
                                    onRename={(name) => onRenameSession(session.id, name)}
                                    onDelete={() => onDeleteSession(session.id)}
                                  />
                                </div>
                              ))}
                              {hiddenCount > 0 && (
                                <button
                                  onClick={() => setExpandedWorktrees((prev) => {
                                    const next = new Set(prev);
                                    next.add(wt.path);
                                    return next;
                                  })}
                                  className="ml-3 w-[calc(100%-12px)] px-3 py-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors text-left"
                                >
                                  {hiddenCount} more session{hiddenCount !== 1 ? "s" : ""}…
                                </button>
                              )}
                              {isExpanded && inactive.length > MAX_INACTIVE && !filterQ && (
                                <button
                                  onClick={() => setExpandedWorktrees((prev) => {
                                    const next = new Set(prev);
                                    next.delete(wt.path);
                                    return next;
                                  })}
                                  className="ml-3 w-[calc(100%-12px)] px-3 py-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors text-left"
                                >
                                  Show less
                                </button>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    );
                  })}

                {/* New worktree button */}
                {!isRepoCollapsed && (
                  <button
                    onClick={() => onCreateWorktree(workspace.directory)}
                    className="ml-3 w-[calc(100%-12px)] flex items-center gap-1.5 px-2 py-1 rounded-md text-left text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors text-[10px]"
                  >
                    <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                    New worktree
                  </button>
                )}
              </div>
            );
          })
        ) : (
          <div className="px-3 py-12 text-center">
            <p className="text-xs text-[var(--text-secondary)] mb-3">
              No sessions yet
            </p>
            <button
              onClick={onCreateSession}
              className="text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors font-medium"
            >
              Create your first session
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-2 py-3 border-t border-[var(--border-color)] flex items-center gap-2">
        <div className="w-6 h-6 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] flex items-center justify-center text-[10px] text-[var(--text-secondary)] font-medium">
          {runningSessions}
        </div>
        <span className="text-[11px] text-[var(--text-secondary)]">
          active sessions
        </span>
        {(todayCost > 0 || todayTokens > 0) && (
          <button
            onClick={onShowUsage}
            className="text-[11px] text-[var(--text-secondary)] ml-auto hover:text-[var(--accent)] transition-colors cursor-pointer"
          >
            {todayTokens > 0 && <>{formatTokens(todayTokens)} tokens · </>}
            ${todayCost.toFixed(2)} today
          </button>
        )}
      </div>
    </div>
  );
}
