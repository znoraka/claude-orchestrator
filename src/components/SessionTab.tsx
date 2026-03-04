import { useState, useRef, useEffect, memo } from "react";
import type { Session, SessionUsage } from "../types";

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

export interface SessionTabProps {
  session: Session;
  isActive: boolean;
  usage?: SessionUsage;
  contentOnly?: boolean;
  hideDirectory?: boolean;
  onClick: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}

export default memo(function SessionTab({
  session,
  isActive,
  usage,
  contentOnly,
  hideDirectory,
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
    if (trimmed) {
      onRename(trimmed);
    }
    setIsEditing(false);
  };

  const statusColor = {
    running: "bg-green-500",
    stopped: "bg-red-500",
    starting: "bg-yellow-500 animate-pulse",
  }[session.status];

  return (
    <div
      onClick={onClick}
      className={`
        session-tab group relative flex items-center gap-2 px-2 py-1.5 mx-0.5 my-px cursor-pointer
        rounded-md
        ${
          isActive
            ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        }
      `}
    >
      {/* Status dot */}
      <span className="relative shrink-0 w-1.5 h-1.5">
        <span className={`absolute inset-0 rounded-full ${statusColor} ${usage?.isBusy && session.status === "running" ? "animate-blink" : ""}`} />
      </span>

      {/* Name + directory */}
      <div className="flex-1 min-w-0">
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
            className="text-xs truncate block leading-snug"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditName(session.name);
              setIsEditing(true);
            }}
          >
            {session.name}
          </span>
        )}
        {!hideDirectory && session.directory && (() => {
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
        {contentOnly && (
          <span className="text-[10px] text-[var(--accent)] truncate block mt-0.5">
            content match
          </span>
        )}
        {usage && (usage.inputTokens > 0 || usage.outputTokens > 0) && (
          <span className="text-[10px] text-[var(--text-tertiary)] truncate block mt-0.5">
            {formatTokens(usage.inputTokens + usage.outputTokens)} tokens · ${usage.costUsd.toFixed(2)}
            {session.activeTime ? ` · ${formatDuration(session.activeTime)}` : ""}
          </span>
        )}
      </div>

      {/* Delete button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="opacity-0 group-hover:opacity-100 text-[var(--text-secondary)] hover:text-[var(--danger)] transition-opacity text-xs shrink-0"
        title="Delete session"
      >
        ✕
      </button>
    </div>
  );
});
