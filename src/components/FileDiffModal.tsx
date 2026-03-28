import { useState, useEffect, useCallback } from "react";
import { PierreDiff, type DiffMode } from "./DiffViewer";

interface Props {
  path: string;
  diff: string;
  onClose: () => void;
}

export default function FileDiffModal({ path, diff, onClose }: Props) {
  const [diffMode, setDiffMode] = useState<DiffMode>(() => {
    return (localStorage.getItem("git-diff-mode") as DiffMode) || "unified";
  });

  const toggleDiffMode = () => {
    const next = diffMode === "unified" ? "split" : "unified";
    setDiffMode(next);
    localStorage.setItem("git-diff-mode", next);
  };

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
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
        className="flex flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)] shadow-2xl"
        style={{ width: "min(90vw, 1200px)", height: "80vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-subtle)] shrink-0">
          <button
            onClick={onClose}
            className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
          <span className="font-mono text-sm text-[var(--text-primary)] font-medium truncate flex-1 min-w-0">
            {filename}
          </span>
          <span className="font-mono text-xs text-[var(--text-tertiary)] truncate max-w-[40%]">{path}</span>
          <button
            onClick={toggleDiffMode}
            className="text-[11px] font-medium text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-2 py-1 rounded-lg hover:bg-[var(--bg-tertiary)] shrink-0"
          >
            {diffMode === "unified" ? "Split" : "Unified"}
          </button>
        </div>

        {/* Diff content */}
        <div className="flex-1 min-h-0 overflow-y-auto bg-[var(--bg-primary)] rounded-b-xl">
          {diff ? (
            <div className="diff-panel-viewport">
              <PierreDiff diff={diff} mode={diffMode} filePath={path} />
            </div>
          ) : (
            <div className="text-xs text-[var(--text-tertiary)] py-8 text-center">No changes</div>
          )}
        </div>
      </div>
    </div>
  );
}
