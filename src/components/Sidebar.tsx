import { useState, useMemo, useEffect, useRef, useCallback, type CSSProperties, type ReactElement } from "react";
import { List } from "react-window";
import type { Session, SessionUsage } from "../types";
import SessionTab from "./SessionTab";

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  sessionUsage: Map<string, SessionUsage>;
  todayCost: number;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onRenameSession: (id: string, name: string) => void;
  onDeleteSession: (id: string) => void;
}

interface SessionGroup {
  label: string;
  sessions: Session[];
}

type FlatItem =
  | { type: "header"; label: string }
  | { type: "session"; session: Session };

const HEADER_HEIGHT = 32;
const SESSION_HEIGHT = 64;

function groupSessionsByTime(sessions: Session[]): SessionGroup[] {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  const groups: Record<string, Session[]> = {
    Today: [],
    Yesterday: [],
    "Last 7 Days": [],
    Older: [],
  };

  for (const s of sessions) {
    const t = s.lastActiveAt;
    if (t >= todayStart.getTime()) {
      groups.Today.push(s);
    } else if (t >= yesterdayStart.getTime()) {
      groups.Yesterday.push(s);
    } else if (t >= weekStart.getTime()) {
      groups["Last 7 Days"].push(s);
    } else {
      groups.Older.push(s);
    }
  }

  return Object.entries(groups)
    .filter(([, arr]) => arr.length > 0)
    .map(([label, arr]) => ({ label, sessions: arr }));
}

interface RowExtraProps {
  flatItems: FlatItem[];
  activeSessionId: string | null;
  sessionUsage: Map<string, SessionUsage>;
  onSelectSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onDeleteSession: (id: string) => void;
}

function VirtualRow({
  index,
  style,
  flatItems,
  activeSessionId,
  sessionUsage,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
}: RowExtraProps & {
  index: number;
  style: CSSProperties;
  ariaAttributes: {
    "aria-posinset": number;
    "aria-setsize": number;
    role: "listitem";
  };
}): ReactElement | null {
  const item = flatItems[index];
  if (item.type === "header") {
    return (
      <div style={style} className="px-2 pt-3 pb-1 flex items-end">
        <span className="text-[11px] font-semibold text-[var(--section-label)] uppercase tracking-wider">
          {item.label}
        </span>
      </div>
    );
  }
  const { session } = item;
  return (
    <div style={style}>
      <SessionTab
        session={session}
        isActive={session.id === activeSessionId}
        usage={sessionUsage.get(session.id)}
        onClick={() => onSelectSession(session.id)}
        onRename={(name) => onRenameSession(session.id, name)}
        onDelete={() => onDeleteSession(session.id)}
      />
    </div>
  );
}

export default function Sidebar({
  sessions,
  activeSessionId,
  sessionUsage,
  todayCost,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
}: SidebarProps) {
  const [filter, setFilter] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(400);

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

  // Measure available height for the virtual list
  useEffect(() => {
    if (!listContainerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setListHeight(entry.contentRect.height);
      }
    });
    observer.observe(listContainerRef.current);
    return () => observer.disconnect();
  }, []);

  const filteredSessions = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.directory && s.directory.toLowerCase().includes(q))
    );
  }, [sessions, filter]);

  const groupedSessions = useMemo(
    () => groupSessionsByTime(filteredSessions),
    [filteredSessions]
  );

  // Flatten groups into a single list of items for virtualization
  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = [];
    for (const group of groupedSessions) {
      items.push({ type: "header", label: group.label });
      for (const session of group.sessions) {
        items.push({ type: "session", session });
      }
    }
    return items;
  }, [groupedSessions]);

  const getItemSize = useCallback(
    (index: number) => {
      return flatItems[index].type === "header" ? HEADER_HEIGHT : SESSION_HEIGHT;
    },
    [flatItems]
  );

  const rowProps = useMemo<RowExtraProps>(
    () => ({
      flatItems,
      activeSessionId,
      sessionUsage,
      onSelectSession,
      onRenameSession,
      onDeleteSession,
    }),
    [flatItems, activeSessionId, sessionUsage, onSelectSession, onRenameSession, onDeleteSession]
  );

  return (
    <div className="w-64 h-full bg-[var(--bg-secondary)] flex flex-col shrink-0 px-2 pt-4 pb-3">
      {/* Header with branding */}
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
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 min-h-0" ref={listContainerRef}>
        {flatItems.length > 0 ? (
          <List
            style={{ height: listHeight, width: "100%" }}
            rowComponent={VirtualRow}
            rowCount={flatItems.length}
            rowHeight={getItemSize}
            rowProps={rowProps}
            overscanCount={5}
          />
        ) : filteredSessions.length === 0 && sessions.length > 0 ? (
          <div className="px-3 py-8 text-center text-xs text-[var(--text-secondary)]">
            No matching sessions.
          </div>
        ) : sessions.length === 0 ? (
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
        ) : null}
      </div>

      {/* Footer */}
      <div className="px-2 py-3 border-t border-[var(--border-color)] flex items-center gap-2">
        <div className="w-6 h-6 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] flex items-center justify-center text-[10px] text-[var(--text-secondary)] font-medium">
          {sessions.filter((s) => s.status === "running").length}
        </div>
        <span className="text-[11px] text-[var(--text-secondary)]">
          active sessions
        </span>
        {todayCost > 0 && (
          <span className="text-[11px] text-[var(--text-secondary)] ml-auto">
            ${todayCost.toFixed(2)} today
          </span>
        )}
      </div>
    </div>
  );
}
