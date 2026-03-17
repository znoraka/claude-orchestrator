import { useState } from "react";
import { MarkdownContent } from "./MarkdownContent";

export function ThinkingBlock({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(false);
  const summary = thinking.replace(/\s+/g, " ").trim().slice(0, 100);
  return (
    <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
      >
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span className="text-xs font-medium text-[var(--text-tertiary)]">Thinking</span>
        {!open && summary && (
          <span className="text-xs text-[var(--text-tertiary)] truncate flex-1 font-mono">{summary}</span>
        )}
      </button>
      {open && (
        <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)] max-h-96 overflow-y-auto px-3 py-2">
          <MarkdownContent text={thinking} />
        </div>
      )}
    </div>
  );
}
