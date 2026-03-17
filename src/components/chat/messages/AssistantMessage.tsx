import { useMemo } from "react";
import type { ChatMessage, ToolGroup, ContentBlock } from "../types";
import { groupToolBlocks, normaliseWs } from "../constants";
import { ContentBlockView } from "./shared/ContentBlockView";
import { ToolCallGroup } from "./ToolCallGroup";
import { InlinePlanBlock } from "./shared/InlinePlanBlock";

interface AssistantMessageProps {
  message: ChatMessage;
  toolStates: Record<string, "expanded" | "collapsed">;
  onToggleTool: (blockId: string, isCurrentlyExpanded: boolean) => void;
  isLastMessage: boolean;
  planContent?: string;
}

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

  // Extract plan content from a Write tool targeting .claude/plans/
  const planContentFromTool = useMemo(() => {
    for (const block of content) {
      if (
        block.type === "tool_use" &&
        (block.name === "Write" || block.name === "Edit") &&
        typeof block.input?.file_path === "string" &&
        (block.input.file_path as string).includes(".claude/plans/") &&
        typeof block.input?.content === "string"
      ) {
        return block.input.content as string;
      }
    }
    return undefined;
  }, [content]);

  // Partition items into contiguous tool-group runs and content blocks
  const segments = useMemo(() => {
    type Segment =
      | { type: "tools"; groups: ToolGroup[]; key: string }
      | { type: "content"; block: ContentBlock; index: number };
    const result: Segment[] = [];
    for (let i = 0; i < grouped.items.length; i++) {
      const item = grouped.items[i];
      if (item.type === "toolGroup") {
        const last = result[result.length - 1];
        if (last && last.type === "tools") {
          last.groups.push(item.group);
        } else {
          result.push({ type: "tools", groups: [item.group], key: item.group.blockId });
        }
      } else {
        result.push({ type: "content", block: item.block, index: i });
      }
    }
    return result;
  }, [grouped.items]);

  return (
    <div className="w-full">
      <div className="flex flex-col gap-2">
        {segments.map((segment) => {
          if (segment.type === "tools") {
            // Filter out plan-file writes — they're rendered as InlinePlanBlock below
            const nonPlanGroups = planContentFromTool
              ? segment.groups.filter((g) => {
                  const name = g.toolUse.name || "";
                  const fp = (g.toolUse.input as Record<string, unknown>)?.file_path;
                  return !((name === "Write" || name === "Edit") &&
                    typeof fp === "string" && fp.includes(".claude/plans/"));
                })
              : segment.groups;
            if (nonPlanGroups.length === 0) return null;
            return (
              <ToolCallGroup
                key={segment.key}
                groups={nonPlanGroups}
                isLastMessage={isLastMessage}
                toolStates={toolStates}
                onToggle={onToggleTool}
              />
            );
          }

          const { block, index } = segment;

          // Collapse text blocks that duplicate the plan content — render at end instead
          const effectivePlanContent = planContentFromTool ?? planContent;
          if (effectivePlanContent && block.type === "text" && block.text && block.text.length > 200) {
            const normText = normaliseWs(block.text);
            const normPlan = normaliseWs(effectivePlanContent);
            if (normPlan.includes(normText.slice(0, 200)) || normText.includes(normPlan.slice(0, 200))) {
              return null;
            }
          }

          return <ContentBlockView key={index} block={block} />;
        })}
        {planContentFromTool && (
          <InlinePlanBlock planMarkdown={planContentFromTool} />
        )}
      </div>
    </div>
  );
}
