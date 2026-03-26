import { useMemo, useState } from "react";
import type { ToolGroup } from "../types";
import { canonicalToolName, getToolColor, getToolSummary, getSpecialToolInfo } from "../constants";
import { ToolExpandedDetail } from "./ToolExpandedDetail";
import { Spinner } from "../../ui/spinner";

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

export function ToolRow({ group, isLastMessage, isLastTool: _isLastTool, toolState, onToggle, flat }: ToolRowProps) {
  const rawToolName = group.toolUse.name || "Unknown tool";
  const toolName = useMemo(() => canonicalToolName(rawToolName), [rawToolName]);
  const input = group.toolUse.input || {};

  const specialInfo = useMemo(() => getSpecialToolInfo(rawToolName, input as Record<string, unknown>), [rawToolName, input]);

  const isPlanFile = (toolName === "Write" || toolName === "Edit") &&
    typeof input.file_path === "string" && (input.file_path as string).includes(".claude/plans/");

  const hasResult = !!group.toolResult || !isLastMessage;
  const isError = group.toolResult?.is_error;

  const isExpanded = toolState === "expanded";

  const summary = useMemo(() => getToolSummary(toolName, input, isPlanFile), [toolName, input, isPlanFile]);
  const toolColor = useMemo(() => getToolColor(toolName, isPlanFile), [toolName, isPlanFile]);

  // Hover tooltip state
  const [showTooltip, setShowTooltip] = useState(false);

  // Status indicator
  const statusIcon = hasResult ? (
    <span className={`text-xs shrink-0 ${isError ? "text-red-400" : "text-green-400"}`}>
      {isError ? "✗" : "✓"}
    </span>
  ) : (
    <Spinner className="w-3.5 h-3.5" />
  );

  const isSpecial = specialInfo.kind !== null;

  const rowContent = (
    <>
      {/* Compact row */}
      <button
        onClick={() => onToggle(group.blockId, isExpanded)}
        className={`w-full flex items-center gap-2 py-1.5 px-3 hover:bg-white/5 cursor-pointer text-sm${flat ? " border-b border-[var(--border-subtle)]" : ""}`}
      >
        {/* Chevron */}
        <svg
          className={`w-3 h-3 shrink-0 text-[var(--text-tertiary)] ${isExpanded ? "rotate-90" : ""}`}
          viewBox="0 0 24 24" fill="currentColor"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>

        {isSpecial ? (
          /* Special tool display (Skill / MCP) */
          <div
            className="relative flex items-center gap-1.5 flex-1 min-w-0"
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
          >
            {specialInfo.kind === "skill" ? (
              /* Skill: lightning icon + /name badge */
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-violet-500/15 border-2 border-violet-500/25 text-xs font-bold text-violet-400 shrink-0">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                {specialInfo.displayName}
              </span>
            ) : (
              /* MCP: plug icon + server.method */
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-teal-500/15 border-2 border-teal-500/25 text-xs font-bold text-teal-400 shrink-0 max-w-[70%] truncate">
                <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 2v4m0 12v4m-7-7H1m22 0h-4M5.64 5.64l2.12 2.12m8.48 8.48l2.12 2.12m0-12.72l-2.12 2.12m-8.48 8.48l-2.12 2.12" /></svg>
                {specialInfo.displayName}
              </span>
            )}
            {/* Summary after badge */}
            {summary && (
              <span className="text-xs text-[var(--text-tertiary)] truncate flex-1 font-mono text-left">
                {summary}
              </span>
            )}
            {/* Hover tooltip */}
            {showTooltip && specialInfo.detail && (
              <div className="absolute left-0 bottom-full mb-1.5 z-50 px-2.5 py-1.5 bg-[var(--bg-primary)] border-2 border-[var(--border-color)] shadow-lg text-xs whitespace-nowrap pointer-events-none">
                <div className="text-[var(--text-secondary)]">{specialInfo.detail}</div>
                {specialInfo.kind === "mcp" && (
                  <div className="text-[var(--text-tertiary)] mt-0.5 font-mono text-[10px]">{rawToolName}</div>
                )}
                {specialInfo.kind === "skill" && !!(input as Record<string, unknown>).args && (
                  <div className="text-[var(--text-tertiary)] mt-0.5 font-mono text-[10px]">args: {String((input as Record<string, unknown>).args)}</div>
                )}
              </div>
            )}
          </div>
        ) : (
          /* Normal tool display */
          <>
            <span className={`text-xs font-bold ${toolColor} shrink-0 w-20 text-left truncate`} title={isPlanFile ? "Plan" : toolName}>
              {isPlanFile ? "Plan" : toolName}
            </span>
            {summary && (
              <span className="text-xs text-[var(--text-tertiary)] truncate flex-1 font-mono text-left">
                {summary}
              </span>
            )}
          </>
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
    <div className="overflow-hidden border-2 border-[var(--border-subtle)]">
      {rowContent}
    </div>
  );
}
