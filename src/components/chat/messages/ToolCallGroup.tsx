import { useState } from "react";
import type { ToolGroup } from "../types";
import { ToolRow } from "./ToolRow";
import { canonicalToolName, getToolColor } from "../constants";

interface ToolCallGroupProps {
  groups: ToolGroup[];
  isLastMessage: boolean;
  toolStates: Record<string, "expanded" | "collapsed">;
  onToggle: (blockId: string, isCurrentlyExpanded: boolean) => void;
}

export function ToolCallGroup({ groups, isLastMessage, toolStates, onToggle }: ToolCallGroupProps) {
  const allDone = groups.every((g) => !!g.toolResult || !isLastMessage);
  const anyError = groups.some((g) => g.toolResult?.is_error);
  const isInProgress = !allDone && isLastMessage;

  const hasPlanFile = groups.some((g) => {
    const name = canonicalToolName(g.toolUse.name || "");
    const fp = (g.toolUse.input as Record<string, unknown>)?.file_path;
    return (name === "Write" || name === "Edit") &&
      typeof fp === "string" && fp.includes(".claude/plans/");
  });

  const [explicitState, setExplicitState] = useState<boolean | null>(null);
  const isExpanded = explicitState !== null ? explicitState : hasPlanFile;

  const handleToggle = () => setExplicitState(!isExpanded);

  const statusIcon = isInProgress ? (
    <span className="w-3 h-3 border-2 border-[var(--text-tertiary)] border-t-transparent rounded-full animate-spin shrink-0" />
  ) : (
    <span className={`text-xs shrink-0 ${anyError ? "text-red-400" : "text-green-400"}`}>
      {anyError ? "✗" : "✓"}
    </span>
  );

  return (
    <div className="rounded-md overflow-hidden border border-[var(--border-subtle)]">
      {/* Group header */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center gap-2 py-1.5 px-3 hover:bg-white/5 cursor-pointer text-sm transition-colors"
      >
        <svg
          className={`w-2.5 h-2.5 shrink-0 transition-transform text-[var(--text-tertiary)] ${isExpanded ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span className="text-xs flex-1 text-left flex items-center gap-1.5 flex-wrap">
          {(() => {
            const counts: Record<string, number> = {};
            for (const g of groups) {
              const name = canonicalToolName(g.toolUse.name || "Unknown");
              counts[name] = (counts[name] ?? 0) + 1;
            }
            const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
            return entries.map(([name, n], i) => (
              <span key={name} className="flex items-center gap-0.5">
                {i > 0 && <span className="text-[var(--text-tertiary)] mr-1">·</span>}
                <span className="text-[var(--text-tertiary)]">{n}×</span><span className={`${getToolColor(name)} font-medium`}>{name}</span>
              </span>
            ));
          })()}
        </span>
        {statusIcon}
      </button>

      {/* Expanded: flat tool rows */}
      {isExpanded && (
        <div className="border-t border-[var(--border-subtle)]">
          {groups.map((group, i) => (
            <ToolRow
              key={group.blockId}
              group={group}
              isLastMessage={isLastMessage}
              isLastTool={i === groups.length - 1}
              toolState={toolStates[group.blockId]}
              onToggle={onToggle}
              flat
            />
          ))}
        </div>
      )}
    </div>
  );
}
