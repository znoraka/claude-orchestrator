import { useState, useRef, useEffect, memo, useMemo } from "react";
import type { Session, SessionUsage } from "../types";

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

export function shortenPath(path: string): string {
  // For worktree paths, show repo/worktree
  const wtIdx = path.indexOf("/.worktrees/");
  if (wtIdx !== -1) {
    const repo = path.slice(0, wtIdx).split("/").filter(Boolean).pop() || "";
    const wt = path.slice(wtIdx + "/.worktrees/".length).split("/")[0];
    return repo && wt ? `${repo}/${wt}` : path.split("/").filter(Boolean).pop() || path;
  }
  const clIdx = path.indexOf("/.claude/worktrees/");
  if (clIdx !== -1) {
    const repo = path.slice(0, clIdx).split("/").filter(Boolean).pop() || "";
    const wt = path.slice(clIdx + "/.claude/worktrees/".length).split("/")[0];
    return repo && wt ? `${repo}/${wt}` : path.split("/").filter(Boolean).pop() || path;
  }
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** Strip worktree suffixes so worktrees share the parent repo's color. */
function repoRoot(dir: string): string {
  const wtIdx = dir.indexOf("/.worktrees/");
  if (wtIdx !== -1) return dir.slice(0, wtIdx);
  const clIdx = dir.indexOf("/.claude/worktrees/");
  if (clIdx !== -1) return dir.slice(0, clIdx);
  return dir;
}

/** Color for the repo root (shared across worktrees). */
export function repoColor(dir: string): string {
  const base = repoRoot(dir);
  return hashToColor(base);
}

/** Color that distinguishes worktrees within the same repo. */
export function directoryColor(dir: string): string {
  return hashToColor(dir);
}

function hashToColor(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = s.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

export interface SessionTabProps {
  session: Session;
  isActive: boolean;
  usage?: SessionUsage;
  contentOnly?: boolean;
  unread?: boolean;
  hideDirectory?: boolean;
  parentName?: string;
  childCount?: number;
  onClick: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}

export default memo(function SessionTab({
  session,
  isActive,
  usage,
  contentOnly,
  unread,
  hideDirectory: _hideDirectory,
  parentName,
  childCount,
  onClick,
  onRename,
  onDelete,
}: SessionTabProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSubmitRename = () => {
    const trimmed = editName.trim();
    if (trimmed) onRename(trimmed);
    setIsEditing(false);
  };

  const isRunning = session.status === "running" || session.status === "starting";
  const isBusy = usage?.isBusy && isRunning;
  const hasQuestion = session.hasQuestion && isRunning;
  const hasError = session.status === "stopped" && session.exitCode !== undefined && session.exitCode !== 0;
  const hasDraft = session.hasDraft && isRunning;

  const timeLabel = useMemo(() => {
    const ts = session.lastMessageAt || session.lastActiveAt || session.createdAt;
    if (!ts) return null;
    return timeAgo(ts);
  }, [session.lastMessageAt, session.lastActiveAt, session.createdAt]);

  // Row-level background tints
  const rowBg = isActive
    ? "bg-[var(--accent-muted)]"
    : hasQuestion
    ? "bg-amber-500/8"
    : hasError
    ? "bg-red-500/5"
    : "";

  return (
    <div
      onClick={onClick}
      className={`
        session-tab group relative flex items-center gap-2 pl-4 pr-1.5 py-1.5 cursor-pointer
        rounded-lg mx-0.5
        ${rowBg}
        ${isActive
          ? "text-[var(--text-primary)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]/60 hover:text-[var(--text-primary)]"
        }
      `}
    >
      {/* Status dot — tiny, only for meaningful states */}
      <span className="shrink-0 w-3 h-3 flex items-center justify-center">
        {hasError ? (
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--danger)]" />
        ) : hasQuestion ? (
          <svg className="w-3 h-3 text-orange-400" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.5 2a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 3 0v-9A1.5 1.5 0 0 0 4.5 2Zm7 0a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 3 0v-9A1.5 1.5 0 0 0 11.5 2Z" />
          </svg>
        ) : isBusy ? (
          <span className="w-1.5 h-1.5 border border-[var(--accent)] border-t-transparent rounded-full animate-spin" style={{ width: 6, height: 6 }} />
        ) : hasDraft ? (
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400/70" />
        ) : unread ? (
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
        ) : isActive ? (
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]/50" />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-tertiary)]/20" />
        )}
      </span>

      {/* Name + details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 min-w-0">
          {isEditing ? (
            <input
              ref={inputRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleSubmitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmitRename();
                if (e.key === "Escape") setIsEditing(false);
              }}
              className="bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-1.5 py-0.5 text-xs w-full outline-none focus:border-[var(--accent)]"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className={`text-xs truncate leading-snug ${isActive || unread ? "font-medium" : ""}`}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditName(session.name);
                setIsEditing(true);
              }}
            >
              {session.name}
            </span>
          )}
          {childCount !== undefined && childCount > 0 && (
            <span className="shrink-0 inline-flex items-center gap-0.5 text-[9px] px-1 py-px rounded bg-blue-500/15 text-blue-400 font-medium"
                  title={`${childCount} execution session${childCount !== 1 ? "s" : ""}`}>
              <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0Z" />
              </svg>
              {childCount}
            </span>
          )}
          {contentOnly && (
            <span className="shrink-0 text-[9px] px-1 py-px rounded bg-[var(--accent)]/10 text-[var(--accent)] font-medium">
              match
            </span>
          )}
        </div>

        {/* Parent name — visible when active */}
        {isActive && parentName && (
          <span className="text-[10px] text-[var(--accent)]/60 truncate block mt-0.5">
            from: {parentName}
          </span>
        )}
      </div>

      {/* Time-ago label + delete button */}
      {timeLabel && !isEditing && (
        <span className="text-[10px] text-[var(--text-tertiary)] shrink-0 group-hover:opacity-0 transition-opacity">
          {timeLabel}
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute right-1.5 opacity-0 group-hover:opacity-100 text-[var(--text-secondary)] hover:text-[var(--danger)] hover:bg-red-500/10 rounded-md p-0.5 transition-all duration-150 text-xs shrink-0"
        title="Delete session"
      >
        ✕
      </button>
    </div>
  );
});
