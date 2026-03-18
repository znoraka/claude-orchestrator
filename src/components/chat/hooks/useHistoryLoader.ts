import { useEffect, useRef, useMemo, useState } from "react";
import { invoke } from "../../../lib/bridge";
import { jsonlDirectory } from "../../../types";
import type { ChatMessage, ContentBlock } from "../types";
import { parseHistoryLines } from "../constants";

interface HistoryLoaderProps {
  sessionId: string;
  session?: {
    claudeSessionId?: string;
    directory?: string;
    homeDirectory?: string;
    planContent?: string;
    provider?: string;
  };
  isActive: boolean;
  childSessions?: Array<{ id: string; claudeSessionId?: string; directory?: string; status: string }>;
  parentSession?: { id: string; claudeSessionId?: string; directory?: string } | null;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  sdkMessageToChatMessage: (msg: Record<string, unknown>, isHistoryReplay?: boolean) => ChatMessage | null;
}

const IMAGE_PATH_RE = /^(\/[^\n]*(?:claude-orchestrator[^/]*images|\.claude-orchestrator\/images)\/[a-f0-9-]+\.[a-z]+)$/i;

export function parseContentWithImages(raw: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let textLines: string[] = [];
  for (const line of raw.split("\n")) {
    const m = line.trim().match(IMAGE_PATH_RE);
    if (m) {
      const text = textLines.join("\n").trim();
      if (text) blocks.push({ type: "text", text });
      textLines = [];
      blocks.push({ type: "image", source: { type: "local-file", path: m[1] } } as ContentBlock);
    } else {
      textLines.push(line);
    }
  }
  const trailing = textLines.join("\n").trim();
  if (trailing) blocks.push({ type: "text", text: trailing });
  return blocks.length > 0 ? blocks : [{ type: "text", text: raw }];
}

/** Shape returned by the get_conversation_messages_tail command */
interface MessagesResult {
  messages: ChatMessage[];
  total: number;
}

