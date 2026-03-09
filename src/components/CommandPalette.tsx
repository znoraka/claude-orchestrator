import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Session, SessionUsage, Workspace } from "../types";
import { shortenPath, repoColor, directoryColor } from "./SessionTab";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: Session[];
  workspaces: Workspace[];
  sessionUsage: Map<string, SessionUsage>;
  activeSessionId: string | null;
  youngestDescendantMap?: Map<string, Session>;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onToggleSidebar: () => void;
  onOpenUsage: () => void;
  onOpenPRs: () => void;
  onOpenShell: () => void;
  unreadSessions?: Set<string>;
}

interface ResultItem {
  type: "session" | "command";
  id: string;
  label: string;
  section: string; // date group label or "commands"
  session?: Session;
  usage?: SessionUsage;
  action?: () => void;
  // SessionTab-style data
  parentName?: string;
  childCount?: number;
  unread?: boolean;
}

const DATE_GROUP_ORDER = ["Today", "Yesterday", "This Week", "This Month", "Older"];

function dateGroup(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - 86400000) return "Yesterday";
  const dayOfWeek = now.getDay() || 7;
  if (ts >= startOfToday - (dayOfWeek - 1) * 86400000) return "This Week";
  if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) return "This Month";
  return "Older";
}

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

export default function CommandPalette({
  isOpen,
  onClose,
  sessions,
  workspaces: _workspaces,
  sessionUsage,
  activeSessionId,
  youngestDescendantMap,
  onSelectSession,
  onCreateSession,
  onToggleSidebar,
  onOpenUsage,
  onOpenPRs,
  onOpenShell,
  unreadSessions,
}: CommandPaletteProps) {
  void _workspaces;
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(1); // default to 2nd item for quick toggle between last two sessions
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Parent/child maps (same as Sidebar)
  const { parentNameMap, childCountMap } = useMemo(() => {
    const nameMap = new Map<string, string>();
    for (const s of sessions) nameMap.set(s.id, s.name);
    const pMap = new Map<string, string>();
    const cMap = new Map<string, number>();
    for (const s of sessions) {
      if (s.parentSessionId) {
        pMap.set(s.id, nameMap.get(s.parentSessionId) || "Unknown");
        cMap.set(s.parentSessionId, (cMap.get(s.parentSessionId) || 0) + 1);
      }
    }
    return { parentNameMap: pMap, childCountMap: cMap };
  }, [sessions]);

  const commands: ResultItem[] = useMemo(
    () => [
      { type: "command", id: "cmd-new", label: "New Session", section: "commands", action: onCreateSession },
      { type: "command", id: "cmd-sidebar", label: "Toggle Sidebar", section: "commands", action: onToggleSidebar },
      { type: "command", id: "cmd-prs", label: "Open PRs", section: "commands", action: onOpenPRs },
      { type: "command", id: "cmd-shell", label: "Open Shell", section: "commands", action: onOpenShell },
      { type: "command", id: "cmd-usage", label: "Usage Stats", section: "commands", action: onOpenUsage },
    ],
    [onCreateSession, onToggleSidebar, onOpenPRs, onOpenShell, onOpenUsage],
  );

  const results: ResultItem[] = useMemo(() => {
    const raw = query.trim();
    const isCommandMode = raw.startsWith(">");
    const isStatusMode = raw.startsWith("#");
    const search = raw.replace(/^[>#]\s*/, "");

    // Command-only mode
    if (isCommandMode) {
      if (!search) return commands;
      return commands.filter((c) => fuzzyMatch(search, c.label));
    }

    // Filter out child sessions (like sidebar's by-date tab)
    let filtered = sessions.filter((s) => !s.parentSessionId || s.id === activeSessionId);

    if (isStatusMode && search) {
      const statusMap: Record<string, (s: Session) => boolean> = {
        running: (s) => s.status === "running",
        question: (s) => !!s.hasQuestion,
        error: (s) => !!(s.exitCode && s.exitCode !== 0),
        draft: (s) => !!s.hasDraft,
        stopped: (s) => s.status === "stopped",
      };
      const matchedStatus = Object.keys(statusMap).find((k) => fuzzyMatch(search, k));
      if (matchedStatus) {
        filtered = filtered.filter(statusMap[matchedStatus]);
      }
    } else if (search) {
      filtered = filtered.filter(
        (s) => fuzzyMatch(search, s.name) || fuzzyMatch(search, s.directory),
      );
      filtered.sort((a, b) => {
        const aName = fuzzyMatch(search, a.name);
        const bName = fuzzyMatch(search, b.name);
        if (aName && !bName) return -1;
        if (!aName && bName) return 1;
        return b.lastActiveAt - a.lastActiveAt;
      });
    }

    // Group by date (like sidebar)
    const groups = new Map<string, Session[]>();
    for (const s of filtered) {
      const g = dateGroup(s.lastActiveAt);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(s);
    }
    for (const arr of groups.values()) arr.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    const items: ResultItem[] = [];
    const orderedGroups = search
      ? [{ label: "Results", sessions: filtered }]
      : DATE_GROUP_ORDER.filter((g) => groups.has(g)).map((g) => ({ label: g, sessions: groups.get(g)! }));

    for (const group of orderedGroups) {
      for (const s of group.sessions) {
        // For sessions with children, show youngest descendant's status
        const youngest = youngestDescendantMap?.get(s.id);
        const displaySession = youngest
          ? { ...s, hasQuestion: youngest.hasQuestion, hasDraft: youngest.hasDraft, status: youngest.status }
          : s;
        const displayUsage = youngest ? sessionUsage.get(youngest.id) : sessionUsage.get(s.id);

        items.push({
          type: "session",
          id: s.id,
          label: s.name,
          section: group.label,
          session: displaySession,
          usage: displayUsage,
          parentName: parentNameMap.get(s.id),
          childCount: childCountMap.get(s.id),
          unread: unreadSessions?.has(s.id),
        });
      }
    }

    // Append commands
    if (!isStatusMode) {
      const matchedCmds = search
        ? commands.filter((c) => fuzzyMatch(search, c.label))
        : commands;
      items.push(...matchedCmds.map((c) => ({ ...c, section: "Commands" })));
    }

    return items;
  }, [query, sessions, commands, activeSessionId, sessionUsage, youngestDescendantMap, parentNameMap, childCountMap, unreadSessions]);

  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const executeItem = useCallback(
    (item: ResultItem) => {
      if (item.type === "command" && item.action) {
        item.action();
      } else if (item.session) {
        onSelectSession(item.session.id);
      }
      onClose();
    },
    [onSelectSession, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.ctrlKey && e.key === "n") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
        return;
      }
      if (e.ctrlKey && e.key === "p") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (results[selectedIndex]) {
            executeItem(results[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [results, selectedIndex, executeItem, onClose],
  );

  if (!isOpen) return null;

  // Group results by section for rendering
  const sections: { key: string; label: string; items: { item: ResultItem; globalIndex: number }[] }[] = [];
  const seenSections: string[] = [];
  for (const item of results) {
    if (!seenSections.includes(item.section)) seenSections.push(item.section);
  }
  for (const sKey of seenSections) {
    const sectionItems: { item: ResultItem; globalIndex: number }[] = [];
    results.forEach((item, idx) => {
      if (item.section === sKey) sectionItems.push({ item, globalIndex: idx });
    });
    if (sectionItems.length > 0) {
      sections.push({ key: sKey, label: sKey.toUpperCase(), items: sectionItems });
    }
  }

  return (
    <div
      className="command-palette-backdrop fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="command-palette animate-slide-down flex flex-col rounded-xl shadow-2xl"
        style={{ width: 520, maxHeight: 480 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.4, flexShrink: 0 }}>
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Search sessions, commands..."
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ fontSize: 14, color: "var(--text-primary)" }}
          />
          {query && (
            <button
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="text-xs opacity-40 hover:opacity-70"
              style={{ color: "var(--text-secondary)" }}
            >
              Clear
            </button>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1" style={{ maxHeight: 420 }}>
          {sections.length === 0 && (
            <div className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>
              No results found
            </div>
          )}

          {sections.map((section) => (
            <div key={section.key} className="mb-1">
              <div
                className="px-4 py-1 text-[10px] font-semibold tracking-widest"
                style={{ color: "var(--text-tertiary)" }}
              >
                {section.label}
              </div>

              {section.items.map(({ item, globalIndex: gi }) => {
                const isSelected = gi === selectedIndex;

                if (item.type === "command") {
                  return (
                    <div
                      key={item.id}
                      data-index={gi}
                      onClick={() => executeItem(item)}
                      className="mx-2 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition-colors"
                      style={{
                        background: isSelected ? "var(--accent-muted)" : "transparent",
                        borderLeft: isSelected ? "2px solid var(--accent)" : "2px solid transparent",
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.5, flexShrink: 0 }}>
                        <path d="M2 4L7 8L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M7 12H12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                      <span className="text-xs" style={{ color: "var(--text-primary)" }}>
                        {item.label}
                      </span>
                    </div>
                  );
                }

                // Session item — matches SessionTab rendering
                const session = item.session!;
                const usage = item.usage;
                const isRunning = session.status === "running" || session.status === "starting";
                const isBusy = usage?.isBusy && isRunning;
                const hasQuestion = session.hasQuestion && isRunning;
                const hasError = session.status === "stopped" && session.exitCode !== undefined && session.exitCode !== 0;
                const hasDraft = session.hasDraft && isRunning;
                const unread = item.unread;

                const rowBg = hasQuestion
                  ? "bg-orange-500/12 animate-pulse-glow"
                  : hasError
                  ? "bg-red-500/5"
                  : "";

                return (
                  <div
                    key={item.id}
                    data-index={gi}
                    onClick={() => executeItem(item)}
                    className={`mx-1 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 my-px transition-colors ${rowBg}`}
                    style={{
                      background: isSelected ? "var(--accent-muted)" : undefined,
                      borderLeft: isSelected ? "2px solid var(--accent)" : "2px solid transparent",
                    }}
                  >
                    {/* Status indicator — same as SessionTab */}
                    <span className="shrink-0 w-3 h-3 flex items-center justify-center">
                      {hasError ? (
                        <svg className="w-3 h-3 text-red-400" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575ZM8 5a.75.75 0 0 0-.75.75v2.5a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 8 5Zm1 6a1 1 0 1 0-2 0 1 1 0 0 0 2 0Z" />
                        </svg>
                      ) : hasQuestion ? (
                        <svg className="w-3 h-3 text-orange-400" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M4.5 2a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 3 0v-9A1.5 1.5 0 0 0 4.5 2Zm7 0a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 3 0v-9A1.5 1.5 0 0 0 11.5 2Z" />
                        </svg>
                      ) : isBusy ? (
                        <span className="w-2.5 h-2.5 border-[1.5px] border-[var(--accent)] border-t-transparent rounded-full animate-spin drop-shadow-[0_0_4px_rgba(240,120,48,0.4)]" />
                      ) : hasDraft ? (
                        <svg className="w-2.5 h-2.5 text-blue-400" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.249.249 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z" />
                        </svg>
                      ) : unread ? (
                        <span className="w-2 h-2 rounded-full bg-[var(--accent)]" />
                      ) : null}
                    </span>

                    {/* Name + directory + usage — same as SessionTab */}
                    <div className="flex-1 min-w-0">
                      <span className="text-xs truncate flex items-center gap-1.5 leading-snug">
                        {item.childCount !== undefined && item.childCount > 0 && (
                          <span className="inline-flex items-center gap-0.5 shrink-0 text-[9px] px-1 py-px rounded bg-blue-500/15 text-blue-400 font-medium align-middle" title={`${item.childCount} execution session${item.childCount !== 1 ? "s" : ""}`}>
                            <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor"><path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0Z" /></svg>
                            {item.childCount}
                          </span>
                        )}
                        {session.name}
                        {session.provider && session.provider !== "claude-code" && (
                          <span className="ml-1.5 text-[9px] px-1 py-px rounded bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] uppercase tracking-wider font-semibold align-middle">
                            {session.provider === "opencode" ? "OC" : session.provider}
                          </span>
                        )}
                      </span>
                      {item.parentName && (
                        <span className="text-[10px] text-violet-400/70 truncate block mt-0.5">
                          from: {item.parentName}
                        </span>
                      )}
                      {session.directory && (() => {
                        const isWorktree = session.directory.includes("/.worktrees/") || session.directory.includes("/.claude/worktrees/");
                        if (isWorktree) {
                          const short = shortenPath(session.directory);
                          const slashIdx = short.indexOf("/");
                          const repo = short.slice(0, slashIdx);
                          const wt = short.slice(slashIdx);
                          return (
                            <span className="text-[10px] truncate block mt-0.5">
                              <span style={{ color: repoColor(session.directory) }}>{repo}</span>
                              <span style={{ color: directoryColor(session.directory) }}>{wt}</span>
                            </span>
                          );
                        }
                        return (
                          <span
                            className="text-[10px] truncate block mt-0.5"
                            style={{ color: repoColor(session.directory) }}
                          >
                            {shortenPath(session.directory)}
                          </span>
                        );
                      })()}
                      {usage && (usage.inputTokens > 0 || usage.outputTokens > 0) && (
                        <span className="text-[10px] text-[var(--text-tertiary)] truncate block mt-0.5">
                          {formatTokens(usage.inputTokens + usage.outputTokens)} tokens · ${usage.costUsd.toFixed(2)}
                          {session.activeTime ? ` · ${formatDuration(session.activeTime)}` : ""}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer hints */}
        <div
          className="flex items-center gap-4 px-4 py-2 text-[10px]"
          style={{ borderTop: "1px solid var(--border-subtle)", color: "var(--text-tertiary)" }}
        >
          <span>
            <kbd className="rounded px-1 py-0.5" style={{ background: "rgba(255,255,255,0.06)" }}>↑↓</kbd>{" "}
            <kbd className="rounded px-1 py-0.5" style={{ background: "rgba(255,255,255,0.06)" }}>^P/^N</kbd> navigate
          </span>
          <span>
            <kbd className="rounded px-1 py-0.5" style={{ background: "rgba(255,255,255,0.06)" }}>↵</kbd> select
          </span>
          <span>
            <kbd className="rounded px-1 py-0.5" style={{ background: "rgba(255,255,255,0.06)" }}>esc</kbd> close
          </span>
          <span className="ml-auto opacity-60">
            <span className="mr-2">&gt; commands</span>
            <span># status</span>
          </span>
        </div>
      </div>
    </div>
  );
}
