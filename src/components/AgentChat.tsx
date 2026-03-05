import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { jsonlDirectory, type Session } from "../types";
import { getHighlighter, ensureLang, langFromPath } from "./DiffViewer";

interface AgentChatProps {
  sessionId: string;
  isActive: boolean;
  onExit: () => void;
  onActivity: () => void;
  onBusyChange?: (isBusy: boolean) => void;
  onClaudeSessionId?: (claudeSessionId: string) => void;
  session?: Session;
  onResume?: () => Promise<void> | void;
}

// ── Message types ────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  // For thinking blocks
  thinking?: string;
}

interface ChatMessage {
  id: string;
  type: "user" | "assistant" | "system" | "result" | "error";
  content: ContentBlock[];
  timestamp: number;
  isStreaming?: boolean;
  // API message ID for deduplicating streaming updates
  apiMessageId?: string;
  // For result messages
  costUsd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

// ── Component ────────────────────────────────────────────────────────

export default function AgentChat({
  sessionId,
  isActive,
  onExit,
  onActivity,
  onClaudeSessionId,
  session,
  onResume,
}: AgentChatProps) {
  const isReadOnly = session?.status === "stopped";
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [images, setImages] = useState<Array<{ id: string; data: string; mediaType: string; name: string }>>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const partialRef = useRef<ContentBlock[]>([]);
  const currentBlockIndexRef = useRef(-1);
  const mountedRef = useRef(true);
  // Track current streaming apiMessageId for result message deduplication
  const currentApiMessageIdRef = useRef<string | null>(null);

  // ── Windowed rendering: only render tail of messages ───────────
  const INITIAL_WINDOW = 40;
  const LOAD_MORE_CHUNK = 40;
  const [renderCount, setRenderCount] = useState(INITIAL_WINDOW);

  // Reset window when messages are bulk-loaded (history replay)
  const prevMsgLenRef = useRef(0);
  useEffect(() => {
    // If messages jumped by more than LOAD_MORE_CHUNK, it's a bulk load — reset window
    if (messages.length - prevMsgLenRef.current > LOAD_MORE_CHUNK) {
      setRenderCount(INITIAL_WINDOW);
    }
    prevMsgLenRef.current = messages.length;
  }, [messages.length]);

  const visibleMessages = useMemo(() => {
    if (messages.length <= renderCount) return messages;
    return messages.slice(messages.length - renderCount);
  }, [messages, renderCount]);

  const hasMore = messages.length > renderCount;

  const loadMore = useCallback(() => {
    setRenderCount((prev) => Math.min(prev + LOAD_MORE_CHUNK, messages.length));
  }, [messages.length]);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Focus input when becoming active
  useEffect(() => {
    if (isActive) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isActive]);

  // ── Load history on mount ────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;

    async function loadHistory() {
      if (!mountedRef.current) return;

      // Always try JSONL first (persisted on disk) — this preserves
      // conversation across bridge restarts (resume).
      let lines: string[] = [];
      if (session?.claudeSessionId) {
        try {
          lines = await invoke<string[]>("get_conversation_jsonl", {
            claudeSessionId: session.claudeSessionId,
            directory: jsonlDirectory(session),
          });
        } catch {}
      }

      // If no JSONL (brand-new session), fall back to in-memory history
      if (lines.length === 0) {
        try {
          lines = await invoke<string[]>("get_agent_history", { sessionId });
        } catch {}
      }

      if (!mountedRef.current) return;
      const replayed: ChatMessage[] = [];
      // Track last index of each apiMessageId to deduplicate streaming updates
      const apiMessageIdLastIndex = new Map<string, number>();

      // First pass: parse all messages and track apiMessageId positions
      const parsedMessages: ChatMessage[] = [];
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          const chatMsg = sdkMessageToChatMessage(msg);
          if (chatMsg) {
            const idx = parsedMessages.length;
            parsedMessages.push(chatMsg);
            if (chatMsg.apiMessageId) {
              apiMessageIdLastIndex.set(chatMsg.apiMessageId, idx);
            }
          }
        } catch {}
      }

