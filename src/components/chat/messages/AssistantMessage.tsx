import { useMemo } from "react";
import type { ChatMessage, ContentBlock, ToolsSegmentItem } from "../types";
import { groupToolBlocks, normaliseWs } from "../constants";
import { ContentBlockView } from "./shared/ContentBlockView";
import { ToolCallGroup } from "./ToolCallGroup";
import { InlinePlanBlock } from "./shared/InlinePlanBlock";

interface AssistantMessageProps {
  message: ChatMessage;
  toolStates: Record<string, "expanded" | "collapsed">;
  onToggleTool: (blockId: string, isCurrentlyExpanded: boolean) => void;
  isLastMessage: boolean;
  isStreaming?: boolean;
  planContent?: string;
}

export function AssistantMessage({ message, toolStates, onToggleTool, isLastMessage, isStreaming, planContent }: AssistantMessageProps) {
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

  // Partition items into contiguous tool/thinking runs and content blocks.
  // Thinking blocks between/around tool calls are merged into the tools segment.
  const segments = useMemo(() => {
    type ToolsSegment = { type: "tools"; items: ToolsSegmentItem[]; key: string };
    type ContentSegment = { type: "content"; block: ContentBlock; index: number };
    type Segment = ToolsSegment | ContentSegment;
    const result: Segment[] = [];
    for (let i = 0; i < grouped.items.length; i++) {
      const item = grouped.items[i];
      if (item.type === "toolGroup") {
        // Only merge into the immediately preceding tools segment — don't skip over text blocks.
        const prev = result[result.length - 1];
        const lastToolsSeg = prev?.type === "tools" ? prev as ToolsSegment : undefined;
        if (lastToolsSeg) {
          lastToolsSeg.items.push({ type: "tool", group: item.group });
        } else {
          result.push({ type: "tools", items: [{ type: "tool", group: item.group }], key: item.group.blockId });
        }
      } else {
        const block = item.block;
        if (block.type === "thinking") {
          // Merge into the nearest preceding tools segment, as long as no text content separates them.
          let targetToolsSeg: ToolsSegment | undefined;
          for (let k = result.length - 1; k >= 0; k--) {
            if (result[k].type === "tools") { targetToolsSeg = result[k] as ToolsSegment; break; }
            // Stop scanning if we hit a text content block (not thinking)
            if (result[k].type === "content" && (result[k] as ContentSegment).block.type !== "thinking") break;
          }
          if (targetToolsSeg) {
            targetToolsSeg.items.push({ type: "thinking", block });
          } else {
            const hasToolsAhead = isStreaming || grouped.items.slice(i + 1).some((ni) => ni.type === "toolGroup");
            if (hasToolsAhead) {
              result.push({ type: "tools", items: [{ type: "thinking", block }], key: `thinking-${i}` });
            } else {
              result.push({ type: "content", block, index: i });
            }
          }
        } else {
          result.push({ type: "content", block, index: i });
        }
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
            const filteredItems = planContentFromTool
              ? segment.items.filter((si) => {
                  if (si.type !== "tool") return true;
                  const name = si.group.toolUse.name || "";
                  const fp = (si.group.toolUse.input as Record<string, unknown>)?.file_path;
                  return !((name === "Write" || name === "Edit") &&
                    typeof fp === "string" && fp.includes(".claude/plans/"));
                })
              : segment.items;
            if (filteredItems.length === 0) return null;
            return (
              <ToolCallGroup
                key={segment.key}
                items={filteredItems}
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

          return <ContentBlockView key={index} block={block} isStreaming={isStreaming} />;
        })}
        {planContentFromTool && (
          <InlinePlanBlock planMarkdown={planContentFromTool} />
        )}
      </div>
    </div>
  );
}
