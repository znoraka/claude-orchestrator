import { useState, useMemo } from "react";
import type { ToolsSegmentItem } from "../types";
import { ToolRow } from "./ToolRow";
import { canonicalToolName, getToolColor } from "../constants";


interface ToolCallGroupProps {
  items: ToolsSegmentItem[];
  isLastMessage: boolean;
  toolStates: Record<string, "expanded" | "collapsed">;
  onToggle: (blockId: string, isCurrentlyExpanded: boolean) => void;
}

const COLLAPSED_VISIBLE = 4;

export function ToolCallGroup({ items, isLastMessage, toolStates, onToggle }: ToolCallGroupProps) {
  const toolGroups = useMemo(() => items.filter((i) => i.type === "tool"), [items]);

  const allDone = toolGroups.every((t) => !!t.group.toolResult || !isLastMessage);
  const anyError = toolGroups.some((t) => t.group.toolResult?.is_error);
  const isInProgress = !allDone && isLastMessage;

  const [isExpanded, setIsExpanded] = useState(false);

  const handleToggle = () => setIsExpanded((e) => !e);

  const statusIcon = isInProgress ? (
    <span className="w-3.5 h-3.5 border-2 border-[var(--accent-color)]/50 border-t-transparent rounded-full animate-spin shrink-0" />
  ) : (
    <span className={`text-xs shrink-0 ${anyError ? "text-red-400" : "text-green-400"}`}>
      {anyError ? "✗" : "✓"}
    </span>
  );

  const visibleItems = isExpanded ? items : items.slice(-COLLAPSED_VISIBLE);

  return (
    <div className="py-4">
      <div className="rounded-lg overflow-hidden border border-[var(--border-subtle)]">
        {/* Header */}
        <button
          onClick={handleToggle}
          className="w-full flex items-center gap-2 py-2 px-3 bg-white/[0.03] hover:bg-white/5 cursor-pointer text-sm transition-colors"
        >
          <svg
            className={`w-3 h-3 shrink-0 transition-transform text-[var(--text-tertiary)] ${isExpanded ? "rotate-90" : ""}`}
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
          <span className="text-xs flex-1 text-left flex items-center gap-1.5 flex-wrap">
            {(() => {
              const counts: Record<string, number> = {};
              for (const item of items) {
                if (item.type === "tool") {
                  const name = canonicalToolName(item.group.toolUse.name || "Unknown");
                  counts[name] = (counts[name] ?? 0) + 1;
                } else if (item.type === "thinking") {
                  counts["Thinking"] = (counts["Thinking"] ?? 0) + 1;
                }
              }
              const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
              return entries.map(([name, n], i) => (
                <span key={name} className="flex items-center gap-0.5">
                  {i > 0 && <span className="text-[var(--text-tertiary)] mr-1">·</span>}
                  <span className="text-[var(--text-tertiary)]">{n}×</span>
                  <span className={`${name === "Thinking" ? "text-[var(--text-secondary)]" : getToolColor(name)} font-medium`}>{name}</span>
                </span>
              ));
            })()}
          </span>
          {statusIcon}
        </button>

        {/* Items (tool rows + thinking) */}
        <div className={`border-t border-[var(--border-subtle)]${isExpanded ? " max-h-[340px] overflow-y-auto" : ""}`}>
          {visibleItems.map((item, i) => {
            if (item.type === "tool") {
              return (
                <ToolRow
                  key={item.group.blockId}
                  group={item.group}
                  isLastMessage={isLastMessage}
                  isLastTool={i === visibleItems.length - 1}
                  toolState={toolStates[item.group.blockId]}
                  onToggle={onToggle}
                  flat
                />
              );
            }
            // Thinking row — inline like a tool row
            const summary = (item.block.thinking || "").replace(/\s+/g, " ").trim().slice(0, 100);
            return (
              <ThinkingRow
                key={`thinking-${i}`}
                summary={summary}
                thinking={item.block.thinking || ""}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ThinkingRow({ summary, thinking }: { summary: string; thinking: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 py-1.5 px-3 hover:bg-white/5 cursor-pointer text-sm transition-colors border-b border-[var(--border-subtle)]"
      >
        <svg
          className={`w-3 h-3 shrink-0 transition-transform text-[var(--text-tertiary)] ${open ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span className="text-xs font-medium text-[var(--text-secondary)] shrink-0 w-20 text-left">Thinking</span>
        {!open && summary && (
          <span className="text-xs text-[var(--text-tertiary)] truncate flex-1 font-mono text-left">
            {summary}
          </span>
        )}
      </button>
      {open && (
        <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] max-h-48 overflow-y-auto px-3 py-2 text-xs text-[var(--text-secondary)] whitespace-pre-wrap">
          {thinking}
        </div>
      )}
    </div>
  );
}
