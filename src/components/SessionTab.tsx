import { useState, useRef, useEffect, memo } from "react";
import type { Session, SessionUsage } from "../types";

function shortenPath(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

interface SessionTabProps {
  session: Session;
  isActive: boolean;
  usage?: SessionUsage;
  onClick: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}

export default memo(function SessionTab({
  session,
  isActive,
  usage,
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
        session-tab group relative flex items-center gap-2.5 px-3 py-2.5 mx-1 my-0.5 cursor-pointer
        rounded-lg
        ${
          isActive
            ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        }
      `}
    >
      {/* Status dot + thinking indicator */}
      <span className="relative shrink-0 w-2 h-2">
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
        {session.directory && (
          <span className="text-[10px] text-[var(--text-tertiary)] truncate block mt-0.5">
            {shortenPath(session.directory)}
          </span>
        )}
        {usage && (usage.inputTokens > 0 || usage.outputTokens > 0) && (
          <span className="text-[10px] text-[var(--text-tertiary)] truncate block mt-0.5">
            {formatTokens(usage.inputTokens + usage.outputTokens)} tokens · ${usage.costUsd.toFixed(2)}
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