      // Second pass: only keep non-duplicated messages (last occurrence of each apiMessageId)
      for (let i = 0; i < parsedMessages.length; i++) {
        const chatMsg = parsedMessages[i];
        if (chatMsg.apiMessageId) {
          // Only include if this is the last occurrence of this apiMessageId
          if (apiMessageIdLastIndex.get(chatMsg.apiMessageId) === i) {
            replayed.push(chatMsg);
          }
        } else {
          replayed.push(chatMsg);
        }
      }
      setMessages(replayed);
    }

    loadHistory();

    return () => {
      mountedRef.current = false;
    };
  }, [sessionId, session?.claudeSessionId]);

  // ── Listen to agent events ───────────────────────────────────────
  // Always set up listeners even for stopped sessions, since we may resume them

  useEffect(() => {
    const unlistenMessage = listen<string>(
      `agent-message-${sessionId}`,
      (event) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(event.payload);
          handleAgentMessage(msg);
        } catch {}
      }
    );

    const unlistenExit = listen<string>(
      `agent-exit-${sessionId}`,
      () => {
        if (!mountedRef.current) return;
        setIsGenerating(false);
        onExit();
      }
    );

    return () => {
      unlistenMessage.then((fn) => fn());
      unlistenExit.then((fn) => fn());
    };
  }, [sessionId, onExit]);

  // ── Process SDK messages ─────────────────────────────────────────

  const handleAgentMessage = useCallback((msg: Record<string, unknown>) => {
    onActivity();

    const msgType = msg.type as string;

    // System init message — capture the real Claude session ID
    if (msgType === "system" && msg.subtype === "init") {
      const claudeSessionId = msg.session_id as string | undefined;
      if (claudeSessionId && onClaudeSessionId) {
        onClaudeSessionId(claudeSessionId);
      }
      return;
    }

    if (msgType === "system" && msg.subtype === "bridge_ready") {
      return;
    }

    // Assistant message (may be partial during streaming or final)
    if (msgType === "assistant") {
      const messageObj = msg.message as Record<string, unknown> | undefined;
      const content = messageObj?.content as ContentBlock[] | undefined;
      // Use the API message ID to deduplicate streaming updates
      const apiMessageId = messageObj?.id as string | undefined;
      // Track current apiMessageId for result deduplication
      if (apiMessageId) {
        currentApiMessageIdRef.current = apiMessageId;
      }
      if (content) {
        setMessages((prev) => {
          // If we have an API message ID, update the existing message in place
          // This handles streaming updates where the same message is sent multiple times
          if (apiMessageId) {
            const existingIndex = prev.findIndex((m) => m.apiMessageId === apiMessageId);
            if (existingIndex !== -1) {
              // Update in place to preserve order
              const updated = [...prev];
              updated[existingIndex] = {
                ...updated[existingIndex],
                content,
                timestamp: Date.now(),
              };
              return updated;
            }
          }
          // New message - append at end
          const filtered = prev.filter((m) => !m.isStreaming);
          return [
            ...filtered,
            {
              id: `assistant-${Date.now()}`,
              type: "assistant",
              content,
              timestamp: Date.now(),
              apiMessageId,
            },
          ];
        });
      }
      partialRef.current = [];
      currentBlockIndexRef.current = -1;
      return;
    }

    // Result message - replace previous result for the same apiMessageId to avoid duplicates
    if (msgType === "result") {
      setIsGenerating(false);
      const result = msg as Record<string, unknown>;
      // Associate this result with the current streaming apiMessageId
      const resultApiMessageId = currentApiMessageIdRef.current;
      setMessages((prev) => {
        // Remove streaming messages AND any previous result for the same apiMessageId
        const filtered = prev.filter((m) => {
          if (m.isStreaming) return false;
          // If this result has an apiMessageId, remove previous results with the same ID
          if (m.type === "result" && resultApiMessageId && m.apiMessageId === resultApiMessageId) {
            return false;
          }
          return true;
        });
        return [
          ...filtered,
          {
            id: `result-${Date.now()}`,
            type: "result",
            content: [{ type: "text", text: (result.result as string) || "" }],
            timestamp: Date.now(),
            costUsd: result.cost_usd as number | undefined,
            usage: result.usage as { input_tokens?: number; output_tokens?: number } | undefined,
            apiMessageId: resultApiMessageId || undefined,
          },
        ];
      });
      partialRef.current = [];
      currentBlockIndexRef.current = -1;
      return;
    }

    // Query complete
    if (msgType === "query_complete") {
      setIsGenerating(false);
      return;
    }

    // Abort
    if (msgType === "aborted") {
      setIsGenerating(false);
      return;
    }

    // Error
    if (msgType === "error") {
      setIsGenerating(false);
      setMessages((prev) => [
        ...prev.filter((m) => !m.isStreaming),
        {
          id: `error-${Date.now()}`,
          type: "error",
          content: [{ type: "text", text: (msg.error as string) || "Unknown error" }],
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    // For all other SDK message types, convert and add
    const chatMsg = sdkMessageToChatMessage(msg);
    if (chatMsg) {
      setMessages((prev) => [...prev, chatMsg]);
    }
  }, [onActivity, onClaudeSessionId]);

  // ── Convert SDK messages to ChatMessage ──────────────────────────

  function sdkMessageToChatMessage(msg: Record<string, unknown>): ChatMessage | null {
    const msgType = msg.type as string;

    if (msgType === "user") {
      const message = msg.message as Record<string, unknown> | undefined;
      const rawContent = message?.content;
      let blocks: ContentBlock[];
      if (typeof rawContent === "string") {
        blocks = [{ type: "text", text: rawContent }];
      } else if (Array.isArray(rawContent)) {
        blocks = rawContent as ContentBlock[];
      } else {
        return null;
      }
      // Skip tool-result-only messages (tool plumbing, not user input)
      if (blocks.every((b) => b.type === "tool_result")) return null;
      return {
        id: `user-${Date.now()}-${Math.random()}`,
        type: "user",
        content: blocks,
        timestamp: Date.now(),
      };
    }

    if (msgType === "assistant") {
      const messageObj = msg.message as Record<string, unknown> | undefined;
      const content = messageObj?.content as ContentBlock[] | undefined;
      const apiMessageId = messageObj?.id as string | undefined;
      if (!content) return null;
      return {
        id: `assistant-${Date.now()}-${Math.random()}`,
        type: "assistant",
        content,
        timestamp: Date.now(),
        apiMessageId,
      };
    }

    if (msgType === "result") {
      return {
        id: `result-${Date.now()}-${Math.random()}`,
        type: "result",
        content: [{ type: "text", text: (msg.result as string) || "" }],
        timestamp: Date.now(),
        costUsd: msg.cost_usd as number | undefined,
        usage: msg.usage as { input_tokens?: number; output_tokens?: number } | undefined,
      };
    }

    if (msgType === "error") {
      return {
        id: `error-${Date.now()}-${Math.random()}`,
        type: "error",
        content: [{ type: "text", text: (msg.error as string) || "Unknown error" }],
        timestamp: Date.now(),
      };
    }

    return null;
  }

  // ── Send message ─────────────────────────────────────────────────

  const sendMessage = useCallback(async () => {
    const text = inputText.trim();
    if (!text && images.length === 0) return;

    // Build content blocks
    let content: unknown;
    if (images.length > 0) {
      const blocks: unknown[] = [];
      for (const img of images) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType,
            data: img.data,
          },
        });
      }
      if (text) {
        blocks.push({ type: "text", text });
      }
      content = blocks;
    } else {
      content = text;
    }

    // Add user message to UI
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      type: "user",
      content: [
        ...images.map((img) => ({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.data },
        })),
        ...(text ? [{ type: "text", text }] : []),
      ],
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInputText("");
    setImages([]);
    setIsGenerating(true);

    // If the session is stopped, transparently restart the bridge first
    if (isReadOnly && onResume) {
      try {
        await onResume();
      } catch (err) {
        setIsGenerating(false);
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            type: "error",
            content: [{ type: "text", text: `Failed to resume session: ${err}` }],
            timestamp: Date.now(),
          },
        ]);
        return;
      }
    }

    // Send to backend
    const jsonLine = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });
    try {
      await invoke("send_agent_message", { sessionId, message: jsonLine });
    } catch (err) {
      setIsGenerating(false);
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          type: "error",
          content: [{ type: "text", text: `Failed to send: ${err}` }],
          timestamp: Date.now(),
        },
      ]);
    }
  }, [inputText, images, sessionId, isReadOnly, onResume]);

  const handleAbort = useCallback(() => {
    invoke("abort_agent", { sessionId }).catch(() => {});
  }, [sessionId]);

  // ── Image paste ──────────────────────────────────────────────────

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;

          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            // data:image/png;base64,xxxx
            const [header, data] = result.split(",");
            const mediaType = header.match(/data:(.*);/)?.[1] || "image/png";
            setImages((prev) => [
              ...prev,
              {
                id: `img-${Date.now()}-${Math.random()}`,
                data,
                mediaType,
                name: file.name || "pasted-image",
              },
            ]);
          };
          reader.readAsDataURL(file);
        }
      }
    },
    []
  );

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  // ── Key handling ─────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!isGenerating) {
          sendMessage();
        }
      }
    },
    [sendMessage, isGenerating]
  );

  // ── Toggle tool card expansion ───────────────────────────────────

  const toggleTool = useCallback((blockId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(blockId)) {
        next.delete(blockId);
      } else {
        next.add(blockId);
      }
      return next;
    });
  }, []);

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3" style={{ display: "flex", flexDirection: "column", gap: "12px" }}
      >
        {messages.length === 0 && !isGenerating && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-[var(--text-tertiary)]">
              Send a message to start the conversation
            </p>
          </div>
        )}

        {hasMore && (
          <button
            onClick={loadMore}
            className="self-center px-3 py-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
          >
            Load {Math.min(LOAD_MORE_CHUNK, messages.length - renderCount)} earlier messages…
          </button>
        )}

        {visibleMessages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            expandedTools={expandedTools}
            onToggleTool={toggleTool}
          />
        ))}

        {isGenerating && (
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse [animation-delay:300ms]" />
            </div>
            <span className="text-xs text-[var(--text-tertiary)]">Thinking…</span>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-[var(--border-color)] px-4 py-3">
        {/* Image thumbnails */}
        {images.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {images.map((img) => (
              <div
                key={img.id}
                className="relative group w-16 h-16 rounded-lg overflow-hidden border border-[var(--border-color)]"
              >
                <img
                  src={`data:${img.mediaType};base64,${img.data}`}
                  className="w-full h-full object-cover"
                />
                <button
                  onClick={() => removeImage(img.id)}
                  className="absolute top-0 right-0 p-0.5 bg-black/60 rounded-bl text-white opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Message Claude…"
            rows={1}
            className="flex-1 resize-none bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--accent)] transition-colors max-h-32 overflow-y-auto"
            style={{ minHeight: "38px" }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
            }}
          />
          {isGenerating ? (
            <button
              onClick={handleAbort}
              className="px-3 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm font-medium transition-colors shrink-0"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={!inputText.trim() && images.length === 0}
              className="px-3 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors shrink-0"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── MessageBubble ──────────────────────────────────────────────────

const MessageBubble = memo(function MessageBubble({
  message,
  expandedTools,
  onToggleTool,
}: {
  message: ChatMessage;
  expandedTools: Set<string>;
  onToggleTool: (id: string) => void;
}) {
  if (message.type === "user") {
    // Filter out tool_result blocks (tool plumbing, not user content)
    const visible = message.content.filter((b) => b.type !== "tool_result");
    if (visible.length === 0) return null;
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] border border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--text-primary)] rounded-2xl rounded-br-md px-5 py-3">
          {visible.map((block, i) => (
            <ContentBlockView key={i} block={block} isUser />
          ))}
        </div>
      </div>
    );
  }

  if (message.type === "error") {
    return (
      <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
        {message.content[0]?.text || "Unknown error"}
      </div>
    );
  }

  if (message.type === "result") {
    const usage = message.usage;
    const cost = message.costUsd;
    if (!usage && !cost) return null;
    return (
      <div className="flex items-center gap-3 px-3 py-1 text-[10px] text-[var(--text-tertiary)]">
        {usage && (
          <span>
            {((usage.input_tokens || 0) + (usage.output_tokens || 0)).toLocaleString()} tokens
          </span>
        )}
        {cost !== undefined && cost > 0 && (
          <span>${cost.toFixed(4)}</span>
        )}
      </div>
    );
  }

  // Assistant message
  return (
    <div className="max-w-[95%] flex flex-col" style={{ gap: "12px" }}>
      {message.content.map((block, i) => {
        const blockId = block.id || `${message.id}-${i}`;
        if (block.type === "tool_use") {
          return (
            <ToolUseCard
              key={blockId}
              block={block}
              blockId={blockId}
              expanded={expandedTools.has(blockId)}
              onToggle={() => onToggleTool(blockId)}
            />
          );
        }
        if (block.type === "tool_result") {
          return <ToolResultCard key={blockId} block={block} />;
        }
        return <ContentBlockView key={i} block={block} />;
      })}
    </div>
  );
});

// ── Content block rendering ────────────────────────────────────────

function ContentBlockView({ block, isUser }: { block: ContentBlock; isUser?: boolean }) {
  if (block.type === "text" && block.text) {
    if (isUser) {
      return (
        <div className="text-sm whitespace-pre-wrap break-words">
          {block.text}
        </div>
      );
    }
    return (
      <div className="text-sm text-[var(--text-primary)] prose-agent">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            pre: ({ children }) => (
              <pre className="bg-[var(--bg-tertiary)] rounded-lg p-3 my-2 overflow-x-auto text-xs font-mono">
                {children}
              </pre>
            ),
            code: ({ children, className }) => {
              const isBlock = className?.startsWith("language-");
              if (isBlock) {
                return <code className="text-[var(--text-primary)]">{children}</code>;
              }
              return (
                <code className="bg-[#2d333b] px-1 py-0.5 rounded text-[var(--text-secondary)]">
                  {children}
                </code>
              );
            },
            p: ({ children }) => <p className="my-3 leading-7">{children}</p>,
            ul: ({ children }) => <ul className="list-disc pl-5 my-3 space-y-1.5">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-5 my-3 space-y-1.5">{children}</ol>,
            li: ({ children }) => <li className="leading-7">{children}</li>,
            h1: ({ children }) => <h1 className="text-lg font-bold mt-3 mb-1">{children}</h1>,
            h2: ({ children }) => <h2 className="text-base font-bold mt-3 mb-1">{children}</h2>,
            h3: ({ children }) => <h3 className="text-sm font-bold mt-2 mb-1">{children}</h3>,
            strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
            a: ({ href, children }) => (
              <a href={href} className="text-[var(--accent)] underline" target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
            blockquote: ({ children }) => (
              <blockquote className="border-l-2 border-[var(--border-color)] pl-3 my-2 text-[var(--text-secondary)]">
                {children}
              </blockquote>
            ),
            table: ({ children }) => (
              <div className="overflow-x-auto my-2">
                <table className="text-xs border-collapse border border-[var(--border-color)]">{children}</table>
              </div>
            ),
            th: ({ children }) => (
              <th className="border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 py-1 text-left font-medium">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="border border-[var(--border-color)] px-2 py-1">{children}</td>
            ),
          }}
        >
          {block.text}
        </ReactMarkdown>
      </div>
    );
  }

  if (block.type === "thinking" && block.thinking) {
    return (
      <details className="text-xs text-[var(--text-tertiary)] mb-1">
        <summary className="cursor-pointer hover:text-[var(--text-secondary)] select-none">
          Thinking…
        </summary>
        <div className="mt-1 pl-3 border-l border-[var(--border-color)] whitespace-pre-wrap">
          {block.thinking}
        </div>
      </details>
    );
  }

  if (block.type === "image" && block.source) {
    const src = block.source.type === "base64"
      ? `data:${block.source.media_type};base64,${block.source.data}`
      : block.source.url;
    return (
      <img
        src={src}
        className="max-w-full max-h-64 rounded-lg my-1"
        alt="Attached image"
      />
    );
  }

  return null;
}

// ── Syntax-highlighted diff for Edit/Write tools ──────────────────

interface HighlightedToken {
  content: string;
  color?: string;
}

function useShikiHighlight(code: string, filePath: string): HighlightedToken[][] | null {
  const [tokens, setTokens] = useState<HighlightedToken[][] | null>(null);
  const idRef = useRef(0);

  useEffect(() => {
    if (!code) { setTokens(null); return; }
    const id = ++idRef.current;
    const lang = langFromPath(filePath);
    if (!lang) {
      setTokens(code.split("\n").map(l => [{ content: l }]));
      return;
    }
    (async () => {
      const hl = await getHighlighter();
      await ensureLang(hl, lang);
      const result = hl.codeToTokens(code, { lang, theme: "github-dark" });
      if (id === idRef.current) {
        setTokens(result.tokens.map(lineTokens =>
          lineTokens.map(t => ({ content: t.content, color: t.color }))
        ));
      }
    })();
  }, [code, filePath]);

  return tokens;
}

function TokenLine({ tokens }: { tokens: HighlightedToken[] }) {
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} style={t.color ? { color: t.color } : undefined}>
          {t.content}
        </span>
      ))}
    </>
  );
}

