import { useState, useMemo, useEffect, useRef, type CSSProperties, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { List } from "react-window";
import type { Session, SessionUsage } from "../types";
import SessionTab from "./SessionTab";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  sessionUsage: Map<string, SessionUsage>;
  todayCost: number;
  todayTokens: number;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onRenameSession: (id: string, name: string) => void;
  onDeleteSession: (id: string) => void;
  onShowUsage?: () => void;
}

const SESSION_HEIGHT = 64;

interface RowExtraProps {
  sessions: Session[];
  activeSessionId: string | null;
  sessionUsage: Map<string, SessionUsage>;
  contentOnlyIds: Set<string>;
  onSelectSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onDeleteSession: (id: string) => void;
}

function VirtualRow({
  index,
  style,
  sessions,
  activeSessionId,
  sessionUsage,
  contentOnlyIds,
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
  const session = sessions[index];
  return (
    <div style={style}>
      <SessionTab
        session={session}
        isActive={session.id === activeSessionId}
        usage={sessionUsage.get(session.id)}
        contentOnly={contentOnlyIds.has(session.id)}
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
  todayTokens,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  onShowUsage,
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

  // Filter sessions by search query (name/directory)
  const filteredSessionIds = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return null; // null means no filter active
    return new Set(
      sessions.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.directory && s.directory.toLowerCase().includes(q))
      ).map((s) => s.id)
    );
  }, [sessions, filter]);

  // Async content search
  const [contentMatchIds, setContentMatchIds] = useState<Set<string>>(new Set());
  const [contentSearching, setContentSearching] = useState(false);
  const contentSearchVersion = useRef(0);

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
        const searchable = sessions
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
      } catch (err) {
        console.error("Content search failed:", err);
        if (contentSearchVersion.current === version) {
          setContentMatchIds(new Set());
          setContentSearching(false);
        }
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [filter, sessions]);

  // Build content-only session IDs (matched by content but not title/directory)
  const contentOnlyIds = useMemo(() => {
    if (!filter.trim()) return new Set<string>();
    return new Set(
      sessions
        .filter(
          (s) =>
            !(filteredSessionIds?.has(s.id)) &&
            s.claudeSessionId &&
            contentMatchIds.has(s.claudeSessionId)
        )
        .map((s) => s.id)
    );
  }, [sessions, filteredSessionIds, contentMatchIds, filter]);

  // Flat filtered session list
  const displayedSessions = useMemo(() => {
    if (!filter.trim()) return sessions;
    const allMatchIds = new Set([...(filteredSessionIds ?? []), ...contentOnlyIds]);
    return sessions.filter((s) => allMatchIds.has(s.id));
  }, [sessions, filteredSessionIds, contentOnlyIds, filter]);

  const rowProps = useMemo<RowExtraProps>(
    () => ({
      sessions: displayedSessions,
      activeSessionId,
      sessionUsage,
      contentOnlyIds,
      onSelectSession,
      onRenameSession,
      onDeleteSession,
    }),
    [displayedSessions, activeSessionId, sessionUsage, contentOnlyIds, onSelectSession, onRenameSession, onDeleteSession]
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
          {contentSearching && (
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-[var(--text-tertiary)] border-t-transparent rounded-full animate-spin" />
          )}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 min-h-0 flex flex-col" ref={listContainerRef}>
        <div className="flex-1 min-h-0">
          {displayedSessions.length > 0 ? (
            <List
              style={{ height: listHeight, width: "100%" }}
              rowComponent={VirtualRow}
              rowCount={displayedSessions.length}
              rowHeight={SESSION_HEIGHT}
              rowProps={rowProps}
              overscanCount={5}
            />
          ) : sessions.length > 0 ? (
            <div className="px-3 py-8 text-center text-xs text-[var(--text-secondary)]">
              {contentSearching ? "Searching content..." : "No matching sessions."}
            </div>
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

      {/* Footer */}
      <div className="px-2 py-3 border-t border-[var(--border-color)] flex items-center gap-2">
        <div className="w-6 h-6 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] flex items-center justify-center text-[10px] text-[var(--text-secondary)] font-medium">
          {sessions.filter((s) => s.status === "running").length}
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
