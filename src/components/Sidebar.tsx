import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionUsage, Workspace } from "../types";
import { worktreeName } from "../utils/workspaces";
import SessionTab, { repoColor } from "./SessionTab";


interface SidebarProps {
  workspaces: Workspace[];
  activeSessionId: string | null;
  activeWorktreePath: string | null;
  sessionUsage: Map<string, SessionUsage>;
  youngestDescendantMap?: Map<string, Session>;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onCreateWorktree: (repoDir: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onDeleteSession: (id: string) => void;
  shellProcessDirs?: Map<string, number>;
  unreadSessions?: Set<string>;
  worktreeBranches?: Map<string, string>;
}

type ViewMode = "workspace" | "date";

function dateGroup(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - 86400000) return "Yesterday";
  const dayOfWeek = now.getDay() || 7; // Mon=1..Sun=7
  if (ts >= startOfToday - (dayOfWeek - 1) * 86400000) return "This Week";
  if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) return "This Month";
  return "Older";
}

const DATE_GROUP_ORDER = ["Today", "Yesterday", "This Week", "This Month", "Older"];

export default function Sidebar({
  workspaces,
  activeSessionId,
  activeWorktreePath,
  sessionUsage,
  onSelectSession,
  onCreateSession,
  onCreateWorktree,
  onRenameSession,
  onDeleteSession,
  shellProcessDirs,
  unreadSessions,
  worktreeBranches,
  youngestDescendantMap,
}: SidebarProps) {
  const [filter, setFilter] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => (localStorage.getItem("claude-orchestrator-sidebar-view") as ViewMode) || "workspace"
  );
  const [collapsedDateGroups, setCollapsedDateGroups] = useState<Set<string>>(new Set());
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(new Set());
  const [expandedWorktrees, setExpandedWorktrees] = useState<Set<string>>(new Set());

  const branches = worktreeBranches ?? new Map<string, string>();

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

  // Parent/child fork maps for SessionTab indicators
  const { parentNameMap, childCountMap } = useMemo(() => {
    const nameMap = new Map<string, string>();
    for (const s of allSessions) nameMap.set(s.id, s.name);

    const pMap = new Map<string, string>(); // child id → parent name
    const cMap = new Map<string, number>(); // parent id → child count
    for (const s of allSessions) {
      if (s.parentSessionId) {
        pMap.set(s.id, nameMap.get(s.parentSessionId) || "Unknown");
        cMap.set(s.parentSessionId, (cMap.get(s.parentSessionId) || 0) + 1);
      }
    }
    return { parentNameMap: pMap, childCountMap: cMap };
  }, [allSessions]);

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

  // Date-grouped view
  const dateGroupedSessions = useMemo(() => {
    let sessions = allSessions.filter((s) => !s.parentSessionId || s.id === activeSessionId);
    if (filterQ) sessions = sessions.filter(sessionMatchesFilter);
    const groups = new Map<string, Session[]>();
    for (const s of sessions) {
      const g = dateGroup(s.lastActiveAt);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(s);
    }
    // Sort sessions within each group by lastActiveAt desc
    for (const arr of groups.values()) arr.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return DATE_GROUP_ORDER.filter((g) => groups.has(g)).map((g) => ({ label: g, sessions: groups.get(g)! }));
  }, [allSessions, filterQ, sessionMatchesFilter, activeSessionId]);

  const toggleDateGroup = (label: string) => {
    setCollapsedDateGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

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

  const renderSession = (session: Session, extraProps: Partial<import("./SessionTab").SessionTabProps> = {}) => {
    // For sessions with children, show the youngest descendant's usage & status indicators
    const youngest = youngestDescendantMap?.get(session.id);
    const displayUsage = youngest ? sessionUsage.get(youngest.id) : sessionUsage.get(session.id);
    const displaySession = youngest
      ? { ...session, hasQuestion: youngest.hasQuestion, hasDraft: youngest.hasDraft, status: youngest.status }
      : session;

    return (
      <SessionTab
        key={session.id}
        session={displaySession}
        isActive={session.id === activeSessionId}
        usage={displayUsage}
        contentOnly={contentOnlyIds.has(session.id)}
        unread={unreadSessions?.has(session.id)}
        parentName={parentNameMap.get(session.id)}
        childCount={childCountMap.get(session.id)}
        onClick={() => onSelectSession(session.id)}
        onRename={(name) => onRenameSession(session.id, name)}
        onDelete={() => onDeleteSession(session.id)}
        {...extraProps}
      />
    );
  };


  return (
    <div className="w-64 h-full bg-[var(--bg-secondary)] flex flex-col shrink-0 px-2 pt-3 pb-3">
      {/* Header + New Session */}
      <div className="px-1 pb-2 flex items-center gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="w-6 h-6 rounded-md bg-[var(--accent)] flex items-center justify-center text-white text-xs font-bold shrink-0">
            C
          </div>
          <span className="text-xs font-semibold text-[var(--text-primary)] tracking-tight truncate">
            Sessions
          </span>
        </div>
        <button
          onClick={onCreateSession}
          className="px-2.5 py-1 rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[11px] font-medium transition-colors shrink-0"
        >
          + New
        </button>
      </div>

      {/* Search */}
      <div className="px-1 pb-1.5">
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
            className="sidebar-search w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-md pl-8 pr-3 py-1 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors"
          />
          {contentSearching && (
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-[var(--text-tertiary)] border-t-transparent rounded-full animate-spin" />
          )}
        </div>
      </div>

      {/* View toggle */}
      <div className="px-1 pb-1.5 flex">
        <div className="flex bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-md overflow-hidden w-full">
          <button
            onClick={() => { setViewMode("workspace"); localStorage.setItem("claude-orchestrator-sidebar-view", "workspace"); }}
            className={`flex-1 text-[10px] py-0.5 transition-colors ${
              viewMode === "workspace"
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-medium"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            }`}
          >
            Workspaces
          </button>
          <button
            onClick={() => { setViewMode("date"); localStorage.setItem("claude-orchestrator-sidebar-view", "date"); }}
            className={`flex-1 text-[10px] py-0.5 transition-colors ${
              viewMode === "date"
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-medium"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            }`}
          >
            By Date
          </button>
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {viewMode === "date" ? (
          dateGroupedSessions.length > 0 ? (
            dateGroupedSessions.map(({ label, sessions }) => {
              const isCollapsed = collapsedDateGroups.has(label);
              return (
                <div key={label} className="mb-1">
                  <button
                    onClick={() => toggleDateGroup(label)}
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <svg
                      className={`w-3 h-3 shrink-0 text-[var(--text-tertiary)] transition-transform ${
                        isCollapsed ? "" : "rotate-90"
                      }`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="text-[11px] font-semibold text-[var(--text-secondary)] flex-1">
                      {label}
                    </span>
                    <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">
                      {sessions.length}
                    </span>
                  </button>
                  {!isCollapsed &&
                    sessions.map((session) => (
                      <div key={session.id} className="ml-1">
                        {renderSession(session)}
                      </div>
                    ))}
                </div>
              );
            })
          ) : (
            <div className="px-3 py-12 text-center">
              <p className="text-xs text-[var(--text-secondary)] mb-3">No sessions found</p>
            </div>
          )
        ) : workspaces.length > 0 ? (
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

            const color = repoColor(workspace.directory);

            return (
              <div
                key={workspace.id}
                className="mb-1.5 rounded-md ml-0.5"
                style={{ borderLeft: `2px solid ${color}` }}
              >
                {/* Repo header */}
                <button
                  onClick={() => toggleRepo(workspace.id)}
                  className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left hover:bg-[var(--bg-hover)] transition-colors group"
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
                  <span className="text-[10px] text-[var(--text-tertiary)] shrink-0 flex items-center gap-1">
                    {workspace.worktrees.some((wt) => shellProcessDirs?.get(wt.path)) && (
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" title="Shell process running" />
                    )}
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
                    const hasShellProcess = !!(shellProcessDirs?.get(wt.path));

                    return (
                      <div key={wt.path} className="ml-1">
                        {/* Worktree row */}
                        <button
                          onClick={() => toggleWorktree(wt.path)}
                          className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left transition-colors group ${
                            isActiveWt
                              ? "bg-[var(--bg-tertiary)]"
                              : "hover:bg-[var(--bg-hover)]"
                          }`}
                        >
                          <svg
                            className={`w-2.5 h-2.5 shrink-0 text-[var(--text-tertiary)] transition-transform ${
                              isWtCollapsed ? "" : "rotate-90"
                            }`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
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
                          <span className="text-[10px] text-[var(--text-tertiary)] shrink-0 flex items-center gap-1">
                            {hasShellProcess && (
                              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" title="Shell process running" />
                            )}
                            {wt.sessions.length}
                          </span>
                        </button>

                        {/* Sessions */}
                        {!isWtCollapsed && (() => {
                          const MAX_INACTIVE = 3;
                          const isExpanded = expandedWorktrees.has(wt.path);
                          const topLevel = wt.sessions.filter((s) => !s.parentSessionId || s.id === activeSessionId);
                          const active = topLevel.filter((s) => s.status === "running" || s.status === "starting");
                          const inactive = topLevel.filter((s) => s.status === "stopped");
                          const hasActive = active.length > 0;
                          // Show: all active + limited inactive (unless expanded or searching)
                          const showAll = isExpanded || !!filterQ;
                          const visibleInactive = showAll ? inactive : inactive.slice(0, hasActive ? 0 : MAX_INACTIVE);
                          const hiddenCount = inactive.length - visibleInactive.length;
                          const visible = [...active, ...visibleInactive];

                          return (
                            <>
                              {visible.map((session) => (
                                <div key={session.id} className="ml-1">
                                  {renderSession(session, { hideDirectory: true })}
                                </div>
                              ))}
                              {hiddenCount > 0 && (
                                <button
                                  onClick={() => setExpandedWorktrees((prev) => {
                                    const next = new Set(prev);
                                    next.add(wt.path);
                                    return next;
                                  })}
                                  className="ml-1 w-[calc(100%-4px)] px-3 py-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors text-left"
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
                                  className="ml-1 w-[calc(100%-4px)] px-3 py-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors text-left"
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
                    className="ml-1 w-[calc(100%-4px)] flex items-center gap-1.5 px-2 py-1 rounded-md text-left text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors text-[10px]"
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

    </div>
  );
}
