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
  hideDirectory,
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
    if (trimmed) {
      onRename(trimmed);
    }
    setIsEditing(false);
  };

  const isRunning = session.status === "running" || session.status === "starting";
  const isBusy = usage?.isBusy && isRunning;
  const hasQuestion = session.hasQuestion && isRunning; // AskUserQuestion pending (takes priority over busy)
  const hasError = session.status === "stopped" && session.exitCode !== undefined && session.exitCode !== 0;
  const hasDraft = session.hasDraft && isRunning;

  return (
    <div
      onClick={onClick}
      className={`
        session-tab group relative flex items-center gap-2 px-2.5 py-2 mx-0.5 my-px cursor-pointer
        rounded-lg
        ${
          isActive
            ? hasQuestion
              ? "bg-orange-500/10 text-[var(--text-primary)]"
              : "bg-[var(--accent)]/8 text-[var(--text-primary)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        }
      `}
    >
      {/* Status indicator: error > question (orange pulse) > spinner (busy) > draft (pencil) > solid dot (unread) */}
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
            {childCount !== undefined && childCount > 0 && (
              <span className="mr-0.5 text-[9px] px-1 py-px rounded bg-blue-500/15 text-blue-400 font-medium align-middle" title={`${childCount} execution session${childCount !== 1 ? "s" : ""}`}>
                <svg className="w-2.5 h-2.5 inline -mt-px mr-0.5" viewBox="0 0 16 16" fill="currentColor"><path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0Z" /></svg>
                {childCount}
              </span>
            )}
            {session.name}
            {session.provider && session.provider !== "claude-code" && (
              <span className="ml-1.5 text-[9px] px-1 py-px rounded bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] uppercase tracking-wider font-semibold align-middle">
                {session.provider === "opencode" ? "OC" : session.provider}
              </span>
            )}
          </span>
        )}
        {parentName && (
          <span className="text-[10px] text-violet-400/70 truncate block mt-0.5">
            from: {parentName}
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
        className="opacity-0 group-hover:opacity-100 text-[var(--text-secondary)] hover:text-[var(--danger)] hover:bg-red-500/10 rounded-md p-0.5 transition-all duration-150 text-xs shrink-0"
        title="Delete session"
      >
        ✕
      </button>
    </div>
  );
});
