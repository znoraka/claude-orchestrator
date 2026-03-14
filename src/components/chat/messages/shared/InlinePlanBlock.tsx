import { useState, useMemo, useCallback } from "react";
import { MarkdownContent } from "./MarkdownContent";

export function InlinePlanBlock({ content, defaultOpen }: { content: string; defaultOpen?: boolean }) {
  const [collapsed, setCollapsed] = useState(!defaultOpen);
  const [copied, setCopied] = useState(false);
  const title = useMemo(() => {
    const m = content.match(/^#\s+(.+)$/m);
    return m ? m[1] : undefined;
  }, [content]);
  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);
  return (
    <div className="border border-[var(--border-color)] rounded-lg overflow-hidden w-[80%]">
      <div onClick={() => setCollapsed(!collapsed)} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer">
        <svg className={`w-3 h-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} viewBox="0 0 24 24" fill="currentColor"><path d="M9 18l6-6-6-6" /></svg>
        <span className="text-xs font-medium text-violet-400">Plan</span>
        {title && <span className="text-xs font-mono text-[var(--text-tertiary)] truncate flex-1">{title}</span>}
        <button onClick={handleCopy} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]" title="Copy plan">
          {copied ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
        </button>
        <span className="text-xs text-green-400">✓</span>
      </div>
      {!collapsed && <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 pt-3 pb-6 text-sm text-[var(--text-primary)] overflow-y-auto max-h-96"><MarkdownContent text={content} /></div>}
    </div>
  );
}
