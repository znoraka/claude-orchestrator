import { useState, useRef, useEffect, useCallback, useMemo, useDeferredValue, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { jsonlDirectory, type Session } from "../types";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getHighlighter, ensureLang, langFromPath } from "./DiffViewer";

// Configure marked once
marked.setOptions({ breaks: true, gfm: true });

interface AgentChatProps {
  sessionId: string;
  isActive: boolean;
  onExit: (exitCode?: number) => void;
  onActivity: () => void;
  onBusyChange?: (isBusy: boolean) => void;
  onDraftChange?: (hasDraft: boolean) => void;
  onClaudeSessionId?: (claudeSessionId: string) => void;
  session?: Session;
  onResume?: () => Promise<void> | void;
  onFork?: (systemPrompt: string) => void;
  currentModel?: string;
  onInputHeightChange?: (height: number) => void;
}

export const MODELS = [
  { id: "claude-opus-4-6", name: "Opus 4.6", desc: "Most capable for complex work" },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6", desc: "Best for everyday tasks" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", desc: "Fastest for quick answers" },
];

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
  // For result messages
  costUsd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface ToolGroup {
  toolUse: ContentBlock;
  toolResult?: ContentBlock;
  blockId: string;
}

interface GroupedBlocks {
  items: Array<{ type: "content"; block: ContentBlock } | { type: "toolGroup"; group: ToolGroup }>;
}

function groupToolBlocks(blocks: ContentBlock[], messageId: string): GroupedBlocks {
  const items: GroupedBlocks["items"] = [];
  const toolResultMap = new Map<string, ContentBlock>();

  // First pass: collect all tool results by their tool_use_id
  for (const block of blocks) {
    if (block.type === "tool_result" && block.tool_use_id) {
      toolResultMap.set(block.tool_use_id, block);
    }
  }

  // Second pass: build grouped items
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "tool_use") {
      const blockId = block.id || `${messageId}-${i}`;
      const toolResult = block.id ? toolResultMap.get(block.id) : undefined;
      items.push({
        type: "toolGroup",
        group: { toolUse: block, toolResult, blockId },
      });
    } else if (block.type === "tool_result") {
      // Skip - already paired with tool_use
      continue;
    } else {
      items.push({ type: "content", block });
    }
  }

  return { items };
}

// ── Chunked history parser (avoids blocking main thread) ─────────────

/** Normalize API content (can be a string or array of blocks) into ContentBlock[] */
function normalizeContent(raw: unknown): ContentBlock[] | null {
  if (Array.isArray(raw)) return raw as ContentBlock[];
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  return null;
}

const PARSE_CHUNK_SIZE = 200;

