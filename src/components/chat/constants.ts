import type { ContentBlock, ChatMessage, GroupedBlocks, ToolGroup } from "./types";

export const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read", write: "Write", edit: "Edit", bash: "Bash",
  glob: "Glob", grep: "Grep", websearch: "WebSearch", webfetch: "WebFetch",
  task: "Task", todowrite: "TodoWrite", lsp: "LSP", agent: "Agent",
};

export const HIDDEN_TOOL_NAMES = new Set(["ToolSearch", "AskUserQuestion", "question"]);

export function canonicalToolName(raw: string): string {
  return TOOL_NAME_MAP[raw.toLowerCase()] || raw;
}

export function getToolColor(toolName: string, isPlanFile = false): string {
  if (isPlanFile) return "text-violet-400";
  switch (toolName) {
    case "Read": return "text-blue-400";
    case "Write": return "text-green-400";
    case "Edit": return "text-yellow-400";
    case "FileChange": return "text-yellow-400";
    case "Bash": return "text-orange-400";
    case "Glob": return "text-purple-400";
    case "Grep": return "text-pink-400";
    case "WebSearch": case "WebFetch": return "text-cyan-400";
    case "Task": return "text-indigo-400";
    case "TodoWrite": return "text-emerald-400";
    default: return "text-[var(--text-secondary)]";
  }
}

export function getToolSummary(toolName: string, input: Record<string, unknown>, isPlanFile = false): string {
  const shortPath = (p: string, n = 3) => {
    if (!p) return "";
    const segs = p.split("/");
    return segs.length > n ? segs.slice(-n).join("/") : p;
  };

  switch (toolName) {
    case "Read": {
      const fp = shortPath(input.file_path as string);
      if (input.offset || input.limit) {
        const parts = [fp];
        if (input.offset) parts.push(`L${input.offset}`);
        if (input.limit) parts.push(`+${input.limit}`);
        return parts.join(" ");
      }
      return fp;
    }
    case "Write":
      if (isPlanFile) return "Plan file (shown in pinned block)";
      return shortPath(input.file_path as string);
    case "Edit": {
      if (isPlanFile) return "Plan file (shown in pinned block)";
      const fp = input.file_path as string || "";
      if (input.old_string != null && input.new_string != null) {
        const removed = (input.old_string as string).split("\n").length;
        const added = (input.new_string as string).split("\n").length;
        const short = fp.split("/").slice(-2).join("/");
        return `${short}  −${removed} +${added}`;
      }
      return shortPath(fp);
    }
    case "FileChange": {
      const changes = (input.changes as Array<{ kind: string; path: string }>) ?? [];
      if (changes.length === 1) return changes[0].path.split("/").slice(-2).join("/");
      if (changes.length > 1) return `${changes.length} files`;
      return "";
    }
    case "Bash":
      return (input.command as string)?.slice(0, 120) || "";
    case "Glob": {
      const pat = input.pattern as string || "";
      const gpath = input.path as string;
      return gpath ? `${pat} in ${shortPath(gpath)}` : pat;
    }
    case "Grep": {
      const pat = input.pattern as string || "";
      const gpath = input.path as string;
      const mode = input.output_mode as string;
      const parts = [pat];
      if (gpath) parts.push(`in ${shortPath(gpath)}`);
      if (mode && mode !== "files_with_matches") parts.push(`(${mode})`);
      return parts.join(" ");
    }
    case "WebSearch":
      return input.query as string || "";
    case "WebFetch":
      return input.url as string || "";
    case "Task":
      return input.description as string || "";
    case "TodoWrite": {
      const todos = input.todos as Array<{ content: string; status: string }> | undefined;
      if (!Array.isArray(todos) || todos.length === 0) return "";
      const completed = todos.filter(t => t.status === "completed").length;
      const inProgress = todos.filter(t => t.status === "in_progress").length;
      const pending = todos.filter(t => t.status === "pending").length;
      const parts: string[] = [];
      if (completed > 0) parts.push(`${completed} done`);
      if (inProgress > 0) parts.push(`${inProgress} active`);
      if (pending > 0) parts.push(`${pending} pending`);
      return parts.join(", ");
    }
    case "LSP":
      return input.command as string || "";
    case "ExitPlanMode":
      return "Plan ready for review";
    default: {
      const vals = Object.values(input);
      if (vals.length === 0) return "";
      const first = vals.find(v => typeof v === "string" && (v as string).length > 0) as string | undefined;
      return first ? first.slice(0, 80) : "";
    }
  }
}

export const normaliseWs = (s: string) => s.replace(/\s+/g, " ").trim();

export function groupToolBlocks(blocks: ContentBlock[], messageId: string): GroupedBlocks {
  const items: GroupedBlocks["items"] = [];
  const toolResultMap = new Map<string, ContentBlock>();

  for (const block of blocks) {
    if (block.type === "tool_result" && block.tool_use_id) {
      toolResultMap.set(block.tool_use_id, block);
    }
  }

  const hiddenToolIds = new Set<string>();
  for (const block of blocks) {
    if (block.type === "tool_use" && (block.name === "ToolSearch" || block.name === "AskUserQuestion" || block.name === "question") && block.id) {
      hiddenToolIds.add(block.id);
    }
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "tool_use") {
      if (hiddenToolIds.has(block.id || "")) continue;
      const blockId = block.id || `${messageId}-${i}`;
      const toolResult = block.id ? toolResultMap.get(block.id) : undefined;
      items.push({
        type: "toolGroup",
        group: { toolUse: block, toolResult, blockId } as ToolGroup,
      });
    } else if (block.type === "tool_result") {
      continue;
    } else {
      items.push({ type: "content", block });
    }
  }

  return { items };
}

