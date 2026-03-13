import { useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
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

export function useHistoryLoader({
  sessionId, session, isActive, childSessions, parentSession,
  setMessages, sdkMessageToChatMessage,
}: HistoryLoaderProps) {
  const lastLoadedClaudeSessionIdRef = useRef<string | null>(null);

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

      let parentMessages: ChatMessage[] = [];
      if (parentSession) {
        if (parentSession.claudeSessionId && parentSession.directory) {
          try {
            const parentLines = await invoke<string[]>("get_conversation_jsonl", {
              claudeSessionId: parentSession.claudeSessionId,
              directory: parentSession.directory,
            });
            if (parentLines.length > 0) {
              const parsed = await parseHistoryLines(parentLines, sdkMessageToChatMessage);
              parentMessages = parsed.map(m => ({ ...m, id: `parent-${m.id}`, isParentMessage: true }));
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
        replayed = filterForkContext(replayed);
        if (replayed.length > 0) {
          console.log(`[loadHistory] ${sessionId}: ${replayed.length} messages, first=${replayed[0].type}:${replayed[0].id.substring(0, 20)}, last=${replayed[replayed.length - 1].type}:${replayed[replayed.length - 1].id.substring(0, 20)}`);
        }
        setMessages((prev) => {
          lastLoadedClaudeSessionIdRef.current = claudeSessionId ?? null;
          const existingParent = prev.filter(m => m.isParentMessage);
          const existingOwn = prev.filter(m => !m.isParentMessage);
          const finalParent = existingParent.length > 0 ? existingParent : parentMessages;
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
          return [...finalParent, ...replayed, ...newMessages];
        });
      };

      let tailTotal = 0;
      let tailLineCount = 0;
      if (claudeSessionId) {
        try {
          const tail = await invoke<{ lines: string[]; total: number }>("get_conversation_jsonl_tail", {
            claudeSessionId, directory: dir, maxLines: 300,
          });
          tailTotal = tail.total;
          tailLineCount = tail.lines.length;
          if (tail.lines.length > 0) {
            const replayed = await parseHistoryLines(tail.lines, sdkMessageToChatMessage);
            mergeMessages(replayed);
          }
        } catch { }
      }

      if (tailLineCount === 0) {
        let lines: string[] = [];
        try { lines = await invoke<string[]>("get_agent_history", { sessionId }); } catch { }
        if (lines.length > 0) {
          const replayed = await parseHistoryLines(lines, sdkMessageToChatMessage);
          mergeMessages(replayed);
        } else if (parentMessages.length > 0) {
          mergeMessages([]);
        }
        return;
      }

      if (tailTotal > tailLineCount && claudeSessionId) {
        try {
          const allLines = await invoke<string[]>("get_conversation_jsonl", { claudeSessionId, directory: dir });
          if (cancelled) return;
          const replayed = await parseHistoryLines(allLines, sdkMessageToChatMessage);
          mergeMessages(replayed);
        } catch { }
      }

      if (childSessions && childSessions.length > 0) {
        for (const child of childSessions) {
          try {
            let childLines: string[] = [];
            if (child.claudeSessionId && child.directory) {
              try {
                childLines = await invoke<string[]>("get_conversation_jsonl", {
                  claudeSessionId: child.claudeSessionId, directory: child.directory,
                });
              } catch { }
            }
            if (childLines.length === 0) {
              try { childLines = await invoke<string[]>("get_agent_history", { sessionId: child.id }); } catch { }
            }
            if (cancelled) return;
            if (childLines.length > 0) {
              const parsed = await parseHistoryLines(childLines, sdkMessageToChatMessage);
              const filtered = parsed.filter(m => {
                if (m.type !== "user") return true;
                const text = m.content.filter(b => b.type === "text").map(b => b.text).join("\n");
                return !text.includes("<fork-context>");
              });
              const childMessages = filtered.map(m => ({ ...m, id: `child-${child.id}-${m.id}` }));
              const separator: ChatMessage = {
                id: `child-separator-${child.id}`, type: "system",
                content: [{ type: "text", text: `── Executing plan ──` }], timestamp: Date.now(),
              };
              setMessages((prev) => {
                if (prev.some(m => m.id === separator.id)) return prev;
                return [...prev, separator, ...childMessages];
              });
            }
          } catch { }
        }
      }
    }

    loadHistory();
    return () => { cancelled = true; };
  }, [sessionId, session?.claudeSessionId, isActive, childSessionsKey]);

  return { childSessionsKey };
}