function parseHistoryLines(
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
                  ? existing.findIndex((b: ContentBlock) => b.type === "text")
                  : block.type === "thinking"
                  ? existing.findIndex((b: ContentBlock) => b.type === "thinking")
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
        } catch {}
      }
      offset = end;
      if (offset < lines.length) {
        // Yield to main thread between chunks
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

// ── Component ────────────────────────────────────────────────────────

const AgentChat = memo(function AgentChat({
  sessionId,
  isActive,
  onExit,
  onActivity,
  onBusyChange,
  onDraftChange,
  onClaudeSessionId,
  session,
  onResume,
  onFork,
  currentModel = "claude-opus-4-6",
  onInputHeightChange,
}: AgentChatProps) {
  const isReadOnly = session?.status === "stopped";
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [images, setImages] = useState<Array<{ id: string; data: string; mediaType: string; name: string }>>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const abortedRef = useRef(false);
  const [currentTodo, setCurrentTodo] = useState<string | null>(null);
  // Tool expansion state: single object to avoid double state updates
  // "expanded" = user manually expanded, "collapsed" = user manually collapsed, undefined = default
  const [toolStates, setToolStates] = useState<Record<string, "expanded" | "collapsed">>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);

  // Report input area height changes to parent (for activity bar positioning)
  useEffect(() => {
    const el = inputAreaRef.current;
    if (!el || !onInputHeightChange) return;
    const ro = new ResizeObserver(() => onInputHeightChange(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onInputHeightChange]);

  // Reset textarea height when text is cleared programmatically
  useEffect(() => {
    if (!inputText && inputRef.current) {
      inputRef.current.style.height = "auto";
    }
  }, [inputText]);

  // Auto-focus textarea when user starts typing anywhere
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.metaKey || e.ctrlKey || e.altKey ||
        e.key.length !== 1 ||
        inputRef.current === document.activeElement ||
        (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA"))
      ) return;
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Slash command autocomplete ─────────────────────────────────────
  const [slashCommands, setSlashCommands] = useState<Array<{ name: string; description: string; source: string }>>([]);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  const partialRef = useRef<ContentBlock[]>([]);
  const currentBlockIndexRef = useRef(-1);
  const mountedRef = useRef(true);
  const pendingPromptConsumedRef = useRef(false);

  // Stable refs for callback props to avoid dependency cascades.
  // These callbacks come from App as inline arrows (new ref every render),
  // so using them directly in useEffect/useCallback deps would cause
  // event listeners to be torn down/recreated on every parent render.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const onClaudeSessionIdRef = useRef(onClaudeSessionId);
  onClaudeSessionIdRef.current = onClaudeSessionId;
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;
  const onForkRef = useRef(onFork);
  onForkRef.current = onFork;
  const currentModelRef = useRef(currentModel);
  currentModelRef.current = currentModel;

  // Sync busy state to parent
  useEffect(() => {
    onBusyChangeRef.current?.(isGenerating);
  }, [isGenerating]);

  // Sync draft state to parent
  useEffect(() => {
    onDraftChangeRef.current?.(inputText.trim().length > 0);
  }, [inputText]);

  // Fetch slash commands for the session's directory
  const sessionDir = session?.directory;
  useEffect(() => {
    if (!sessionDir) return;
    let cancelled = false;

    async function discover() {
      type Cmd = { name: string; description: string; source: string };
      const commands: Cmd[] = [];

      // Local commands handled by the orchestrator (not sent to the SDK)
      const builtins: Cmd[] = [
        { name: "clear", description: "Clear conversation display", source: "built-in" },
        { name: "compact", description: "Compact conversation to save context", source: "built-in" },
      ];

      // Try the dedicated backend command first (fast, scans both project + user dirs)
      try {
        const result = await invoke<Cmd[]>("list_slash_commands", { directory: sessionDir });
        if (!cancelled && result.length > 0) {
          const names = new Set(result.map((c) => c.name));
          setSlashCommands([...result, ...builtins.filter((b) => !names.has(b.name))]);
          return;
        }
      } catch {
        // Command not available yet (app not rebuilt) — fall back to list_files + read_file
      }

      // Fallback: scan .claude/commands/ using existing list_files + read_file commands
      const scanDir = async (cmdDir: string, source: string) => {
        try {
          const files = await invoke<Array<[string, boolean]>>("list_files", { partial: cmdDir });
          for (const [filePath, isDir] of files) {
            if (isDir || !filePath.endsWith(".md")) continue;
            const name = filePath.split("/").pop()!.replace(/\.md$/, "");
            let description = "";
            try {
              const content = await invoke<string>("read_file", { filePath });
              const firstLine = content.split("\n")[0] || "";
              description = firstLine.trim().replace(/^#+\s*/, "");
            } catch {}
            commands.push({ name, description, source });
          }
        } catch {}
      };

      await scanDir(sessionDir + "/.claude/commands/", "project");
      await scanDir("~/.claude/commands/", "user");

      // Merge with built-ins (project/user commands take priority)
      const names = new Set(commands.map((c) => c.name));
      commands.push(...builtins.filter((b) => !names.has(b.name)));

      if (!cancelled) {
        setSlashCommands(commands);
      }
    }

    discover();
    return () => { cancelled = true; };
  }, [sessionDir]);

  // Compute filtered slash commands based on input
  const showSlashMenu = inputText.startsWith("/") && !inputText.includes(" ") && inputText.length > 0;
  const filteredSlashCommands = useMemo(() => {
    if (!showSlashMenu) return [];
    const query = inputText.slice(1).toLowerCase();
    return slashCommands.filter((cmd) => cmd.name.toLowerCase().includes(query));
  }, [showSlashMenu, inputText, slashCommands]);

  // Reset menu index when filtered list changes
  useEffect(() => {
    setSlashMenuIndex(0);
  }, [filteredSlashCommands.length, inputText]);

  // Scroll active slash menu item into view
  useEffect(() => {
    if (!slashMenuRef.current) return;
    const active = slashMenuRef.current.children[slashMenuIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [slashMenuIndex]);

  // ── Throttled streaming updates ─────────────────────────────────
  // Buffer streaming updates and flush at most every 50ms to reduce re-renders.
  // The SDK sends each content block as a SEPARATE event (not accumulated),
  // so we must accumulate blocks for the same message ID.
  const pendingStreamRef = useRef<{ id: string; content: ContentBlock[] } | null>(null);
  const accumulatedBlocksRef = useRef<Map<string, ContentBlock[]>>(new Map());
  const rafIdRef = useRef<number | null>(null);
  const lastFlushRef = useRef<number>(0);
  const STREAM_THROTTLE_MS = 50;

  const flushPendingStream = useCallback(() => {
    rafIdRef.current = null;
    const pending = pendingStreamRef.current;
    if (!pending) return;
    pendingStreamRef.current = null;
    lastFlushRef.current = Date.now();

    const accumulated = accumulatedBlocksRef.current.get(pending.id) || [];

    setMessages((prev) => {
      // Find existing message with same streaming ID
      const existingIndex = prev.findIndex(
        (m) => m.type === "assistant" && m.id === pending.id
      );
      if (existingIndex !== -1) {
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          content: accumulated,
        };
        return updated;
      }
      // New message - append at end
      const filtered = prev.filter((m) => !m.isStreaming);
      return [
        ...filtered,
        {
          id: pending.id,
          type: "assistant",
          content: accumulated,
          timestamp: Date.now(),
        },
      ];
    });
  }, []);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

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

  // Defer heavy message rendering so input stays responsive,
  // but always show trailing (new) messages immediately so sends feel instant.
  const deferredMessages = useDeferredValue(visibleMessages);
  const trailingMessages = useMemo(() => {
    if (deferredMessages === visibleMessages) return [];
    // Find messages at the end of visibleMessages not yet in the deferred snapshot
    const deferredIds = new Set(deferredMessages.map((m) => m.id));
    const trailing: typeof visibleMessages = [];
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (deferredIds.has(visibleMessages[i].id)) break;
      trailing.unshift(visibleMessages[i]);
    }
    return trailing;
  }, [deferredMessages, visibleMessages]);

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
    // Use rAF to scroll after the render has painted
    requestAnimationFrame(() => scrollToBottom());
  }, [deferredMessages, trailingMessages, scrollToBottom]);

  // Focus input and scroll to bottom when becoming active
  useEffect(() => {
    if (isActive) {
      setTimeout(() => inputRef.current?.focus(), 50);
      requestAnimationFrame(() => scrollToBottom());
    }
  }, [isActive, scrollToBottom]);

  // ── Load history on mount ────────────────────────────────────────

  // Track whether initial history has loaded to prevent overwriting new messages.
  // Re-run when claudeSessionId changes (e.g., real SDK session ID replaces pre-assigned UUID).
  const lastLoadedClaudeSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;

    // Skip reload if we already loaded for this exact claudeSessionId.
    // We must reload when claudeSessionId changes because the JSONL path depends on it.
    const currentClaudeSessionId = session?.claudeSessionId ?? null;
    if (lastLoadedClaudeSessionIdRef.current === currentClaudeSessionId && currentClaudeSessionId !== null) {
      return;
    }

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

      // The SDK writes each content block as a separate JSONL line with the same
      // message ID. We must accumulate blocks per message ID to reconstruct
      // complete messages, then deduplicate so only one ChatMessage per API
      // message is shown.
      //
      // Strategy: Process all lines and track which message IDs we've seen.
      // For each unique message (by ID), keep only ONE ChatMessage entry but
      // update its content as we see more blocks. Track insertion order via
      // a Map that preserves order.
      const replayed = await parseHistoryLines(lines, sdkMessageToChatMessage);

      if (replayed.length > 0) {
        console.log(`[loadHistory] ${sessionId}: ${replayed.length} messages, first=${replayed[0].type}:${replayed[0].id.substring(0, 20)}, last=${replayed[replayed.length-1].type}:${replayed[replayed.length-1].id.substring(0, 20)}`);
      }

      setMessages((prev) => {
        lastLoadedClaudeSessionIdRef.current = session?.claudeSessionId ?? null;

        if (prev.length === 0) {
          return replayed;
        }
        const newMessages = prev.filter((m) => {
          // Match by ID first
          if (replayed.some((r) => r.id === m.id)) return false;
          // For user messages, also match by text content to deduplicate
          // live-added messages (from sendMessage) vs replayed ones (from JSONL)
          // which have different IDs
          if (m.type === "user") {
            const mText = m.content.find((b) => b.type === "text")?.text || "";
            return !replayed.some((r) => {
              if (r.type !== "user") return false;
              const rText = r.content.find((b) => b.type === "text")?.text || "";
              return rText === mText;
            });
          }
          return true;
        });
        if (newMessages.length === 0) {
          return replayed;
        }
        return [...replayed, ...newMessages];
      });
    }

    loadHistory();

    return () => {
      mountedRef.current = false;
    };
  }, [sessionId, session?.claudeSessionId]);

  // ── Process SDK messages ─────────────────────────────────────────

  const handleAgentMessage = useCallback((msg: Record<string, unknown>) => {

    const msgType = msg.type as string;

    // System init message — capture the real Claude session ID
    if (msgType === "system" && msg.subtype === "init") {
      const claudeSessionId = msg.session_id as string | undefined;
      if (claudeSessionId && onClaudeSessionIdRef.current) {
        onClaudeSessionIdRef.current(claudeSessionId);
      }
      return;
    }

    if (msgType === "system" && msg.subtype === "bridge_ready") {
      // Set the selected model on the new agent
      if (currentModelRef.current !== "claude-opus-4-6") {
        const setModelMsg = JSON.stringify({ type: "set_model", model: currentModelRef.current });
        invoke("send_agent_message", { sessionId, message: setModelMsg }).catch(() => {});
      }
      // Auto-send pending prompt (e.g. from PR review) once the bridge is ready
      if (session?.pendingPrompt && !pendingPromptConsumedRef.current) {
        pendingPromptConsumedRef.current = true;
        const prompt = session.pendingPrompt;
        // Show user message in chat
        setMessages((prev) => [
          ...prev,
          {
            id: `user-${Date.now()}`,
            type: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ]);
        abortedRef.current = false;
        setIsGenerating(true);
        const jsonLine = JSON.stringify({
          type: "user",
          message: { role: "user", content: prompt },
        });
        invoke("send_agent_message", { sessionId, message: jsonLine }).catch((err) => {
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
        });
      }
      return;
    }

    // Assistant message (may be partial during streaming or final)
    // NOTE: The SDK sends each content block as a SEPARATE event with the same
    // message ID, not as accumulated content. We must merge blocks ourselves.
    if (msgType === "assistant") {
      // Ensure isGenerating is true when we receive streaming content
      // (handles cases where component mounts while agent is already running)
      // But skip if we've already aborted — late events shouldn't re-enable the indicator
      if (!abortedRef.current) {
        setIsGenerating(true);
      }
      const messageObj = msg.message as Record<string, unknown> | undefined;
      const content = normalizeContent(messageObj?.content);
      const apiMsgId = messageObj?.id as string | undefined;
      if (content) {
        // Use a stable ID for this streaming message
        const streamId = apiMsgId || "stream-current";

        // Accumulate blocks for this message ID.
        // Each SDK event typically contains a single block; merge them all.
        const existing = accumulatedBlocksRef.current.get(streamId) || [];
        // Replace blocks by matching type+id (for tool_use updates) or append new ones
        const merged = [...existing];
        for (const block of content) {
          const matchIdx = block.type === "tool_use" && block.id
            ? merged.findIndex((b) => b.type === "tool_use" && b.id === block.id)
            : block.type === "text"
            ? merged.findIndex((b) => b.type === "text")
            : block.type === "thinking"
            ? merged.findIndex((b) => b.type === "thinking")
            : -1;
          if (matchIdx !== -1) {
            merged[matchIdx] = block; // Update existing block in place
          } else {
            merged.push(block);
          }
        }
        accumulatedBlocksRef.current.set(streamId, merged);

        // Buffer the update for throttled flushing
        pendingStreamRef.current = { id: streamId, content: merged };

        // Extract current in-progress todo from TodoWrite tool calls
        for (const block of content) {
          if (block.type === "tool_use" && block.name === "TodoWrite" && block.input) {
            const todos = (block.input as { todos?: Array<{ content: string; status: string; activeForm?: string }> }).todos;
            if (todos) {
              const inProgress = todos.find(t => t.status === "in_progress");
              setCurrentTodo(inProgress?.activeForm || inProgress?.content || null);
            }
          }
        }

        // Throttle: only schedule flush if enough time has passed
        const now = Date.now();
        if (now - lastFlushRef.current >= STREAM_THROTTLE_MS) {
          // Flush immediately
          flushPendingStream();
        } else if (!rafIdRef.current) {
          // Schedule flush on next frame
          rafIdRef.current = requestAnimationFrame(flushPendingStream);
        }
      }
      partialRef.current = [];
      currentBlockIndexRef.current = -1;
      return;
    }

    // Result message
    if (msgType === "result") {
      setIsGenerating(false);
      setCurrentTodo(null);
      accumulatedBlocksRef.current.clear();
      const result = msg as Record<string, unknown>;
      setMessages((prev) => {
        const filtered = prev.filter((m) => !m.isStreaming);
        return [
          ...filtered,
          {
            id: `result-${Date.now()}`,
            type: "result",
            content: [{ type: "text", text: (result.result as string) || "" }],
            timestamp: Date.now(),
            costUsd: result.cost_usd as number | undefined,
            usage: result.usage as { input_tokens?: number; output_tokens?: number } | undefined,
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
      setCurrentTodo(null);
      accumulatedBlocksRef.current.clear();
      return;
    }

    // Abort
    if (msgType === "aborted") {
      setIsGenerating(false);
      setCurrentTodo(null);
      accumulatedBlocksRef.current.clear();
      return;
    }

    // Error
    if (msgType === "error") {
      setIsGenerating(false);
      setCurrentTodo(null);
      accumulatedBlocksRef.current.clear();
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
  }, []);

  // ── Listen to agent events ───────────────────────────────────────
  // Always set up listeners even for stopped sessions, since we may resume them

  useEffect(() => {
    let cancelled = false;
    let unlistenMessageFn: (() => void) | null = null;
    let unlistenExitFn: (() => void) | null = null;

    listen<string>(
      `agent-message-${sessionId}`,
      (event) => {
        if (cancelled || !mountedRef.current) return;
        try {
          const msg = JSON.parse(event.payload);
          handleAgentMessage(msg);
        } catch {}
      }
    ).then((fn) => {
      if (cancelled) {
        fn(); // Already unmounted, clean up immediately
      } else {
        unlistenMessageFn = fn;
      }
    });

    listen<string>(
      `agent-exit-${sessionId}`,
      (event) => {
        if (cancelled || !mountedRef.current) return;
        setIsGenerating(false);
        const code = parseInt(event.payload, 10);
        onExitRef.current(isNaN(code) ? undefined : code);
      }
    ).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlistenExitFn = fn;
      }
    });

    return () => {
      cancelled = true;
      unlistenMessageFn?.();
      unlistenExitFn?.();
    };
  }, [sessionId, handleAgentMessage]);

  // ── Convert SDK messages to ChatMessage ──────────────────────────

  // Detect Task/Agent tool prompts - these are synthetic messages sent to subagents
  // They should not be displayed as user messages since the user didn't type them
  function looksLikeTaskPrompt(text: string): boolean {
    if (!text || text.length < 50) return false;
    const lines = text.split("\n");
    // Task prompts typically have multiple lines with structured instructions
    if (lines.length < 3) return false;
    // Common patterns in Task prompts
    const hasInstructionalPatterns =
      text.includes("Focus on") ||
      text.includes("I need to understand") ||
      text.includes("Return file paths") ||
      text.includes("Return the") ||
      text.includes("Do not") ||
      text.includes("Make sure to") ||
      /thoroughly|comprehensive|investigate|explore|search/i.test(text);
    // Has numbered list (1. 2. etc) which is common in structured prompts
    const hasNumberedList = /^\s*\d+\.\s/m.test(text) && /^\s*[2-9]\.\s/m.test(text);
    // Combination of patterns
    return hasInstructionalPatterns && (hasNumberedList || lines.length >= 5);
  }

  function sdkMessageToChatMessage(msg: Record<string, unknown>, isHistoryReplay = false): ChatMessage | null {
    const msgType = msg.type as string;

    if (msgType === "user") {
      // During live streaming, skip user messages from SDK - they are either:
      // 1. Duplicates of messages already added via sendMessage()
      // 2. Synthetic messages like Task tool prompts
      // Only process user messages during history replay (loading persisted conversations)
      if (!isHistoryReplay) return null;

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
      // Skip messages that look like Task/Agent tool prompts
      const textContent = blocks.find((b) => b.type === "text")?.text || "";
      if (looksLikeTaskPrompt(textContent)) {
        return null;
      }
      return {
        id: `user-${Date.now()}-${Math.random()}`,
        type: "user",
        content: blocks,
        timestamp: Date.now(),
      };
    }

    if (msgType === "assistant") {
      const messageObj = msg.message as Record<string, unknown> | undefined;
      const content = normalizeContent(messageObj?.content);
      if (!content) return null;
      return {
        id: `assistant-${Date.now()}-${Math.random()}`,
        type: "assistant",
        content,
        timestamp: Date.now(),
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

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? inputText).trim();
    if (!text && images.length === 0) return;

    // If editing a previous message, truncate history up to (not including) that message
    if (editingMessageId) {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === editingMessageId);
        return idx >= 0 ? prev.slice(0, idx) : prev;
      });
      setEditingMessageId(null);
    }

    // Handle local-only built-in commands (these don't work through the SDK)
    if (text === "/clear") {
      setMessages([]);
      setInputText("");
      return;
    }
    if (text === "/compact") {
      setInputText("");
      sendMessage("Please provide a brief summary of our conversation so far, then we can continue from that context.");
      return;
    }
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
    abortedRef.current = false;
    setIsGenerating(true);
    onActivityRef.current(); // Update session timestamp when user sends a message

    // If the session is stopped, transparently restart the bridge first
    if (isReadOnly && onResumeRef.current) {
      try {
        await onResumeRef.current();
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
  }, [inputText, images, sessionId, isReadOnly, editingMessageId]);

  const handleAbort = useCallback(() => {
    invoke("abort_agent", { sessionId }).catch(() => {});
    // Immediately clear generating state — don't rely on bridge "aborted" event
    // which may not arrive if the SDK hangs or the abort doesn't propagate cleanly
    abortedRef.current = true;
    setIsGenerating(false);
    setCurrentTodo(null);
    accumulatedBlocksRef.current.clear();
  }, [sessionId]);

  // Answer an AskUserQuestion by sending the answer to the bridge
  const answerQuestion = useCallback((answer: string) => {
    // Send the answer via the ask_user_answer protocol to the bridge,
    // which interrupted the query at the AskUserQuestion tool call.
    const msg = JSON.stringify({ type: "ask_user_answer", answer });
    invoke("send_agent_message", { sessionId, message: msg }).catch(() => {
      // Fallback: if the bridge doesn't support ask_user_answer (older bridge),
      // just put it in the input for the user to send manually
      setInputText(answer);
      inputRef.current?.focus();
    });
    // Show the answer as a user message in the chat
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        type: "user",
        content: [{ type: "text", text: answer }],
        timestamp: Date.now(),
      },
    ]);
  }, [sessionId]);

  // ── Edit / resend a user message ──────────────────────────────────

  const editMessage = useCallback((messageId: string) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || msg.type !== "user") return;
    // Extract text from the message content blocks
    const text = (Array.isArray(msg.content)
      ? msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : typeof msg.content === "string" ? msg.content : ""
    );
    setEditingMessageId(messageId);
    setInputText(text);
    inputRef.current?.focus();
  }, [messages]);

  // ── Fork conversation from a message ───────────────────────────────

  const forkFromMessage = useCallback((messageId: string) => {
    if (!onForkRef.current) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    // Build a transcript of messages up to and including the target
    const transcript = messages.slice(0, idx + 1);
    const lines = transcript.map((m) => {
      const text = Array.isArray(m.content)
        ? m.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
        : "";
      if (m.type === "user") return `Human: ${text}`;
      if (m.type === "assistant") return `Assistant: ${text}`;
      return "";
    }).filter(Boolean);
    const systemPrompt = `This conversation was forked from a previous session. Here is the conversation context up to the fork point:\n\n<fork-context>\n${lines.join("\n\n")}\n</fork-context>\n\nContinue from this context. The user will now send their next message.`;
    onForkRef.current(systemPrompt);
  }, [messages]);

  // ── Retry a user message (resend the same text from that point) ───

  const retryMessage = useCallback((messageId: string) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || msg.type !== "user") return;
    const text = Array.isArray(msg.content)
      ? msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : typeof msg.content === "string" ? msg.content : "";
    // Truncate from this message onward, then resend the same text
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === messageId);
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });
    // Use setTimeout to let the state update before sending
    setTimeout(() => sendMessage(text), 0);
  }, [messages, sendMessage]);

  // ── Copy a message's text content to clipboard ────────────────────

  const copyMessage = useCallback((messageId: string) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg) return;
    const text = Array.isArray(msg.content)
      ? msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : typeof msg.content === "string" ? msg.content : "";
    if (text) navigator.clipboard.writeText(text);
  }, [messages]);

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

  const selectSlashCommand = useCallback((cmd: { name: string }) => {
    setInputText("/" + cmd.name + " ");
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Slash menu navigation
      if (showSlashMenu && filteredSlashCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashMenuIndex((i) => Math.min(i + 1, filteredSlashCommands.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashMenuIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          const cmd = filteredSlashCommands[slashMenuIndex];
          if (e.key === "Enter" && filteredSlashCommands.length === 1) {
            setInputText("");
            sendMessage("/" + cmd.name);
          } else {
            selectSlashCommand(cmd);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setInputText("");
          return;
        }
      }
      if (e.key === "Tab") {
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!isGenerating) {
          sendMessage();
        }
      }
      if (e.key === "Escape" && isGenerating) {
        e.preventDefault();
        handleAbort();
      }
    },
    [sendMessage, isGenerating, handleAbort, showSlashMenu, filteredSlashCommands, slashMenuIndex, selectSlashCommand]
  );

  // ── Toggle tool card expansion ───────────────────────────────────

  const toggleTool = useCallback((blockId: string, isCurrentlyExpanded: boolean) => {
    // Single state update instead of two separate Set updates
    setToolStates((prev) => ({
      ...prev,
      [blockId]: isCurrentlyExpanded ? "collapsed" : "expanded",
    }));
  }, []);

  // ── Render ───────────────────────────────────────────────────────

  // Restore scroll position when tab becomes active again
  const savedScrollRef = useRef<number | null>(null);
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (!isActive && wasActiveRef.current && scrollRef.current) {
      // Becoming inactive — save scroll position
      savedScrollRef.current = scrollRef.current.scrollTop;
    }
    if (isActive && !wasActiveRef.current && scrollRef.current && savedScrollRef.current !== null) {
      // Becoming active — restore scroll position
      scrollRef.current.scrollTop = savedScrollRef.current;
      savedScrollRef.current = null;
    }
    wasActiveRef.current = isActive;
  }, [isActive]);

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 pr-14 py-3 flex flex-col gap-3"
      >
        {/* Skip rendering message DOM for inactive tabs to avoid layout thrash */}
        {isActive ? (
          <>
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

            {deferredMessages.map((msg, idx) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                toolStates={toolStates}
                onToggleTool={toggleTool}
                isLastMessage={idx === deferredMessages.length - 1 && trailingMessages.length === 0}
                onAnswerQuestion={answerQuestion}
                onEdit={editMessage}
                onFork={forkFromMessage}
                onRetry={retryMessage}
                onCopy={copyMessage}
              />
            ))}
            {trailingMessages.map((msg, idx) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                toolStates={toolStates}
                onToggleTool={toggleTool}
                isLastMessage={idx === trailingMessages.length - 1}
                onAnswerQuestion={answerQuestion}
                onEdit={editMessage}
                onFork={forkFromMessage}
                onRetry={retryMessage}
                onCopy={copyMessage}
              />
            ))}

            {isGenerating && (
              <div className="flex items-center gap-2 px-3 py-2">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse [animation-delay:300ms]" />
                </div>
                <span className="text-xs text-[var(--text-tertiary)]">
                  {currentTodo || "Thinking…"}
                </span>
              </div>
            )}
          </>
        ) : null}
      </div>

      {/* Input area */}
      <div className="border-t border-[var(--border-color)] px-4 py-3 relative" ref={inputAreaRef}>
        {/* Slash command autocomplete */}
        {showSlashMenu && filteredSlashCommands.length > 0 && (
          <div
            ref={slashMenuRef}
            className="absolute bottom-full left-0 right-0 mx-4 mb-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg overflow-hidden z-50 max-h-64 overflow-y-auto"
          >
            {filteredSlashCommands.map((cmd, i) => (
              <button
                key={cmd.name}
                className={`w-full text-left px-3 py-2 flex items-baseline gap-4 text-sm transition-colors ${
                  i === slashMenuIndex
                    ? "bg-[var(--accent)]/15 text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                }`}
                onMouseEnter={() => setSlashMenuIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus on textarea
                  selectSlashCommand(cmd);
                }}
              >
                <span className="font-mono text-[var(--accent)] shrink-0">/{cmd.name}</span>
                <span className="text-[var(--text-tertiary)] truncate text-xs">{cmd.description}</span>
                {cmd.source === "user" && (
                  <span className="text-[10px] text-[var(--text-tertiary)] opacity-60 ml-auto shrink-0">(user)</span>
                )}
              </button>
            ))}
          </div>
        )}
        {/* Editing indicator */}
        {editingMessageId && (
          <div className="flex items-center gap-2 mb-2 px-1 py-1.5 text-xs text-[var(--accent)] bg-[var(--accent)]/10 rounded-lg">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            <span className="flex-1">Editing message — send to replace</span>
            <button
              onClick={() => { setEditingMessageId(null); setInputText(""); }}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

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
            placeholder={`Message ${MODELS.find((m) => m.id === currentModel)?.name ?? "Claude"}…`}
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
              onClick={() => sendMessage()}
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
}, (prev, next) => {
  // Callback props are stored in refs inside the component, so we only
  // need to re-render when these data props change:
  return (
    prev.sessionId === next.sessionId &&
    prev.isActive === next.isActive &&
    prev.session === next.session &&
    prev.currentModel === next.currentModel
  );
});