function hasToolUse(msg: ChatMessage): boolean {
  if (msg.type !== "assistant") return false;
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  return blocks.some((b) => b.type === "tool_use");
}

function isToolResultOnlyUser(msg: ChatMessage): boolean {
  if (msg.type !== "user") return false;
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  return blocks.length > 0 && blocks.every((b) => b.type === "tool_result");
}

export function mergeToolOnlyMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (hasToolUse(msg)) {
      const mergedContent: ContentBlock[] = [...(Array.isArray(msg.content) ? msg.content : [])];
      let lastAssistant = msg;
      let j = i + 1;

      while (j < messages.length) {
        const next = messages[j];
        if (next.type === "assistant" && hasToolUse(next)) {
          mergedContent.push(...(Array.isArray(next.content) ? next.content : []));
          lastAssistant = next;
          j++;
        } else if (
          j + 1 < messages.length &&
          isToolResultOnlyUser(next) &&
          messages[j + 1].type === "assistant" &&
          hasToolUse(messages[j + 1])
        ) {
          mergedContent.push(...(Array.isArray(next.content) ? next.content : []));
          mergedContent.push(...(Array.isArray(messages[j + 1].content) ? messages[j + 1].content : []));
          lastAssistant = messages[j + 1] as ChatMessage;
          j += 2;
        } else {
          break;
        }
      }

      if (j > i + 1) {
        result.push({
          ...msg,
          content: mergedContent,
          isStreaming: lastAssistant.isStreaming,
        });
        i = j - 1;
      } else {
        result.push(msg);
      }
    } else {
      result.push(msg);
    }
  }

  return result;
}

/** Normalize API content (can be a string or array of blocks) into ContentBlock[] */
export function normalizeContent(raw: unknown): ContentBlock[] | null {
  if (Array.isArray(raw)) return raw as ContentBlock[];
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  return null;
}

export const PARSE_CHUNK_SIZE = 200;

export function parseHistoryLines(
  lines: string[],
  sdkMessageToChatMessage: (msg: Record<string, unknown>, isHistoryReplay?: boolean) => ChatMessage | null,
): Promise<ChatMessage[]> {
  return new Promise((resolve) => {
    const messageOrder: string[] = [];
    const messageMap = new Map<string, ChatMessage>();
    const assistantAccum = new Map<string, ContentBlock[]>();
    let offset = 0;

    function processChunk() {
      const end = Math.min(offset + PARSE_CHUNK_SIZE, lines.length);
      for (let i = offset; i < end; i++) {
        const line = lines[i];
        try {
          const msg = JSON.parse(line);
          const msgType = msg.type as string;

          if (msgType === "assistant") {
            const messageObj = msg.message as Record<string, unknown> | undefined;
            const content = normalizeContent(messageObj?.content);
            const apiMsgId = (messageObj?.id as string) || `anon-${messageOrder.length}`;
            if (content) {
              const existing = assistantAccum.get(apiMsgId) || [];
              for (const block of content) {
                const matchIdx = block.type === "tool_use" && block.id
                  ? existing.findIndex((b: ContentBlock) => b.type === "tool_use" && b.id === block.id)
                  : block.type === "text"
                    ? (() => {
                      let lastTextIdx = -1;
                      let lastToolUseIdx = -1;
                      for (let k = existing.length - 1; k >= 0; k--) {
                        if (lastTextIdx === -1 && existing[k].type === "text") lastTextIdx = k;
                        if (lastToolUseIdx === -1 && existing[k].type === "tool_use") lastToolUseIdx = k;
                        if (lastTextIdx !== -1 && lastToolUseIdx !== -1) break;
                      }
                      return lastTextIdx > lastToolUseIdx ? lastTextIdx : -1;
                    })()
                    : -1;
                if (matchIdx !== -1) {
                  existing[matchIdx] = block;
                } else {
                  existing.push(block);
                }
              }
              assistantAccum.set(apiMsgId, existing);
              if (!messageMap.has(apiMsgId)) {
                messageOrder.push(apiMsgId);
              }
              messageMap.set(apiMsgId, {
                id: apiMsgId,
                type: "assistant",
                content: [...existing],
                timestamp: Date.now(),
              });
            }
          } else {
            const chatMsg = sdkMessageToChatMessage(msg, true);
            if (chatMsg) {
              if (!messageMap.has(chatMsg.id)) {
                messageOrder.push(chatMsg.id);
              }
              messageMap.set(chatMsg.id, chatMsg);
            }
          }
        } catch { }
      }
      offset = end;
      if (offset < lines.length) {
        setTimeout(processChunk, 0);
      } else {
        resolve(messageOrder.map(id => messageMap.get(id)!).filter(Boolean));
      }
    }

    if (lines.length === 0) {
      resolve([]);
    } else {
      processChunk();
    }
  });
}
