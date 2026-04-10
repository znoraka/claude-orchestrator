import { useState, useEffect, useCallback } from "react";
import DiffViewer, { type DiffMode, type InlineCommentProps } from "./DiffViewer";
import { Spinner } from "./ui/spinner";
import type { BlameLine } from "../types";

interface Props {
  path: string;
  diff: string;
  onClose: () => void;
  diffLoading?: boolean;
  blameMap?: Map<number, BlameLine>;
  onLineClick?: (lineNumber: number) => void;
  inlineComments?: InlineCommentProps;
  isViewed?: boolean;
  onToggleViewed?: () => void;
  onPrevFile?: () => void;
  onNextFile?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

function relativeTime(dateStr: string): string {
  const d = new Date(dateStr.includes("T") ? dateStr : dateStr + "T00:00:00");
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function FileDiffModal({ path, diff, onClose, diffLoading, blameMap, onLineClick, inlineComments, isViewed, onToggleViewed, onPrevFile, onNextFile, hasPrev, hasNext }: Props) {
  const [diffMode, setDiffMode] = useState<DiffMode>(() => {
    return (localStorage.getItem("git-diff-mode") as DiffMode) || "unified";
  });
  const [hoveredBlame, setHoveredBlame] = useState<BlameLine | null>(null);

  const toggleDiffMode = () => {
    const next = diffMode === "unified" ? "split" : "unified";
    setDiffMode(next);
    localStorage.setItem("git-diff-mode", next);
  };

  const commentLine = inlineComments?.commentLine ?? null;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (commentLine !== null && inlineComments?.onCancelComment) {
          inlineComments.onCancelComment();
        } else {
          onClose();
        }
      }
      if (e.key === "ArrowLeft" && hasPrev && onPrevFile) onPrevFile();
      if (e.key === "ArrowRight" && hasNext && onNextFile) onNextFile();
    },
    [onClose, inlineComments, commentLine, hasPrev, hasNext, onPrevFile, onNextFile],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const filename = path.split("/").pop() ?? path;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        className="flex flex-col border border-[var(--border-subtle)] bg-[var(--bg-primary)] shadow-2xl overflow-hidden"
        style={{ width: "min(90vw, 1200px)", height: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-subtle)] shrink-0">
          <button
            onClick={onClose}
            className="flex items-center justify-center w-6 h-6 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>

          {/* Prev / Viewed / Next */}
          {(onPrevFile || onNextFile) && (
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={onPrevFile}
                disabled={!hasPrev}
                className="flex items-center justify-center w-6 h-6 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-25 disabled:cursor-default"
                title="Previous file (←)"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="10 4 6 8 10 12" />
                </svg>
              </button>
              {onToggleViewed && (
                <button
                  onClick={onToggleViewed}
                  className="flex items-center gap-1.5 text-[11px] font-medium shrink-0 px-2 py-1 hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                  title={isViewed ? "Mark as not viewed" : "Mark as viewed"}
                >
                  <span
                    className={`flex-shrink-0 w-4 h-4 border-2 flex items-center justify-center ${
                      isViewed
                        ? "bg-[var(--success)] border-[var(--success)]"
                        : "border-[var(--text-tertiary)]/50 hover:border-[var(--text-secondary)]"
                    }`}
                  >
                    {isViewed && (
                      <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 6l3 3 5-5" />
                      </svg>
                    )}
                  </span>
                  Viewed
                </button>
              )}
              <button
                onClick={onNextFile}
                disabled={!hasNext}
                className="flex items-center justify-center w-6 h-6 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-25 disabled:cursor-default"
                title="Next file (→)"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 4 10 8 6 12" />
                </svg>
              </button>
            </div>
          )}

          <span className="font-mono text-sm text-[var(--text-primary)] font-medium truncate flex-1 min-w-0">
            {filename}
          </span>
          <span className="font-mono text-xs text-[var(--text-tertiary)] truncate max-w-[40%]">{path}</span>

          <button
            onClick={toggleDiffMode}
            className="text-[11px] font-medium text-[var(--text-tertiary)] hover:text-[var(--text-primary)] px-2 py-1 hover:bg-[var(--bg-tertiary)] shrink-0"
          >
            {diffMode === "unified" ? "Split" : "Unified"}
          </button>
        </div>

        {/* Diff content */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {diffLoading ? (
            <div className="flex items-center justify-center h-full gap-2 text-[var(--text-tertiary)]">
              <Spinner className="w-4 h-4" />
              <span className="text-sm">Loading diff…</span>
            </div>
          ) : (
            <DiffViewer
              diff={diff}
              mode={diffMode}
              filePath={path}
              searchQuery=""
              currentMatch={0}
              blameMap={blameMap}
              onLineClick={onLineClick}
              inlineComments={inlineComments}
              onBlameChange={setHoveredBlame}
            />
          )}
        </div>

        {/* Blame bar */}
        {hoveredBlame && (
          <div
            className="flex items-center gap-2 px-3 flex-shrink-0 border-t border-[var(--border-color)]"
            style={{
              height: 28,
              fontSize: 11,
              fontFamily: "var(--font-mono, monospace)",
              color: "var(--text-secondary)",
              background: "var(--bg-secondary)",
            }}
          >
            <span style={{ color: "var(--accent)", fontWeight: 600 }}>
              {hoveredBlame.sha.slice(0, 8)}
            </span>
            <span style={{ color: "var(--text-primary)" }}>
              {hoveredBlame.author}
            </span>
            <span style={{ opacity: 0.5 }}>
              {relativeTime(hoveredBlame.date)}
            </span>
          </div>
        )}

        {/* Inline comment form */}
        {commentLine !== null && inlineComments && (
          <div className="border-t-2 border-[var(--accent)]/40 p-3 flex-shrink-0 bg-[var(--bg-secondary)]">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-mono text-[var(--accent)]">Line {commentLine}</span>
              <span className="text-[10px] text-[var(--text-tertiary)]">{path}</span>
            </div>
            <textarea
              value={inlineComments.commentText}
              onChange={(e) => inlineComments.onCommentTextChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  inlineComments.onPostComment();
                }
                if (e.key === "Escape") {
                  inlineComments.onCancelComment();
                }
              }}
              placeholder="Write a review comment…"
              rows={3}
              autoFocus
              className="w-full bg-[var(--bg-primary)] border-2 border-[var(--border-color)] px-2.5 py-2 text-[12px] text-[var(--text-primary)] placeholder-[var(--text-tertiary)] outline-none focus:border-[var(--accent)]/50 resize-none font-mono"
            />
            <div className="flex items-center justify-end gap-2 mt-1.5">
              <button
                onClick={inlineComments.onCancelComment}
                className="px-3 py-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
              >
                Cancel
              </button>
              <button
                onClick={inlineComments.onPostComment}
                disabled={!inlineComments.commentText.trim() || inlineComments.posting}
                className="px-3 py-1 text-[11px] font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-default"
              >
                {inlineComments.posting ? "Posting…" : "Comment"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
