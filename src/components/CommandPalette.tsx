import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Session, SessionUsage, Workspace } from "../types";
import { shortenPath, repoColor, directoryColor } from "./SessionTab";
import { useSessionLive } from "../contexts/SessionContext";

interface CommandPaletteProps {
  onClose: () => void;
  sessions: Session[];
  workspaces: Workspace[];
  activeSessionId: string | null;
  youngestDescendantMap?: Map<string, Session>;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onToggleSidebar: () => void;
  onOpenUsage: () => void;
  onOpenPRs: () => void;
  onOpenShell: () => void;
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

type VRow =
  | { kind: "header"; label: string }
  | { kind: "item"; item: ResultItem; globalIndex: number };

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

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Command icons (18×18, strokeWidth 1.75)
const CommandIcon = ({ id }: { id: string }) => {
  if (id === "cmd-new") {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 3.75v10.5M3.75 9h10.5" />
      </svg>
    );
  }
  if (id === "cmd-sidebar") {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.25" y="2.25" width="13.5" height="13.5" rx="2" />
        <path d="M6.75 2.25v13.5" />
      </svg>
    );
  }
  if (id === "cmd-prs") {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="4.5" cy="4.5" r="1.75" />
        <circle cx="4.5" cy="13.5" r="1.75" />
        <circle cx="13.5" cy="4.5" r="1.75" />
        <path d="M4.5 6.25v5.5" />
        <path d="M13.5 6.25c0 3-4.5 4.5-4.5 7.25" />
      </svg>
    );
  }
  if (id === "cmd-shell") {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.25" y="3" width="13.5" height="12" rx="2" />
        <path d="M5.25 7.5l2.25 2.25-2.25 2.25" />
        <path d="M9.75 12h3" />
      </svg>
    );
  }
  if (id === "cmd-usage") {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="10.5" width="2.5" height="4.5" rx="0.5" />
        <rect x="7.75" y="6.75" width="2.5" height="8.25" rx="0.5" />
        <rect x="12.5" y="3" width="2.5" height="12" rx="0.5" />
      </svg>
    );
  }
  return null;
};