export default AgentChat;

// ── MessageBubble ──────────────────────────────────────────────────

const MessageBubble = memo(function MessageBubble({
  message,
  toolStates,
  onToggleTool,
  isLastMessage,
  onAnswerQuestion,
  onEdit,
  onFork,
  onRetry,
  onCopy,
}: {
  message: ChatMessage;
  toolStates: Record<string, "expanded" | "collapsed">;
  onToggleTool: (id: string, isCurrentlyExpanded: boolean) => void;
  isLastMessage: boolean;
  onAnswerQuestion?: (answer: string) => void;
  onEdit?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  onRetry?: (messageId: string) => void;
  onCopy?: (messageId: string) => void;
}) {
  // Defensive: ensure content is always an array (API can return string)
  const content = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
    ? [{ type: "text", text: message.content } as ContentBlock]
    : (() => {
        console.error("[MessageBubble] message.content is not array or string:", typeof message.content, message);
        return [];
      })();

  if (message.type === "user") {
    // Filter out tool_result blocks (tool plumbing, not user content)
    const visible = content.filter((b) => b.type !== "tool_result");
    if (visible.length === 0) return null;
    return (
      <div className="group flex justify-end items-end gap-1">
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5 mb-1">
          {/* Retry */}
          {onRetry && (
            <button
              onClick={() => onRetry(message.id)}
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              title="Retry from here"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 2v6h-6" />
                <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                <path d="M3 22v-6h6" />
                <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              </svg>
            </button>
          )}
          {/* Fork */}
          {onFork && (
            <button
              onClick={() => onFork(message.id)}
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              title="Fork conversation from here"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 17L17 7" />
                <path d="M7 7h10v10" />
              </svg>
            </button>
          )}
          {/* Edit */}
          {onEdit && (
            <button
              onClick={() => onEdit(message.id)}
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              title="Edit & resend"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          )}
          {/* Copy */}
          {onCopy && (
            <button
              onClick={() => onCopy(message.id)}
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              title="Copy message"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          )}
        </div>
        <div className="max-w-[80%] border border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--text-primary)] rounded-2xl rounded-br-md px-5 py-3">
          {visible.map((block, i) => (
            <ContentBlockView key={i} block={block} isUser />
          ))}
        </div>
      </div>
    );
  }

  if (message.type === "system") {
    return (
      <div className="px-3 py-1.5 text-xs text-[var(--text-tertiary)] italic text-center">
        {content[0]?.text}
      </div>
    );
  }

  if (message.type === "error") {
    return (
      <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
        {content[0]?.text || "Unknown error"}
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

  // Assistant message - group tool blocks for consolidated display
  const grouped = useMemo(
    () => groupToolBlocks(content, message.id),
    [content, message.id]
  );

  // Find the last tool group to determine which should be expanded
  // Only expand the last tool of the last message (and only if it has no result yet)
  const toolGroups = grouped.items.filter(
    (item): item is { type: "toolGroup"; group: ToolGroup } =>
      item.type === "toolGroup"
  );
  const lastToolGroupId =
    isLastMessage && toolGroups.length > 0
      ? toolGroups[toolGroups.length - 1].group.blockId
      : null;

  return (
    <div className="max-w-[95%]">
      <div className="flex flex-col gap-3">
        {grouped.items.map((item, i) => {
          if (item.type === "toolGroup") {
            const { group } = item;
            if (group.toolUse.name === "AskUserQuestion") {
              return (
                <AskUserQuestionBlock
                  key={group.blockId}
                  group={group}
                  onAnswer={onAnswerQuestion}
                />
              );
            }
            const isLast = group.blockId === lastToolGroupId;
            return (
              <ConsolidatedToolGroup
                key={group.blockId}
                group={group}
                isLast={isLast}
                isLastMessage={isLastMessage}
                expanded={toolStates[group.blockId] === "expanded"}
                collapsed={toolStates[group.blockId] === "collapsed"}
                onToggle={(isCurrentlyExpanded) =>
                  onToggleTool(group.blockId, isCurrentlyExpanded)
                }
              />
            );
          }
          return <ContentBlockView key={i} block={item.block} />;
        })}
      </div>
    </div>
  );
});

// ── Link helpers ───────────────────────────────────────────────────

const URL_RE = /(https?:\/\/[^\s<>'")\]]+)/g;

/** Intercept <a> clicks and open in default browser via Tauri */
function handleLinkClick(e: React.MouseEvent<HTMLDivElement>) {
  const target = (e.target as HTMLElement).closest("a");
  if (target?.href) {
    e.preventDefault();
    openUrl(target.href);
  }
}

/** Render plain text with URLs converted to clickable links */
function LinkifiedText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => {
    const result: (string | { url: string })[] = [];
    let lastIndex = 0;
    for (const match of text.matchAll(URL_RE)) {
      if (match.index > lastIndex) result.push(text.slice(lastIndex, match.index));
      result.push({ url: match[0] });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) result.push(text.slice(lastIndex));
    return result;
  }, [text]);

  return (
    <span className={className} onClick={handleLinkClick}>
      {parts.map((p, i) =>
        typeof p === "string" ? p : (
          <a key={i} href={p.url} className="text-[var(--accent)] underline">
            {p.url}
          </a>
        )
      )}
    </span>
  );
}

// ── Markdown rendering (marked + DOMPurify) ────────────────────────

const markedRenderer = new marked.Renderer();

// Open links in new tab
markedRenderer.link = ({ href, text }) =>
  `<a href="${href}" class="text-[var(--accent)] underline" target="_blank" rel="noreferrer">${text}</a>`;

const markedOptions = { renderer: markedRenderer };

function MarkdownContent({ text }: { text: string }) {
  const html = useMemo(() => {
    // Strip CLI XML-like tags (e.g. <command-message-help>, <command-name>)
    // that DOMPurify preserves as valid custom elements
    const cleaned = text.replace(/<\/?[a-z]+-[a-z-]*>/g, "");
    const raw = marked.parse(cleaned, markedOptions) as string;
    return DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
  }, [text]);

  return (
    <div
      className="text-sm text-[var(--text-primary)] prose-agent"
      onClick={handleLinkClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ── Content block rendering ────────────────────────────────────────

function ContentBlockView({ block, isUser }: { block: ContentBlock; isUser?: boolean }) {
  if (block.type === "text" && block.text) {
    if (isUser) {
      return <LinkifiedText text={block.text} className="text-sm whitespace-pre-wrap break-words" />;
    }
    return <MarkdownContent text={block.text} />;
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

function useShikiHighlight(code: string, filePath: string, containerRef: React.RefObject<HTMLElement | null>): HighlightedToken[][] | null {
  const [tokens, setTokens] = useState<HighlightedToken[][] | null>(null);
  const idRef = useRef(0);
  const [isVisible, setIsVisible] = useState(false);

  // Only highlight when visible in viewport
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setIsVisible(true); observer.disconnect(); } },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef]);

  useEffect(() => {
    if (!isVisible || !code) { return; }
    const id = ++idRef.current;
    const lang = langFromPath(filePath);
    if (!lang) {
      setTokens(code.split("\n").map(l => [{ content: l }]));
      return;
    }
    // Use requestIdleCallback to avoid blocking during streaming
    const schedule = window.requestIdleCallback || ((cb: () => void) => setTimeout(cb, 16));
    schedule(async () => {
      const hl = await getHighlighter();
      await ensureLang(hl, lang);
      const result = hl.codeToTokens(code, { lang, theme: "github-dark" });
      if (id === idRef.current) {
        setTokens(result.tokens.map(lineTokens =>
          lineTokens.map(t => ({ content: t.content, color: t.color }))
        ));
      }
    });
  }, [code, filePath, isVisible]);

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
  const containerRef = useRef<HTMLDivElement>(null);
  const oldLines = useMemo(() => oldStr.split("\n"), [oldStr]);
  const newLines = useMemo(() => newStr.split("\n"), [newStr]);
  const oldTokens = useShikiHighlight(oldStr, filePath, containerRef);
  const newTokens = useShikiHighlight(newStr, filePath, containerRef);

  return (
    <div ref={containerRef} className="font-mono text-[11px] leading-[18px] overflow-x-auto">
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
  const containerRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => content.split("\n"), [content]);
  const tokens = useShikiHighlight(content, filePath, containerRef);
  const maxLines = 30;
  const truncated = lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;
  const displayTokens = truncated ? tokens?.slice(0, maxLines) : tokens;

  return (
    <div ref={containerRef} className="font-mono text-[11px] leading-[18px] overflow-x-auto">
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

// ── Todo list view for TodoWrite tool ──────────────────────────────

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

function TodoListView({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="px-3 py-2 space-y-1">
      {todos.map((todo, i) => {
        const statusIcon = todo.status === "completed" ? (
          <svg className="w-3.5 h-3.5 text-green-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        ) : todo.status === "in_progress" ? (
          <svg className="w-3.5 h-3.5 text-blue-400 shrink-0 animate-spin" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="10" cy="10" r="7" strokeOpacity={0.25} />
            <path d="M10 3a7 7 0 016.93 6" strokeLinecap="round" />
          </svg>
        ) : (
          <span className="w-3.5 h-3.5 rounded-full border border-[var(--text-tertiary)] shrink-0" />
        );

        const textColor = todo.status === "completed"
          ? "text-[var(--text-tertiary)] line-through"
          : todo.status === "in_progress"
          ? "text-[var(--text-primary)]"
          : "text-[var(--text-secondary)]";

        return (
          <div key={i} className="flex items-start gap-2">
            <div className="mt-0.5">{statusIcon}</div>
            <span className={`text-xs ${textColor}`}>{todo.content}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Tool input view ────────────────────────────────────────────────

function ToolInputView({ toolName, input }: { toolName: string; input: Record<string, unknown> }) {
  // Render a key-value pair with appropriate formatting
  const renderValue = (key: string, value: unknown) => {
    if (value == null) return null;
    const strVal = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    // For long string values (commands, code), render as a code block
    if (typeof value === "string" && (value.includes("\n") || value.length > 100)) {
      return (
        <div key={key} className="px-3 py-1">
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">{key}</span>
          <pre className="mt-0.5 text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono bg-[var(--bg-tertiary)] rounded px-2 py-1.5 max-h-32 overflow-y-auto">
            {value}
          </pre>
        </div>
      );
    }
    return (
      <div key={key} className="flex gap-2 px-3 py-0.5 items-baseline">
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] shrink-0">{key}</span>
        <span className="text-xs text-[var(--text-secondary)] font-mono truncate">
          <LinkifiedText text={strVal} />
        </span>
      </div>
    );
  };

  // Tool-specific layouts
  switch (toolName) {
    case "Read":
      return (
        <div className="py-1.5">
          {renderValue("path", input.file_path)}
          {input.offset != null ? renderValue("from line", input.offset) : null}
          {input.limit != null ? renderValue("lines", input.limit) : null}
        </div>
      );
    case "Bash":
      return (
        <div className="py-1.5">
          <div className="px-3">
            <pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono bg-[var(--bg-tertiary)] rounded px-2 py-1.5 max-h-48 overflow-y-auto">
              <span className="text-[var(--text-tertiary)] select-none">$ </span>{input.command as string}
            </pre>
          </div>
          {input.timeout != null ? renderValue("timeout", `${input.timeout}ms`) : null}
        </div>
      );
    case "Grep": {
      const ctx = [
        input["-B"] ? `-B ${input["-B"]}` : "",
        input["-A"] ? `-A ${input["-A"]}` : "",
        input["-C"] ? `-C ${input["-C"]}` : "",
      ].filter(Boolean).join(" ");
      return (
        <div className="py-1.5">
          {renderValue("pattern", input.pattern)}
          {input.path != null ? renderValue("path", input.path) : null}
          {input.glob != null ? renderValue("glob", input.glob) : null}
          {input.output_mode != null ? renderValue("mode", input.output_mode) : null}
          {ctx ? renderValue("context", ctx) : null}
        </div>
      );
    }
    case "Glob":
      return (
        <div className="py-1.5">
          {renderValue("pattern", input.pattern)}
          {input.path != null ? renderValue("path", input.path) : null}
        </div>
      );
    case "WebSearch":
      return (
        <div className="py-1.5">
          {renderValue("query", input.query)}
        </div>
      );
    case "WebFetch":
      return (
        <div className="py-1.5">
          {renderValue("url", input.url)}
          {input.prompt != null ? renderValue("prompt", input.prompt) : null}
        </div>
      );
    case "LSP":
      return (
        <div className="py-1.5">
          {renderValue("command", input.command)}
          {input.file_path != null ? renderValue("path", input.file_path) : null}
          {input.query != null ? renderValue("query", input.query) : null}
        </div>
      );
    case "Task":
      return (
        <div className="py-1.5">
          {renderValue("description", input.description)}
          {input.prompt != null ? renderValue("prompt", input.prompt) : null}
        </div>
      );
    default: {
      // Generic: render all key-value pairs cleanly
      const entries = Object.entries(input);
      if (entries.length === 0) return null;
      return (
        <div className="py-1.5">
          {entries.map(([k, v]) => renderValue(k, v))}
        </div>
      );
    }
  }
}

// ── Consolidated tool group ────────────────────────────────────────

// ── AskUserQuestion block ──────────────────────────────────────────

interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

function AskUserQuestionBlock({
  group,
  onAnswer,
}: {
  group: ToolGroup;
  onAnswer?: (answer: string) => void;
}) {
  const input = group.toolUse.input || {};
  const questions = Array.isArray(input.questions) ? (input.questions as AskQuestion[]) : [];
  // Only disable buttons when there's an explicit tool_result for this AskUserQuestion.
  // Unlike other tools, don't infer "has result" from !isLastMessage — the bridge
  // interrupts the query at AskUserQuestion to wait for user input.
  const hasResult = !!group.toolResult;

  // Track selected answer per question index (for multi-question accumulation)
  const [selected, setSelected] = useState<Record<number, string>>({});

  // Fallback: if no structured questions, try to show a simple question string
  if (questions.length === 0) {
    const questionText = (input.question as string) || (input.text as string) || "";
    return (
      <div className="border border-[var(--accent)]/30 rounded-lg px-4 py-3 bg-[var(--accent)]/5">
        <div className="text-xs font-medium text-[var(--accent)] mb-1">Question</div>
        <div className="text-sm text-[var(--text-primary)]">{questionText}</div>
      </div>
    );
  }

  // Single question: send answer immediately on click
  const isSingle = questions.length === 1;

  const handleSelect = (qi: number, label: string) => {
    if (isSingle) {
      onAnswer?.(label);
    } else {
      setSelected((prev) => ({ ...prev, [qi]: label }));
    }
  };

  const allAnswered = !isSingle && questions.every((_, qi) => selected[qi] != null);

  const handleSubmit = () => {
    if (!allAnswered) return;
    const combined = questions
      .map((_, qi) => `${qi + 1}. ${selected[qi]}`)
      .join("\n");
    onAnswer?.(combined);
  };

  return (
    <div className="flex flex-col gap-3">
      {questions.map((q, qi) => (
        <div
          key={qi}
          className="border border-[var(--accent)]/30 rounded-lg overflow-hidden bg-[var(--accent)]/5"
        >
          {q.header && (
            <div className="px-4 pt-3 pb-1 text-xs font-semibold text-[var(--accent)] uppercase tracking-wide">
              {q.header}
            </div>
          )}
          <div className="px-4 py-2 text-sm text-[var(--text-primary)]">
            {q.question}
          </div>
          {q.options && q.options.length > 0 && (
            <div className="px-3 pb-3 flex flex-col gap-1.5">
              {q.options.map((opt, oi) => {
                const isSelected = selected[qi] === opt.label;
                return (
                  <button
                    key={oi}
                    disabled={hasResult}
                    onClick={() => handleSelect(qi, opt.label)}
                    className={`text-left px-3 py-2 rounded-md border text-sm transition-colors ${
                      hasResult
                        ? "border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-tertiary)] cursor-default"
                        : isSelected
                          ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text-primary)] cursor-pointer"
                          : "border-[var(--border-color)] bg-[var(--bg-secondary)] hover:bg-[var(--accent)]/10 hover:border-[var(--accent)]/40 text-[var(--text-primary)] cursor-pointer"
                    }`}
                  >
                    <div className="font-medium">{opt.label}</div>
                    {opt.description && (
                      <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
                        {opt.description}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {!isSingle && !hasResult && (
        <button
          disabled={!allAnswered}
          onClick={handleSubmit}
          className={`self-end px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            allAnswered
              ? "bg-[var(--accent)] text-white hover:bg-[var(--accent)]/90 cursor-pointer"
              : "bg-[var(--bg-secondary)] text-[var(--text-tertiary)] border border-[var(--border-color)] cursor-not-allowed"
          }`}
        >
          Submit answers
        </button>
      )}
    </div>
  );
}

function ConsolidatedToolGroup({
  group,
  isLast,
  isLastMessage,
  expanded,
  collapsed,
  onToggle,
}: {
  group: ToolGroup;
  isLast: boolean;
  isLastMessage: boolean;
  expanded: boolean;
  collapsed: boolean;
  onToggle: (isCurrentlyExpanded: boolean) => void;
}) {
  const toolName = group.toolUse.name || "Unknown tool";
  const input = group.toolUse.input || {};
  // Tool has a result if either:
  // 1. We have an explicit tool_result block matched to it, OR
  // 2. This is not the last message (so Claude must have received the result to continue)
  const hasResult = !!group.toolResult || !isLastMessage;
  const isError = group.toolResult?.is_error;

  // Determine if this should be shown expanded:
  // - Expanded if manually expanded
  // - Expanded if last tool AND still in-progress (no result yet) AND not manually collapsed
  const shouldExpand = expanded || (isLast && !hasResult && !collapsed);

  // Shorten an absolute file path to last N segments
  const shortPath = (p: string, n = 3) => {
    if (!p) return "";
    const segs = p.split("/");
    return segs.length > n ? segs.slice(-n).join("/") : p;
  };

  // Generate a short summary based on tool name and input
  const summary = useMemo(() => {
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
        return shortPath(input.file_path as string);
      case "Edit": {
        const fp = input.file_path as string || "";
        if (input.old_string != null && input.new_string != null) {
          const removed = (input.old_string as string).split("\n").length;
          const added = (input.new_string as string).split("\n").length;
          const short = fp.split("/").slice(-2).join("/");
          return `${short}  −${removed} +${added}`;
        }
        return shortPath(fp);
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
        if (!todos || todos.length === 0) return "";
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
      default: {
        // For unknown tools (e.g. MCP), try to generate a useful summary
        const vals = Object.values(input);
        if (vals.length === 0) return "";
        const first = vals.find(v => typeof v === "string" && (v as string).length > 0) as string | undefined;
        return first ? first.slice(0, 80) : "";
      }
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
      case "Task": return "text-indigo-400";
      case "TodoWrite": return "text-emerald-400";
      default: return "text-[var(--text-secondary)]";
    }
  }, [toolName]);

  // Result content for inline display
  const resultContent = useMemo(() => {
    if (!group.toolResult) return null;
    const content = group.toolResult.content;
    return typeof content === "string" ? content : JSON.stringify(content, null, 2);
  }, [group.toolResult]);

  return (
    <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
      <button
        onClick={() => onToggle(shouldExpand)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
      >
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${shouldExpand ? "rotate-90" : ""}`}
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
        {hasResult && !shouldExpand && (
          <span className={`text-xs ${isError ? "text-red-400" : "text-green-400"}`}>
            {isError ? "✗" : "✓"}
          </span>
        )}
        {!hasResult && !shouldExpand && (
          <span className="w-3 h-3 border-2 border-[var(--text-tertiary)] border-t-transparent rounded-full animate-spin" />
        )}
      </button>
      {shouldExpand && (
        <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)] max-h-48 overflow-y-auto">
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
          ) : toolName === "TodoWrite" && input.todos ? (
            <TodoListView todos={input.todos as TodoItem[]} />
          ) : (
            <ToolInputView toolName={toolName} input={input} />
          )}
          {/* Inline result */}
          {resultContent && (
            <div
              className={`mx-3 mb-2 px-3 py-2 rounded text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto ${
                isError
                  ? "bg-red-500/10 text-red-400 border border-red-500/20"
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
              }`}
              onClick={handleLinkClick}
            >
              <LinkifiedText text={resultContent} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
