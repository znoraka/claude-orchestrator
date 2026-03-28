import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { invoke } from "../lib/bridge";
import { getVersion } from "../lib/bridge";
import type { Session, Workspace } from "../types";
import SessionTab, { repoColor } from "./SessionTab";
import { useSessionLive } from "../contexts/SessionContext";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useStore } from "../store";
import { Spinner } from "./ui/spinner";


function SortableWorkspaceItem({
  id,
  children,
}: {
  id: string;
  children: (dragHandleListeners: ReturnType<typeof useSortable>["listeners"]) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative",
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      {children(listeners)}
    </div>
  );
}

interface SidebarProps {
  workspaces: Workspace[];
  activeSessionId: string | null;
  youngestDescendantMap?: Map<string, Session>;
  terminalBusyIds?: Set<string>;
  terminalCommands?: Map<string, string>;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onRenameSession: (id: string, name: string) => void;
  onDeleteSession: (id: string) => void;
  onArchiveSession?: (id: string) => void;
  onUnarchiveSession?: (id: string) => void;
}

export default function Sidebar({
  workspaces,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  onArchiveSession,
  onUnarchiveSession,
  youngestDescendantMap,
  terminalBusyIds,
  terminalCommands,
}: SidebarProps) {
  const { sessionUsage, unreadSessions } = useSessionLive();
  const { workspaceOrder, reorderWorkspaces } = useStore();
  const [appVersion, setAppVersion] = useState<string>("");
  const [filter, setFilter] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => {
    try { const v = localStorage.getItem("sidebar:collapsedRepos"); return v ? new Set(JSON.parse(v)) : new Set(); } catch { return new Set(); }
  });
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => {
    try { const v = localStorage.getItem("sidebar:expandedWorktrees"); return v ? new Set(JSON.parse(v)) : new Set(); } catch { return new Set(); }
  });
  const [showArchived, setShowArchived] = useState(false);
  const [keyboardSelectedId, setKeyboardSelectedId] = useState<string | null>(null);
  const sessionItemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const flatSessionsRef = useRef<Session[]>([]);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  useEffect(() => { localStorage.setItem("sidebar:collapsedRepos", JSON.stringify([...collapsedDirs])); }, [collapsedDirs]);
  useEffect(() => { localStorage.setItem("sidebar:expandedWorktrees", JSON.stringify([...expandedDirs])); }, [expandedDirs]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "k") {
        e.preventDefault();
        // Stop propagation so the App-level Cmd+K (command palette) doesn't also fire
        e.stopPropagation();
        searchRef.current?.focus();
        setKeyboardSelectedId(flatSessionsRef.current[0]?.id ?? null);
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
      if (s.sessionType !== "terminal" && (s.status === "running" || s.status === "starting")) return true;
      if (s.sessionType === "terminal" && terminalBusyIds?.has(s.id)) return true;
      const youngest = youngestDescendantMap?.get(s.id);
      if (youngest) {
        if (unreadSessions?.has(youngest.id)) return true;
        if (youngest.status === "running" || youngest.status === "starting") return true;
        if (youngest.hasQuestion) return true;
      }
      if (s.hasQuestion) return true;
      return false;
    },
    [activeSessionId, unreadSessions, youngestDescendantMap, terminalBusyIds]
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

  // Memoize filtered workspaces
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

  // Sort workspaces by stored order
  const sortedWorkspaces = useMemo(() => {
    if (workspaceOrder.length === 0) return filteredWorkspaces;
    return [...filteredWorkspaces].sort((a, b) => {
      const ai = workspaceOrder.indexOf(a.id);
      const bi = workspaceOrder.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [filteredWorkspaces, workspaceOrder]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = sortedWorkspaces.map((w) => w.id);
    const oldIndex = ids.indexOf(active.id as string);
    const newIndex = ids.indexOf(over.id as string);
    if (oldIndex < 0 || newIndex < 0) return;
    reorderWorkspaces(arrayMove(ids, oldIndex, newIndex));
  }, [sortedWorkspaces, reorderWorkspaces]);

  const flatSessions = useMemo(() => {
    const list = filteredWorkspaces.flatMap((ws) =>
      ws.worktrees.flatMap((wt) =>
        wt.sessions.filter((s) => !s.parentSessionId && !s.archived)
      )
    );
    flatSessionsRef.current = list;
    return list;
  }, [filteredWorkspaces]);

  // Auto-select first item when filter changes
  useEffect(() => {
    setKeyboardSelectedId(filterQ ? (flatSessions[0]?.id ?? null) : null);
  }, [filterQ, flatSessions]);

  // Scroll keyboard-selected item into view
  useEffect(() => {
    if (!keyboardSelectedId) return;
    const el = sessionItemRefs.current.get(keyboardSelectedId);
    el?.scrollIntoView({ block: "nearest" });
  }, [keyboardSelectedId]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const list = flatSessionsRef.current;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const idx = keyboardSelectedId ? list.findIndex((s) => s.id === keyboardSelectedId) : -1;
      const next = e.key === "ArrowDown"
        ? Math.min(idx + 1, list.length - 1)
        : Math.max(idx - 1, 0);
      setKeyboardSelectedId(list[next]?.id ?? null);
    } else if (e.key === "Enter") {
      if (keyboardSelectedId) {
        onSelectSession(keyboardSelectedId);
        setFilter("");
        setKeyboardSelectedId(null);
        searchRef.current?.blur();
      }
    } else if (e.key === "Escape") {
      setFilter("");
      setKeyboardSelectedId(null);
      searchRef.current?.blur();
    }
  }, [keyboardSelectedId, onSelectSession]);

  const toggleDir = (dirId: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirId)) next.delete(dirId);
      else next.add(dirId);
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

    const isKeyboardSelected = session.id === keyboardSelectedId;
    return (
      <div
        key={session.id}
        ref={(el) => {
          if (el) sessionItemRefs.current.set(session.id, el);
          else sessionItemRefs.current.delete(session.id);
        }}
        className={isKeyboardSelected ? "ring-1 ring-inset ring-[var(--accent)]/50 rounded-md" : undefined}
      >
        <SessionTab
          session={displaySession}
          isActive={session.id === activeSessionId}
          usage={displayUsage}
          contentOnly={contentOnlyIds.has(session.id)}
          unread={unreadSessions?.has(session.id) && session.status !== "stopped"}
          parentName={parentNameMap.get(session.id)}
          childCount={childCountMap.get(session.id)}
          terminalBusy={session.sessionType === "terminal" && terminalBusyIds?.has(session.id)}
          terminalCommand={terminalCommands?.get(session.id)}
          onClick={() => onSelectSession(session.id)}
          onRename={(name) => onRenameSession(session.id, name)}
          onDelete={() => onDeleteSession(session.id)}
          onArchive={onArchiveSession ? () => onArchiveSession(session.id) : undefined}
          onUnarchive={onUnarchiveSession ? () => onUnarchiveSession(session.id) : undefined}
          {...extraProps}
        />
      </div>
    );
  };


  return (
    <div className="h-full bg-[var(--bg-secondary)] flex flex-col shrink-0 px-2 pt-3 pb-3 border-r-2 border-[var(--border-color)]">
      {/* Search input — minimal styling */}
      <div className="pb-2">
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]"
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
            onKeyDown={handleSearchKeyDown}
            placeholder="Search sessions..."
            className="sidebar-search w-full bg-transparent border-0 border-b-2 border-[var(--border-color)] pl-8 pr-6 py-2 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-color)] uppercase tracking-wider"
          />
          {contentSearching && (
            <Spinner className="absolute right-1 top-1/2 -translate-y-1/2 w-3 h-3" />
          )}
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-0.5">
        {sortedWorkspaces.length > 0 ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sortedWorkspaces.map((w) => w.id)} strategy={verticalListSortingStrategy}>
              {sortedWorkspaces.map((workspace, wsIdx) => {
                const dirName = workspace.directory.split("/").filter(Boolean).pop() || workspace.directory;
                const isDirCollapsed = collapsedDirs.has(workspace.id);
                const wt = workspace.worktrees[0]; // always exactly 1 worktree per workspace now
                const sessions = wt?.sessions ?? [];

                const color = repoColor(workspace.directory);

                return (
                  <SortableWorkspaceItem key={workspace.id} id={workspace.id}>
                    {(dragListeners) => (
                  <div className={wsIdx > 0 ? "mt-4" : ""}>
                {/* Directory header */}
                <button
                  onClick={() => toggleDir(workspace.id)}
                  className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-[var(--accent-color)]/10 group"
                >
                  <span
                    {...dragListeners}
                    className="shrink-0 cursor-grab active:cursor-grabbing text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                    onClick={(e) => e.stopPropagation()}
                    title="Drag to reorder"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h16M4 16h16" />
                    </svg>
                  </span>
                  <svg
                    className={`w-3 h-3 shrink-0 text-[var(--text-tertiary)] transition-transform duration-150 ${
                      isDirCollapsed ? "" : "rotate-90"
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="w-2 h-2 shrink-0" style={{ background: color }} />
                  <span className="text-[11px] font-bold text-[var(--text-primary)] truncate flex-1 tracking-wider uppercase">
                    {dirName}
                  </span>
                  <span className="text-[11px] text-[var(--text-tertiary)] shrink-0 flex items-center gap-1">
                    {sessions.filter((s) => !s.archived).length}
                  </span>
                </button>

                {/* Important sessions shown even when collapsed */}
                {isDirCollapsed && (() => {
                  const important = sessions
                    .filter((s) => !s.parentSessionId && !s.archived && isImportantSession(s) && (!filterQ || sessionMatchesFilter(s)));
                  return important.map((session) => renderSession(session, { hideDirectory: true }));
                })()}

                {/* Sessions */}
                {!isDirCollapsed && (() => {
                  const MAX_INACTIVE = 3;
                  const isExpanded = expandedDirs.has(workspace.directory);
                  const topLevel = sessions.filter((s) => !s.parentSessionId && !s.archived);
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
                          onClick={() => setExpandedDirs((prev) => {
                            const next = new Set(prev);
                            next.delete(workspace.directory);
                            return next;
                          })}
                          className="pl-5 w-full px-3 py-1.5 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors text-left sticky top-0 z-10 bg-[var(--bg-primary)]"
                        >
                          Show less
                        </button>
                      )}
                      {visible.map((session) => renderSession(session, { hideDirectory: true }))}
                      {hiddenCount > 0 && (
                        <button
                          onClick={() => setExpandedDirs((prev) => {
                            const next = new Set(prev);
                            next.add(workspace.directory);
                            return next;
                          })}
                          className="pl-5 w-full px-3 py-1.5 text-[11px] text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors text-left font-medium"
                        >
                          {hiddenCount > 99 ? "99+" : `+${hiddenCount}`} older sessions
                        </button>
                      )}
                      {isExpanded && topLevel.length > MAX_INACTIVE && !filterQ && (
                        <button
                          onClick={() => setExpandedDirs((prev) => {
                            const next = new Set(prev);
                            next.delete(workspace.directory);
                            return next;
                          })}
                          className="pl-5 w-full px-3 py-1.5 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors text-left"
                        >
                          Show less
                        </button>
                      )}

                      {/* Archived sessions toggle */}
                      {(() => {
                        const archivedSessions = sessions.filter((s) => !s.parentSessionId && s.archived);
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
                              <div key={`archived-${session.id}`} className="opacity-50">
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
                    )}
                  </SortableWorkspaceItem>
                );
              })}
            </SortableContext>
          </DndContext>
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

{appVersion && (
        <div className="pt-1 text-center">
          <span className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-widest font-bold">v{appVersion}</span>
        </div>
      )}
    </div>
  );
}
