import { useState, useRef, useEffect, memo, useMemo, useCallback } from "react";
import { showContextMenu } from "./ContextMenu";
import { Spinner } from "./ui/spinner";
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
  terminalBusy?: boolean;
  terminalCommand?: string;
  onClick: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
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
  terminalBusy,
  terminalCommand,
  onClick,
  onRename,
  onDelete,
  onArchive,
  onUnarchive,
}: SessionTabProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items = [
      { label: "Rename", onClick: () => { setEditName(session.name); setIsEditing(true); } },
      null,
      session.archived
        ? { label: "Unarchive", disabled: !onUnarchive, onClick: () => onUnarchive?.() }
        : { label: "Archive",   disabled: !onArchive,   onClick: () => onArchive?.()   },
      { label: "Delete", onClick: onDelete },
    ];
    showContextMenu(e.clientX, e.clientY, items);
  }, [session.name, session.archived, onUnarchive, onArchive, onDelete]);

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
  // usage.isBusy is backend-driven and shared across frontends — trust it regardless of local status
  const isBusy = session.status === "starting" || usage?.isBusy || terminalBusy;
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
    ? "bg-[var(--accent-muted)]" : "";

  return (
    <div
      onClick={onClick}
      onContextMenu={handleContextMenu}
      className={`
        session-tab relative flex items-center gap-2.5 pl-5 pr-2 py-2 cursor-pointer
        mx-1
        ${rowBg}
        ${isActive
          ? "text-[var(--text-primary)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]/60 hover:text-[var(--text-primary)]"
        }
      `}
    >
      {/* Status dot — tiny, only for meaningful states */}
      <span className="shrink-0 w-4 h-4 flex items-center justify-center">
        {hasError ? (
          <span className="w-2 h-2 bg-[var(--danger)]" />
        ) : hasQuestion ? (
          <svg className="w-3.5 h-3.5 text-orange-400" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.5 2a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 3 0v-9A1.5 1.5 0 0 0 4.5 2Zm7 0a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 3 0v-9A1.5 1.5 0 0 0 11.5 2Z" />
          </svg>
        ) : isBusy ? (
          <Spinner className="w-3.5 h-3.5" />
        ) : hasDraft ? (
          <span className="w-2 h-2 bg-blue-400/70" />
        ) : unread ? (
          <span className="w-2 h-2 bg-[var(--accent)]" />
        ) : isActive ? (
          <span className="w-2 h-2 bg-[var(--accent)]/50" />
        ) : (
          <span className="w-2 h-2 bg-[var(--text-tertiary)]/20" />
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
              className="bg-[var(--bg-primary)] border border-[var(--border-color)] px-1.5 py-0.5 text-[11px] w-full outline-none focus:border-[var(--accent)]"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className={`text-[11px] truncate leading-snug ${isActive || unread ? "font-medium" : ""}`}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditName(session.name);
                setIsEditing(true);
              }}
            >
              {session.name}
            </span>
          )}
          {session.sessionType === "terminal" && (
            terminalCommand ? (
              <span className="shrink-0 text-[11px] px-1.5 py-0.5 bg-emerald-500/20 text-emerald-400 font-semibold truncate max-w-[100px]" title={terminalCommand}>
                {terminalCommand}
              </span>
            ) : (
              <svg className="w-3 h-3 shrink-0 text-[var(--text-tertiary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <polyline points="4 17 10 11 4 5" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="12" y1="19" x2="20" y2="19" strokeLinecap="round" />
              </svg>
            )
          )}
          {childCount !== undefined && childCount > 0 && (
            <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] px-1 py-px bg-blue-500/15 text-blue-400 font-medium"
                  title={`${childCount} execution session${childCount !== 1 ? "s" : ""}`}>
              <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0Z" />
              </svg>
              {childCount}
            </span>
          )}
          {contentOnly && (
            <span className="shrink-0 text-[10px] px-1 py-px bg-[var(--accent)]/10 text-[var(--accent)] font-medium">
              match
            </span>
          )}
        </div>

        {/* Parent name — visible when active */}
        {isActive && parentName && (
          <span className="text-[11px] text-[var(--accent)]/60 truncate block mt-0.5">
            from: {parentName}
          </span>
        )}
      </div>

      {/* Time-ago label */}
      {timeLabel && !isEditing && (
        <span className="text-[11px] text-[var(--text-tertiary)] shrink-0">
          {timeLabel}
        </span>
      )}

    </div>
  );
});