export default function CommandPalette({
  onClose,
  sessions,
  workspaces: _workspaces,
  activeSessionId: _activeSessionId,
  youngestDescendantMap,
  onSelectSession,
  onCreateSession,
  onToggleSidebar,
  onOpenUsage,
  onOpenPRs,
  onOpenShell,
}: CommandPaletteProps) {
  void _workspaces;
  const { sessionUsage, unreadSessions } = useSessionLive();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Focus input on mount
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

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
    let filtered = sessions.filter((s) => !s.parentSessionId);

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
  }, [query, sessions, commands, sessionUsage, youngestDescendantMap, parentNameMap, childCountMap, unreadSessions]);

  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  // Build flat rows array: section headers + items (for virtualizer)
  const rows: VRow[] = useMemo(() => {
    const map = new Map<string, { item: ResultItem; globalIndex: number }[]>();
    const order: string[] = [];
    results.forEach((item, idx) => {
      if (!map.has(item.section)) { map.set(item.section, []); order.push(item.section); }
      map.get(item.section)!.push({ item, globalIndex: idx });
    });

    const flat: VRow[] = [];
    for (const key of order) {
      flat.push({ kind: "header", label: key.toUpperCase() });
      for (const entry of map.get(key)!) {
        flat.push({ kind: "item", item: entry.item, globalIndex: entry.globalIndex });
      }
    }
    return flat;
  }, [results]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => {
      const r = rows[i];
      if (r.kind === "header") return 32;
      if (r.kind === "item" && r.item.type === "command") return 44;
      return 72; // session item — measured dynamically
    },
    overscan: 5,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Scroll selected item into view
  useEffect(() => {
    // Find the row index for the selected globalIndex
    const rowIdx = rows.findIndex((r) => r.kind === "item" && r.globalIndex === selectedIndex);
    if (rowIdx >= 0) virtualizer.scrollToIndex(rowIdx, { align: "auto" });
  }, [selectedIndex, rows, virtualizer]);

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

  const renderRow = (row: VRow) => {
    if (row.kind === "header") {
      return (
        <div
          className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wider"
          style={{ color: "var(--section-label)" }}
        >
          {row.label}
        </div>
      );
    }

    const { item, globalIndex: gi } = row;
    const isSelected = gi === selectedIndex;

    if (item.type === "command") {
      return (
        <div
          data-index={gi}
          onClick={() => executeItem(item)}
          className="mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2.5 transition-colors relative overflow-hidden"
          style={{
            background: isSelected ? "var(--accent-glow)" : "transparent",
          }}
        >
          {isSelected && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-r" style={{ background: "var(--accent)" }} />
          )}
          <span
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors"
            style={{
              background: isSelected ? "var(--accent-muted)" : "var(--bg-tertiary)",
              color: isSelected ? "var(--accent)" : "var(--text-secondary)",
            }}
          >
            <CommandIcon id={item.id} />
          </span>
          <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {item.label}
          </span>
        </div>
      );
    }

    // Session item
    const session = item.session!;
    const usage = item.usage;
    const isRunning = session.status === "running" || session.status === "starting";
    const isBusy = session.status === "starting" || (usage?.isBusy && isRunning);
    const hasQuestion = session.hasQuestion && isRunning;
    const hasError = session.status === "stopped" && session.exitCode !== undefined && session.exitCode !== 0;
    const hasDraft = session.hasDraft && isRunning;
    const unread = item.unread;

    let statusDesc: string | null = null;
    if (hasQuestion) statusDesc = "Needs input";
    else if (isBusy) statusDesc = "Working…";
    else if (hasDraft) statusDesc = "Has draft";
    else if (hasError) statusDesc = "Error";
    else if (!isRunning) statusDesc = timeAgo(session.lastActiveAt);

    const rowBg = hasQuestion
      ? "bg-orange-500/10 animate-pulse-glow"
      : hasError
      ? "bg-red-500/5"
      : "";

    return (
      <div
        data-index={gi}
        onClick={() => executeItem(item)}
        className={`mx-2 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 my-px transition-colors relative overflow-hidden ${rowBg}`}
        style={{
          background: isSelected && !hasQuestion ? "var(--accent-glow)" : undefined,
        }}
      >
        {isSelected && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-r" style={{ background: "var(--accent)" }} />
        )}

        <span className="shrink-0 w-3.5 h-3.5 flex items-center justify-center">
          {hasError ? (
            <span className="w-2 h-2 rounded-full bg-[var(--danger)]" />
          ) : hasQuestion ? (
            <svg className="w-3 h-3 text-orange-400" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.5 2a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 3 0v-9A1.5 1.5 0 0 0 4.5 2Zm7 0a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 3 0v-9A1.5 1.5 0 0 0 11.5 2Z" />
            </svg>
          ) : isBusy ? (
            <span className="rounded-full border border-[var(--accent)] border-t-transparent animate-spin" style={{ width: 8, height: 8 }} />
          ) : hasDraft ? (
            <span className="w-2 h-2 rounded-full bg-blue-400/70" />
          ) : unread ? (
            <span className="w-2 h-2 rounded-full bg-[var(--accent)]" />
          ) : isRunning ? (
            <span className="w-2 h-2 rounded-full bg-[var(--accent)]/50" />
          ) : (
            <span className="w-2 h-2 rounded-full bg-[var(--text-tertiary)]/20" />
          )}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 leading-snug">
            {item.childCount !== undefined && item.childCount > 0 && (
              <span
                className="inline-flex items-center gap-0.5 shrink-0 text-[9px] px-1 py-px rounded font-medium"
                style={{ background: "rgba(96,165,250,0.15)", color: "rgb(147,197,253)" }}
                title={`${item.childCount} execution session${item.childCount !== 1 ? "s" : ""}`}
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0Z" />
                </svg>
                {item.childCount}
              </span>
            )}
            <span className="text-sm font-medium truncate" style={{ color: "var(--text-primary)" }}>
              {session.name}
            </span>
            {session.provider && (
              <span
                className="ml-1 text-[9px] px-1 py-px rounded uppercase tracking-wider font-semibold shrink-0"
                style={{ background: "var(--bg-tertiary)", color: "var(--text-tertiary)" }}
              >
                {session.provider === "opencode" ? "OC" : session.provider === "claude-code" ? "CC" : session.provider === "codex" ? "CX" : session.provider}
              </span>
            )}
          </div>

          {statusDesc && (
            <span
              className="text-[11px] truncate block mt-0.5"
              style={{
                color: hasQuestion
                  ? "var(--status-waiting)"
                  : hasError
                  ? "var(--danger)"
                  : isBusy
                  ? "var(--status-running)"
                  : "var(--text-tertiary)",
              }}
            >
              {statusDesc}
            </span>
          )}

          {item.parentName && (
            <span className="text-[10px] truncate block mt-0.5" style={{ color: "rgba(167,139,250,0.7)" }}>
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
            <span className="text-[10px] truncate block mt-0.5" style={{ color: "var(--text-tertiary)" }}>
              {formatTokens(usage.inputTokens + usage.outputTokens)} tokens · ${usage.costUsd.toFixed(2)}
              {session.activeTime ? ` · ${formatDuration(session.activeTime)}` : ""}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      className="command-palette-backdrop fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div
        className="command-palette animate-slide-down flex flex-col rounded-xl shadow-2xl"
        style={{ width: 580, maxHeight: 560 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3.5" style={{ borderBottom: "1px solid var(--card-border)" }}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ opacity: 0.4, flexShrink: 0 }}>
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.75" />
            <path d="M13 13L16 16" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
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
            className="flex-1 bg-transparent outline-none"
            style={{ fontSize: 15, color: "var(--text-primary)" }}
          />
          {query && (
            <button
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="text-xs opacity-40 hover:opacity-70 transition-opacity"
              style={{ color: "var(--text-secondary)" }}
            >
              Clear
            </button>
          )}
        </div>

        {/* Results — virtualised */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1.5" style={{ maxHeight: 460 }}>
          {rows.length === 0 && (
            <div className="px-4 py-10 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>
              No results found
            </div>
          )}

          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vItem) => (
              <div
                key={vItem.key}
                ref={virtualizer.measureElement}
                data-index={vItem.index}
                style={{ position: "absolute", top: vItem.start, width: "100%" }}
              >
                {renderRow(rows[vItem.index])}
              </div>
            ))}
          </div>
        </div>

        {/* Footer hints */}
        <div
          className="flex items-center gap-4 px-4 py-2.5 text-[11px]"
          style={{ borderTop: "1px solid var(--card-border)", color: "var(--text-tertiary)" }}
        >
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded-md font-mono text-[10px] border" style={{ background: "var(--bg-tertiary)", borderColor: "var(--border-subtle)" }}>↑↓</kbd>
            <span>navigate</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded-md font-mono text-[10px] border" style={{ background: "var(--bg-tertiary)", borderColor: "var(--border-subtle)" }}>↵</kbd>
            <span>select</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded-md font-mono text-[10px] border" style={{ background: "var(--bg-tertiary)", borderColor: "var(--border-subtle)" }}>esc</kbd>
            <span>close</span>
          </span>
          <span className="ml-auto flex items-center gap-2 opacity-60">
            <span>
              <kbd className="px-1 py-0.5 rounded font-mono text-[10px] border" style={{ background: "var(--bg-tertiary)", borderColor: "var(--border-subtle)" }}>&gt;</kbd>
              {" "}commands
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded font-mono text-[10px] border" style={{ background: "var(--bg-tertiary)", borderColor: "var(--border-subtle)"}}>#</kbd>
              {" "}status
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