export function useHistoryLoader({
  sessionId, session, isActive, childSessions, parentSession,
  setMessages, sdkMessageToChatMessage,
}: HistoryLoaderProps) {
  const lastLoadedClaudeSessionIdRef = useRef<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);

  const childSessionsKey = useMemo(
    () => childSessions?.map(c => `${c.id}:${c.claudeSessionId}`).join(",") ?? "",
    [childSessions]
  );

  useEffect(() => {
    let cancelled = false;

    if (!isActive && lastLoadedClaudeSessionIdRef.current === null) {
      return () => { cancelled = true; };
    }

    const currentClaudeSessionId = session?.claudeSessionId ?? null;
    if (lastLoadedClaudeSessionIdRef.current === currentClaudeSessionId && currentClaudeSessionId !== null) {
      return () => { cancelled = true; };
    }

    async function loadHistory() {
      if (cancelled) return;
      setIsHistoryLoading(true);

      const claudeSessionId = session?.claudeSessionId;
      const dir = session ? jsonlDirectory(session as Parameters<typeof jsonlDirectory>[0]) : "";

      const extractUserText = (content: ContentBlock[]): string =>
        content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .replace(/<file[^>]*>[\s\S]*?<\/file>\s*/g, "")
          .replace(/^📎 .+$/gm, "")
          .replace(/^\/.*claude-orchestrator-images\/.*$/gm, "")
          .trim();

      // Load parent session messages
      let parentMessages: ChatMessage[] = [];
      if (parentSession) {
        if (parentSession.claudeSessionId && parentSession.directory) {
          try {
            const msgs = await invoke<ChatMessage[]>("get_conversation_messages", {
              claudeSessionId: parentSession.claudeSessionId,
              directory: parentSession.directory,
            });
            if (msgs.length > 0) {
              parentMessages = msgs.map(m => ({ ...m, id: `parent-${m.id}`, isParentMessage: true }));
            }
          } catch { }
        }
        if (parentMessages.length === 0) {
          try {
            const histLines = await invoke<string[]>("get_agent_history", { sessionId: parentSession.id });
            if (histLines.length > 0) {
              const parsed = await parseHistoryLines(histLines, sdkMessageToChatMessage);
              parentMessages = parsed.map(m => ({ ...m, id: `parent-${m.id}`, isParentMessage: true }));
            }
          } catch { }
        }
      }

      const filterForkContext = (msgs: ChatMessage[]): ChatMessage[] => {
        if (parentMessages.length === 0) return msgs;
        return msgs.filter(m => {
          if (m.type !== "user") return true;
          const text = m.content.filter(b => b.type === "text").map(b => b.text).join("\n");
          return !text.includes("<fork-context>");
        });
      };

      const mergeMessages = (replayed: ChatMessage[]) => {
        if (cancelled) return;
        setIsHistoryLoading(false);
        replayed = filterForkContext(replayed);
        if (replayed.length > 0) {
          console.log(`[loadHistory] ${sessionId}: ${replayed.length} messages, first=${replayed[0].type}:${replayed[0].id.substring(0, 20)}, last=${replayed[replayed.length - 1].type}:${replayed[replayed.length - 1].id.substring(0, 20)}`);
        }
        setMessages((prev) => {
          lastLoadedClaudeSessionIdRef.current = claudeSessionId ?? null;
          const existingParent = prev.filter(m => m.isParentMessage);
          const existingOwn = prev.filter(m => !m.isParentMessage);
          const finalParent = existingParent.length > 0 ? existingParent : parentMessages;
          const replayedWithStableIds = replayed.map((r) => {
            if (r.type !== "user") return r;
            const rText = extractUserText(r.content);
            const optimistic = existingOwn.find(
              (m) => m.type === "user" && m.id.startsWith("user-") && extractUserText(m.content) === rText
            );
            return optimistic ? { ...r, id: optimistic.id } : r;
          });
          replayed = replayedWithStableIds;
          if (existingOwn.length === 0) return [...finalParent, ...replayed];
          const newMessages = existingOwn.filter((m) => {
            if (replayed.some((r) => r.id === m.id)) return false;
            if (m.type === "user") {
              const mText = extractUserText(m.content);
              if (mText === "Execute the plan." && session?.planContent) {
                return !replayed.some((r) => r.type === "user");
              }
              return !replayed.some((r) => {
                if (r.type !== "user") return false;
                const rText = extractUserText(r.content);
                return rText === mText;
              });
            }
            return true;
          });
          if (newMessages.length === 0) return [...finalParent, ...replayed];
          const replayedIdSet = new Set(replayed.map(r => r.id));
          const existingOwnIds = existingOwn.map(m => m.id);
          const result = [...replayed];
          const newMsgSet = new Set(newMessages.map(m => m.id));
          for (const newMsg of newMessages) {
            const newMsgIdx = existingOwnIds.indexOf(newMsg.id);
            let anchorId: string | null = null;
            for (let i = newMsgIdx - 1; i >= 0; i--) {
              if (replayedIdSet.has(existingOwnIds[i])) { anchorId = existingOwnIds[i]; break; }
            }
            if (anchorId === null) {
              let nextAnchorId: string | null = null;
              for (let i = newMsgIdx + 1; i < existingOwnIds.length; i++) {
                if (replayedIdSet.has(existingOwnIds[i])) { nextAnchorId = existingOwnIds[i]; break; }
              }
              if (nextAnchorId === null) {
                result.push(newMsg);
              } else {
                const nextIdx = result.findIndex(m => m.id === nextAnchorId);
                if (nextIdx === -1) { result.push(newMsg); continue; }
                result.splice(nextIdx, 0, newMsg);
              }
            } else {
              const anchorIdx = result.findIndex(m => m.id === anchorId);
              if (anchorIdx === -1) { result.push(newMsg); continue; }
              let insertIdx = anchorIdx + 1;
              while (insertIdx < result.length && newMsgSet.has(result[insertIdx].id)) insertIdx++;
              result.splice(insertIdx, 0, newMsg);
            }
          }
          return [...finalParent, ...result];
        });
      };

      // Fetch messages from DB
      let tailTotal = 0;
      let tailCount = 0;
      if (claudeSessionId) {
        try {
          const result = await invoke<MessagesResult>("get_conversation_messages_tail", {
            claudeSessionId, directory: dir, maxMessages: 300,
          });
          tailTotal = result.total;
          tailCount = result.messages.length;
          if (result.messages.length > 0) {
            mergeMessages(result.messages);
          }
        } catch { }
      }

      // Fallback to agent history if no DB messages
      if (tailCount === 0) {
        let lines: string[] = [];
        try { lines = await invoke<string[]>("get_agent_history", { sessionId }); } catch { }
        if (lines.length > 0) {
          const replayed = await parseHistoryLines(lines, sdkMessageToChatMessage);
          mergeMessages(replayed);
        } else if (parentMessages.length > 0) {
          mergeMessages([]);
        } else {
          if (!cancelled) setIsHistoryLoading(false);
        }
        return;
      }

      // If tail was truncated, fetch all messages
      if (tailTotal > tailCount && claudeSessionId) {
        try {
          const allMessages = await invoke<ChatMessage[]>("get_conversation_messages", {
            claudeSessionId, directory: dir,
          });
          if (cancelled) return;
          mergeMessages(allMessages);
        } catch { }
      }

      // Load child session messages
      if (childSessions && childSessions.length > 0) {
        for (const child of childSessions) {
          try {
            let childMessages: ChatMessage[] = [];
            if (child.claudeSessionId && child.directory) {
              try {
                childMessages = await invoke<ChatMessage[]>("get_conversation_messages", {
                  claudeSessionId: child.claudeSessionId, directory: child.directory,
                });
              } catch { }
            }
            // Fallback to agent history for child
            if (childMessages.length === 0) {
              try {
                const childLines = await invoke<string[]>("get_agent_history", { sessionId: child.id });
                if (childLines.length > 0) {
                  childMessages = await parseHistoryLines(childLines, sdkMessageToChatMessage);
                }
              } catch { }
            }
            if (cancelled) return;
            if (childMessages.length > 0) {
              const filtered = childMessages.filter(m => {
                if (m.type !== "user") return true;
                const text = m.content.filter(b => b.type === "text").map(b => b.text).join("\n");
                return !text.includes("<fork-context>");
              });
              const taggedChildren = filtered.map(m => ({ ...m, id: `child-${child.id}-${m.id}` }));
              const separator: ChatMessage = {
                id: `child-separator-${child.id}`, type: "system",
                content: [{ type: "text", text: `── Executing plan ──` }], timestamp: Date.now(),
              };
              setMessages((prev) => {
                if (prev.some(m => m.id === separator.id)) return prev;
                return [...prev, separator, ...taggedChildren];
              });
            }
          } catch { }
        }
      }
    }

    loadHistory();
    return () => { cancelled = true; };
  }, [sessionId, session?.claudeSessionId, isActive, childSessionsKey]);

  // Reset loading state when session changes
  useEffect(() => {
    setIsHistoryLoading(false);
  }, [sessionId]);

  return { childSessionsKey, isHistoryLoading };
}
