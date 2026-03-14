import { useMemo } from "react";
import type { ToolGroup } from "../types";
import { canonicalToolName, getToolColor, getToolSummary } from "../constants";
import { ToolExpandedDetail } from "./ToolExpandedDetail";

interface ToolRowProps {
  group: ToolGroup;
  isLastMessage: boolean;
  isLastTool?: boolean;
  toolState?: "expanded" | "collapsed";
  onToggle: (blockId: string, isCurrentlyExpanded: boolean) => void;
  sessionId?: string;
  onFileOpen?: (path: string) => void;
  flat?: boolean;
}

export function ToolRow({ group, isLastMessage, isLastTool, toolState, onToggle, flat }: ToolRowProps) {
  const rawToolName = group.toolUse.name || "Unknown tool";
  const toolName = useMemo(() => canonicalToolName(rawToolName), [rawToolName]);
  const input = group.toolUse.input || {};

  const isPlanFile = (toolName === "Write" || toolName === "Edit") &&
    typeof input.file_path === "string" && (input.file_path as string).includes(".claude/plans/");

  const hasResult = !!group.toolResult || !isLastMessage;
  const isError = group.toolResult?.is_error;

  // Expand logic: expanded if manually expanded, in-progress, or last tool in last message
  const isExpanded = !!(isPlanFile
    ? toolState === "expanded"
    : toolState === "expanded"
      || (!hasResult && toolState !== "collapsed")
      || (isLastTool && isLastMessage && toolState !== "collapsed"));

  const summary = useMemo(() => getToolSummary(toolName, input, isPlanFile), [toolName, input, isPlanFile]);
  const toolColor = useMemo(() => getToolColor(toolName, isPlanFile), [toolName, isPlanFile]);

  // Status indicator
  const statusIcon = hasResult ? (
    <span className={`text-xs shrink-0 ${isError ? "text-red-400" : "text-green-400"}`}>
      {isError ? "✗" : "✓"}
    </span>
  ) : (
    <span className="w-3 h-3 border-2 border-[var(--text-tertiary)] border-t-transparent rounded-full animate-spin shrink-0" />
  );

  const rowContent = (
    <>
      {/* Compact row */}
      <button
        onClick={() => onToggle(group.blockId, isExpanded)}
        className={`w-full flex items-center gap-2 py-1 px-2 hover:bg-white/5 cursor-pointer text-sm transition-colors${flat ? " border-b border-[var(--border-subtle)]" : ""}`}
      >
        {/* Chevron */}
        <svg
          className={`w-2.5 h-2.5 shrink-0 transition-transform text-[var(--text-tertiary)] ${isExpanded ? "rotate-90" : ""}`}
          viewBox="0 0 24 24" fill="currentColor"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        {/* Tool icon (colored dot) */}
        <span className={`text-xs font-medium ${toolColor} shrink-0`}>
          {isPlanFile ? "Plan" : toolName}
        </span>
        {/* Truncated summary */}
        {summary && (
          <span className="text-xs text-[var(--text-tertiary)] truncate flex-1 font-mono text-left">
            {summary}
          </span>
        )}
        {/* Status */}
        {!isExpanded && statusIcon}
      </button>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)] max-h-48 overflow-y-auto">
          <ToolExpandedDetail group={group} toolName={toolName} isError={!!isError} />
        </div>
      )}
    </>
  );

  if (flat) {
    return <div>{rowContent}</div>;
  }

  return (
    <div className="rounded-md overflow-hidden border border-[var(--border-subtle)]">
      {rowContent}
    </div>
  );
}