function EditDiffView({ filePath, oldStr, newStr }: {
  filePath: string;
  oldStr: string;
  newStr: string;
}) {
  const oldLines = useMemo(() => oldStr.split("\n"), [oldStr]);
  const newLines = useMemo(() => newStr.split("\n"), [newStr]);
  const oldTokens = useShikiHighlight(oldStr, filePath);
  const newTokens = useShikiHighlight(newStr, filePath);

  return (
    <div className="font-mono text-[11px] leading-[18px] overflow-x-auto">
      <table style={{ minWidth: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {oldLines.map((line, i) => (
            <tr key={`old-${i}`} className="bg-red-500/10">
              <td className="text-red-400/60 w-5 text-center select-none pr-1 align-top">−</td>
              <td className="whitespace-pre text-red-300/80">
                {oldTokens?.[i] ? (
                  <span className="opacity-70"><TokenLine tokens={oldTokens[i]} /></span>
                ) : (
                  line
                )}
              </td>
            </tr>
          ))}
          {newLines.map((line, i) => (
            <tr key={`new-${i}`} className="bg-green-500/15">
              <td className="text-green-400/60 w-5 text-center select-none pr-1 align-top">+</td>
              <td className="whitespace-pre">
                {newTokens?.[i] ? (
                  <TokenLine tokens={newTokens[i]} />
                ) : (
                  <span className="text-green-300">{line}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WriteContentView({ filePath, content }: {
  filePath: string;
  content: string;
}) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const tokens = useShikiHighlight(content, filePath);
  const maxLines = 30;
  const truncated = lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;
  const displayTokens = truncated ? tokens?.slice(0, maxLines) : tokens;

  return (
    <div className="font-mono text-[11px] leading-[18px] overflow-x-auto">
      <table style={{ minWidth: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {displayLines.map((line, i) => (
            <tr key={i}>
              <td className="text-[var(--text-tertiary)] w-8 text-right select-none pr-2 align-top opacity-50">
                {i + 1}
              </td>
              <td className="whitespace-pre">
                {displayTokens?.[i] ? (
                  <TokenLine tokens={displayTokens[i]} />
                ) : (
                  <span className="text-[var(--text-secondary)]">{line}</span>
                )}
              </td>
            </tr>
          ))}
          {truncated && (
            <tr>
              <td colSpan={2} className="text-[var(--text-tertiary)] text-center py-1 text-[10px]">
                … {lines.length - maxLines} more lines
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Tool use card ──────────────────────────────────────────────────

function ToolUseCard({
  block,
  expanded,
  onToggle,
}: {
  block: ContentBlock;
  blockId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const toolName = block.name || "Unknown tool";
  const input = block.input || {};

  // Generate a short summary based on tool name and input
  const summary = useMemo(() => {
    switch (toolName) {
      case "Read":
        return input.file_path as string || "";
      case "Write":
        return input.file_path as string || "";
      case "Edit": {
        const fp = input.file_path as string || "";
        if (input.old_string != null && input.new_string != null) {
          const removed = (input.old_string as string).split("\n").length;
          const added = (input.new_string as string).split("\n").length;
          const short = fp.split("/").slice(-2).join("/");
          return `${short}  −${removed} +${added}`;
        }
        return fp;
      }
      case "Bash":
        return (input.command as string)?.slice(0, 80) || "";
      case "Glob":
        return input.pattern as string || "";
      case "Grep":
        return input.pattern as string || "";
      case "WebSearch":
        return input.query as string || "";
      case "WebFetch":
        return input.url as string || "";
      case "Agent":
        return input.description as string || "";
      default:
        return "";
    }
  }, [toolName, input]);

  // Tool icon colors
  const toolColor = useMemo(() => {
    switch (toolName) {
      case "Read": return "text-blue-400";
      case "Write": return "text-green-400";
      case "Edit": return "text-yellow-400";
      case "Bash": return "text-orange-400";
      case "Glob": return "text-purple-400";
      case "Grep": return "text-pink-400";
      case "WebSearch": case "WebFetch": return "text-cyan-400";
      case "Agent": return "text-indigo-400";
      default: return "text-[var(--text-secondary)]";
    }
  }, [toolName]);

  return (
    <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
      >
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span className={`text-xs font-medium ${toolColor}`}>{toolName}</span>
        {summary && (
          <span className="text-xs text-[var(--text-tertiary)] truncate flex-1 font-mono">
            {summary}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)]">
          {toolName === "Edit" && input.file_path && input.old_string != null && input.new_string != null ? (
            <div className="py-1">
              <EditDiffView
                filePath={input.file_path as string}
                oldStr={input.old_string as string}
                newStr={input.new_string as string}
              />
            </div>
          ) : toolName === "Write" && input.file_path && input.content ? (
            <div className="py-1">
              <WriteContentView
                filePath={input.file_path as string}
                content={input.content as string}
              />
            </div>
          ) : (
            <pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words overflow-x-auto font-mono px-3 py-2">
              {JSON.stringify(input, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tool result card ───────────────────────────────────────────────

function ToolResultCard({ block }: { block: ContentBlock }) {
  const isError = block.is_error;
  const content = typeof block.content === "string"
    ? block.content
    : JSON.stringify(block.content, null, 2);

  if (!content) return null;

  return (
    <div
      className={`px-3 py-2 rounded text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto ${
        isError
          ? "bg-red-500/10 text-red-400 border border-red-500/20"
          : "bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
      }`}
    >
      {content}
    </div>
  );
}
