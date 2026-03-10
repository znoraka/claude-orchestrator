import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session, Workspace } from "../types";
import { worktreeName } from "../utils/workspaces";
import SessionTab, { repoColor } from "./SessionTab";
import { useSessionLive } from "../contexts/SessionContext";


interface SidebarProps {
  workspaces: Workspace[];
  activeSessionId: string | null;
  activeWorktreePath: string | null;
  youngestDescendantMap?: Map<string, Session>;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onCreateWorktree: (repoDir: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onDeleteSession: (id: string) => void;
  onArchiveSession?: (id: string) => void;
  onUnarchiveSession?: (id: string) => void;
  onArchiveWorktree?: (path: string) => void;
  shellProcessDirs?: Map<string, number>;
  worktreeBranches?: Map<string, string>;
}

export default function Sidebar({
  workspaces,
  activeSessionId,
  activeWorktreePath: _activeWorktreePath,
  onSelectSession,
  onCreateSession,
  onCreateWorktree,
  onRenameSession,
  onDeleteSession,
  onArchiveSession,
  onUnarchiveSession,
  onArchiveWorktree,
  shellProcessDirs,
  worktreeBranches,
  youngestDescendantMap,
}: SidebarProps) {
  const { sessionUsage, unreadSessions } = useSessionLive();
  const [filter, setFilter] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => {
    try { const v = localStorage.getItem("sidebar:collapsedRepos"); return v ? new Set(JSON.parse(v)) : new Set(); } catch { return new Set(); }
  });
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(() => {
    try { const v = localStorage.getItem("sidebar:collapsedWorktrees"); return v ? new Set(JSON.parse(v)) : new Set(); } catch { return new Set(); }
  });
  const [expandedWorktrees, setExpandedWorktrees] = useState<Set<string>>(() => {
    try { const v = localStorage.getItem("sidebar:expandedWorktrees"); return v ? new Set(JSON.parse(v)) : new Set(); } catch { return new Set(); }
  });
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => { localStorage.setItem("sidebar:collapsedRepos", JSON.stringify([...collapsedRepos])); }, [collapsedRepos]);
  useEffect(() => { localStorage.setItem("sidebar:collapsedWorktrees", JSON.stringify([...collapsedWorktrees])); }, [collapsedWorktrees]);
  useEffect(() => { localStorage.setItem("sidebar:expandedWorktrees", JSON.stringify([...expandedWorktrees])); }, [expandedWorktrees]);

  const branches = worktreeBranches ?? new Map<string, string>();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "k") {
        e.preventDefault();
        // Stop propagation so the App-level Cmd+K (command palette) doesn't also fire
        e.stopPropagation();
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

  const isImportantSession = useCallback(
    (s: Session): boolean => {
      if (s.id === activeSessionId) return true;
      if (unreadSessions?.has(s.id)) return true;
      if (s.status === "running" || s.status === "starting") return true;
      const youngest = youngestDescendantMap?.get(s.id);
      if (youngest) {
        if (unreadSessions?.has(youngest.id)) return true;
        if (youngest.status === "running" || youngest.status === "starting") return true;
        if (youngest.hasQuestion) return true;
      }
      if (s.hasQuestion) return true;
      return false;
    },
    [activeSessionId, unreadSessions, youngestDescendantMap]
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

  // Memoize filtered workspace/worktree tree so inline JSX map doesn't recompute on every render
  const filteredWorkspaces = useMemo(() => {
    if (!filterQ) return workspaces;
    return workspaces
      .map((workspace) => ({
        ...workspace,
        worktrees: workspace.worktrees
          .map((wt) => ({
            ...wt,
            sessions: wt.sessions.filter(sessionMatchesFilter),
          }))
          .filter((wt) => wt.sessions.length > 0),
      }))
      .filter((workspace) => workspace.worktrees.length > 0);
  }, [workspaces, filterQ, sessionMatchesFilter]);

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
        onArchive={onArchiveSession ? () => onArchiveSession(session.id) : undefined}
        onUnarchive={onUnarchiveSession ? () => onUnarchiveSession(session.id) : undefined}
        {...extraProps}
      />
    );
  };


  return (
    <div className="w-64 h-full bg-[var(--bg-secondary)] flex flex-col shrink-0 px-2 pt-3 pb-3">
      {/* Search input — minimal styling */}
      <div className="pb-2">
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
            className="sidebar-search w-full bg-transparent border-0 border-b border-[var(--border-subtle)] rounded-none pl-7 pr-6 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-all duration-200"
          />
          {contentSearching && (
            <div className="absolute right-1 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-[var(--text-tertiary)] border-t-transparent rounded-full animate-spin" />
          )}
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-0.5">
        {filteredWorkspaces.length > 0 ? (
          filteredWorkspaces.map((workspace, wsIdx) => {
            const repoName = workspace.directory.split("/").filter(Boolean).pop() || workspace.directory;
            const isRepoCollapsed = collapsedRepos.has(workspace.id);
            const filteredWorktrees = workspace.worktrees;

            const color = repoColor(workspace.directory);

            return (
              <div
                key={workspace.id}
                className={wsIdx > 0 ? "mt-3" : ""}
              >
                {/* Workspace header — clean, minimal */}
                <button
                  onClick={() => toggleRepo(workspace.id)}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-left hover:bg-[var(--bg-hover)]/40 transition-colors group"
                >
                  <svg
                    className={`w-2.5 h-2.5 shrink-0 text-[var(--text-tertiary)] transition-transform duration-150 ${
                      isRepoCollapsed ? "" : "rotate-90"
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 opacity-70" style={{ background: color }} />
                  <span className="text-[11px] font-semibold text-[var(--text-primary)] truncate flex-1 tracking-tight">
                    {repoName}
                  </span>
                </button>

                {/* Important sessions shown even when repo is collapsed */}
                {isRepoCollapsed && (() => {
                  const important = filteredWorktrees
                    .flatMap((wt) => wt.sessions)
                    .filter((s) => isImportantSession(s) && (!filterQ || sessionMatchesFilter(s)));
                  return important.map((session) => (
                    <div key={session.id}>
                      {renderSession(session, { hideDirectory: true })}
                    </div>
                  ));
                })()}

                {/* Worktrees */}
                {!isRepoCollapsed &&
                  filteredWorktrees.map((wt, wtIdx) => {
                    const wtName = wt.isMain ? "main" : worktreeName(wt.path);
                    const branch = branches.get(wt.path) || wt.branch;
                    const isWtCollapsed = collapsedWorktrees.has(wt.path);
                    const hasShellProcess = !!(shellProcessDirs?.get(wt.path));
                    const hasMultipleWorktrees = filteredWorktrees.length > 1;

                    // Deduplicate: if worktree name equals branch, show once
                    const displayLabel = branch && branch !== wtName
                      ? `${wtName} · ${branch}`
                      : wtName;

                    return (
                      <div key={wt.path}>
                        {/* Worktree row — lightweight divider */}
                        {hasMultipleWorktrees && (
                          <>
                            {wtIdx > 0 && (
                              <div className="mx-2 border-t border-[var(--border-color)]/30 my-1" />
                            )}
                            <button
                              onClick={() => toggleWorktree(wt.path)}
                              className="w-full flex items-center gap-1.5 pl-4 pr-2 py-1 text-left transition-colors hover:text-[var(--text-primary)] group"
                            >
                              <svg
                                className={`w-2 h-2 shrink-0 text-[var(--text-tertiary)] transition-transform ${
                                  isWtCollapsed ? "" : "rotate-90"
                                }`}
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2.5}
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                              </svg>
                              <svg className="w-2.5 h-2.5 shrink-0 text-[var(--text-tertiary)]" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                              </svg>
                              <span className="text-[11px] font-medium text-[var(--text-secondary)] truncate flex-1">
                                {displayLabel}
                              </span>
                              <span className="text-[10px] text-[var(--text-tertiary)] shrink-0 flex items-center gap-1">
                                {hasShellProcess && (
                                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" title="Shell process running" />
                                )}
                                {wt.sessions.filter((s) => !s.archived).length}
                                {!wt.isMain && onArchiveWorktree && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); onArchiveWorktree(wt.path); }}
                                    className="opacity-0 group-hover:opacity-100 ml-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-all"
                                    title="Archive worktree (removes git worktree, archives sessions)"
                                  >
                                    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                                      <path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v1.708a2.5 2.5 0 0 1 0 4.584V13.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5V8.792a2.5 2.5 0 0 1 0-4.584V2.5ZM3.5 2a.5.5 0 0 0-.5.5v1.543a2.5 2.5 0 0 1 0 4.914V13.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V8.957a2.5 2.5 0 0 1 0-4.914V2.5a.5.5 0 0 0-.5-.5h-9ZM8 10a.75.75 0 0 1-.75-.75V7.06l-.72.72a.75.75 0 0 1-1.06-1.06l2-2a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1-1.06 1.06l-.72-.72v2.19A.75.75 0 0 1 8 10Z" />
                                    </svg>
                                  </button>
                                )}
                              </span>
                            </button>
                          </>
                        )}

                        {/* Important sessions shown even when worktree is collapsed */}
                        {isWtCollapsed && hasMultipleWorktrees && (() => {
                          const important = wt.sessions.filter((s) => !s.archived && isImportantSession(s) && (!filterQ || sessionMatchesFilter(s)));
                          return important.map((session) => (
                            <div key={session.id}>
                              {renderSession(session, { hideDirectory: true })}
                            </div>
                          ));
                        })()}

                        {/* Sessions */}
                        {(!isWtCollapsed || !hasMultipleWorktrees) && (() => {
                          const MAX_INACTIVE = 3;
                          const isExpanded = expandedWorktrees.has(wt.path);
                          const topLevel = wt.sessions.filter((s) => !s.parentSessionId && !s.archived);
                          const showAll = isExpanded || !!filterQ;
                          let visible: Session[];
                          if (showAll) {
                            visible = topLevel;
                          } else {
                            const important = topLevel.filter(isImportantSession);
                            const rest = topLevel.filter((s) => !isImportantSession(s));
                            const merged = [...new Set([...important, ...rest.slice(0, Math.max(0, MAX_INACTIVE - important.length))])];
                            visible = merged.sort((a, b) => topLevel.indexOf(a) - topLevel.indexOf(b));
                          }
                          const hiddenCount = topLevel.length - visible.length;

                          return (
                            <>
                              {isExpanded && topLevel.length > MAX_INACTIVE && !filterQ && (
                                <button
                                  onClick={() => setExpandedWorktrees((prev) => {
                                    const next = new Set(prev);
                                    next.delete(wt.path);
                                    return next;
                                  })}
                                  className="pl-5 w-full px-3 py-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors text-left sticky top-0 z-10 bg-[var(--bg-primary)]"
                                >
                                  Show less
                                </button>
                              )}
                              {visible.map((session) => (
                                <div key={session.id}>
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
                                  className="pl-5 w-full px-3 py-1 text-[10px] text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors text-left font-medium"
                                >
                                  +{hiddenCount} more
                                </button>
                              )}
                              {isExpanded && topLevel.length > MAX_INACTIVE && !filterQ && (
                                <button
                                  onClick={() => setExpandedWorktrees((prev) => {
                                    const next = new Set(prev);
                                    next.delete(wt.path);
                                    return next;
                                  })}
                                  className="pl-5 w-full px-3 py-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors text-left"
                                >
                                  Show less
                                </button>
                              )}

                              {/* Archived sessions toggle */}
                              {(() => {
                                const archivedSessions = wt.sessions.filter((s) => !s.parentSessionId && s.archived);
                                if (archivedSessions.length === 0) return null;
                                return (
                                  <>
                                    <button
                                      onClick={() => setShowArchived((v) => !v)}
                                      className="pl-5 w-full px-3 py-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors text-left flex items-center gap-1"
                                    >
                                      <svg className={`w-2 h-2 transition-transform ${showArchived ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                      </svg>
                                      {archivedSessions.length} archived
                                    </button>
                                    {showArchived && archivedSessions.map((session) => (
                                      <div key={session.id} className="opacity-50">
                                        {renderSession(session, { hideDirectory: true })}
                                      </div>
                                    ))}
                                  </>
                                );
                              })()}
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
                    className="pl-4 w-full flex items-center gap-1.5 px-2 py-1 text-left text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors text-[10px]"
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
            {workspaces.length > 0 ? (
              <p className="text-xs text-[var(--text-secondary)]">No matching sessions</p>
            ) : (
              <>
                <p className="text-xs text-[var(--text-secondary)] mb-3">
                  No sessions yet
                </p>
                <button
                  onClick={onCreateSession}
                  className="text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors font-medium"
                >
                  Create your first session
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* New session button — full-width at bottom */}
      <button
        onClick={onCreateSession}
        className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] hover:border-[var(--border-color)] transition-all duration-150 shrink-0"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        New Session
      </button>
    </div>
  );
}
