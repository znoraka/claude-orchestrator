import { useMemo, useState, useCallback } from "react";
import type { ChatMessage } from "../types";
import { groupToolBlocks } from "../constants";
import { ContentBlockView } from "./shared/ContentBlockView";
import { ToolRow } from "./ToolRow";
import { MarkdownContent } from "./shared/MarkdownContent";

interface AssistantMessageProps {
  message: ChatMessage;
  toolStates: Record<string, "expanded" | "collapsed">;
  onToggleTool: (blockId: string, isCurrentlyExpanded: boolean) => void;
  isLastMessage: boolean;
  planContent?: string;
}

function InlinePlanBlock({ content }: { content: string }) {
  const [collapsed, setCollapsed] = useState(true);
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

export { InlinePlanBlock };

export function AssistantMessage({ message, toolStates, onToggleTool, isLastMessage, planContent }: AssistantMessageProps) {
  const content = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];

  const grouped = useMemo(
    () => groupToolBlocks(content, message.id),
    [content, message.id]
  );

  const lastToolIdx = useMemo(
    () => grouped.items.reduce((last, item, i) => item.type === "toolGroup" ? i : last, -1),
    [grouped.items]
  );

  return (
    <div className="w-full">
      <div className="flex flex-col gap-2">
        {grouped.items.map((item, i) => {
          if (item.type === "toolGroup") {
            const { group } = item;
            return (
              <ToolRow
                key={group.blockId}
                group={group}
                isLastMessage={isLastMessage}
                isLastTool={i === lastToolIdx}
                toolState={toolStates[group.blockId]}
                onToggle={onToggleTool}
              />
            );
          }

          // Collapse text blocks that duplicate the pinned plan content
          if (planContent && item.block.type === "text" && item.block.text && item.block.text.length > 200) {
            const text = item.block.text;
            const normalise = (s: string) => s.replace(/\s+/g, " ").trim();
            const normText = normalise(text);
            const normPlan = normalise(planContent);
            if (normPlan.includes(normText.slice(0, 200)) || normText.includes(normPlan.slice(0, 200))) {
              return (
                <details key={i} className="text-xs text-[var(--text-tertiary)]">
                  <summary className="cursor-pointer hover:text-[var(--text-secondary)] select-none inline-flex items-center gap-1.5 py-1">
                    <span className="px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 text-[10px] font-medium">Plan</span>
                    Plan description (shown in pinned block above)
                  </summary>
                  <div className="mt-1 pl-3 border-l border-[var(--border-color)]">
                    <ContentBlockView block={item.block} />
                  </div>
                </details>
              );
            }
          }

          return <ContentBlockView key={i} block={item.block} />;
        })}
      </div>
    </div>
  );
}
