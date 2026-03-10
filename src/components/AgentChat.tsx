import { useState, useRef, useEffect, useCallback, useMemo, useDeferredValue, memo } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { jsonlDirectory, modelsForProvider, type Session } from "../types";
import { openUrl } from "@tauri-apps/plugin-opener";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { getHighlighter, ensureLang, langFromPath } from "./DiffViewer";
import FilePickerModal, { type FileReference } from "./FilePickerModal";

// Configure marked once
marked.setOptions({ breaks: true, gfm: true });

interface AgentChatProps {
  sessionId: string;
  isActive: boolean;
  onExit: (exitCode?: number) => void;
  onActivity: () => void;
  onBusyChange?: (isBusy: boolean) => void;
  onUsageUpdate?: (usage: import("../types").SessionUsage) => void;
  onDraftChange?: (hasDraft: boolean) => void;
  onQuestionChange?: (hasQuestion: boolean) => void;
  onClaudeSessionId?: (claudeSessionId: string) => void;
  session?: Session;
  onResume?: () => Promise<void> | void;
  onFork?: (systemPrompt: string) => void;
  onForkWithPrompt?: (systemPrompt: string, pendingPrompt: string, planContent?: string) => Promise<string>;
  currentModel?: string;
  onModelChange?: (modelId: string) => void;
  activeModels?: import("../types").ModelOption[];
  onInputHeightChange?: (height: number) => void;
  onEditFile?: (filePath: string, line?: number) => void;
  onAvailableModels?: (models: Array<{ id: string; providerID: string; name: string; free: boolean; costIn: number; costOut: number }>) => void;
  onRename?: (name: string) => void;
  onMarkTitleGenerated?: () => void;
  onClearPendingPrompt?: () => void;
  onNavigateToSession?: (sessionId: string) => void;
  onPermissionModeChange?: (mode: "bypassPermissions" | "plan") => void;
  parentSession?: { id: string; name: string; claudeSessionId?: string; directory?: string } | null;
  childSessions?: Array<{ id: string; name: string; claudeSessionId?: string; directory?: string; status: string }>;
}

/** @deprecated Use modelsForProvider(provider) from types.ts instead */
export const MODELS = modelsForProvider("claude-code");

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
  durationMs?: number;
  forkSessionId?: string;
  forkSessionName?: string;
  isParentMessage?: boolean;
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

  // Collect tool_use IDs to hide (e.g. ToolSearch — internal plumbing, no user value)
  const hiddenToolIds = new Set<string>();
  for (const block of blocks) {
    if (block.type === "tool_use" && (block.name === "ToolSearch" || block.name === "AskUserQuestion" || block.name === "question") && block.id) {
      hiddenToolIds.add(block.id);
    }
  }

  // Second pass: build grouped items
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "tool_use") {
      if (hiddenToolIds.has(block.id || "")) continue;
      const blockId = block.id || `${messageId}-${i}`;
      const toolResult = block.id ? toolResultMap.get(block.id) : undefined;
      items.push({
        type: "toolGroup",
        group: { toolUse: block, toolResult, blockId },
      });
    } else if (block.type === "tool_result") {
      // Skip - already paired with tool_use (or hidden)
      continue;
    } else {
      items.push({ type: "content", block });
    }
  }

  return { items };
}

interface ToolBundle {
  id: string;
  groups: ToolGroup[];
  toolCounts: Record<string, number>;
  allDone: boolean;
  anyError: boolean;
}

type BundledItem =
  | { type: "content"; block: ContentBlock }
  | { type: "toolGroup"; group: ToolGroup }
  | { type: "toolBundle"; bundle: ToolBundle };

const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read", write: "Write", edit: "Edit", bash: "Bash",
  glob: "Glob", grep: "Grep", websearch: "WebSearch", webfetch: "WebFetch",
  task: "Task", todowrite: "TodoWrite", lsp: "LSP", agent: "Agent",
};

function canonicalToolName(raw: string): string {
  return TOOL_NAME_MAP[raw.toLowerCase()] || raw;
}

function bundleConsecutiveToolGroups(grouped: GroupedBlocks, isLastMessage: boolean): BundledItem[] {
  const result: BundledItem[] = [];
  let currentRun: ToolGroup[] = [];

  function flushRun() {
    if (currentRun.length === 0) return;
    if (currentRun.length === 1) {
      result.push({ type: "toolGroup", group: currentRun[0] });
    } else {
      const toolCounts: Record<string, number> = {};
      let allDone = true;
      let anyError = false;
      for (const g of currentRun) {
        const name = canonicalToolName(g.toolUse.name || "Unknown");
        toolCounts[name] = (toolCounts[name] || 0) + 1;
        if (!g.toolResult && isLastMessage) allDone = false;
        if (g.toolResult?.is_error) anyError = true;
      }
      result.push({
        type: "toolBundle",
        bundle: {
          id: `bundle-${currentRun[0].blockId}`,
          groups: currentRun,
          toolCounts,
          allDone,
          anyError,
        },
      });
    }
    currentRun = [];
  }

  for (const item of grouped.items) {
    if (item.type === "toolGroup") {
      currentRun.push(item.group);
    } else if (
      item.type === "content" &&
      (item.block.type === "thinking" ||
       item.block.type === "redacted_thinking" ||
       (item.block.type === "text" && (!item.block.text || !item.block.text.trim())))
    ) {
      // Thinking blocks, redacted_thinking blocks, and empty text blocks don't end a tool run
      result.push(item);
    } else {
      flushRun();
      result.push(item);
    }
  }
  flushRun();
  return result;
}

// ── Merge consecutive tool-only assistant messages ────────────────────
// Serial tool calls produce: assistant(tool_use) → user(tool_result) → assistant(tool_use) → ...
// This merges those into a single virtual assistant message so bundling works across turns.

const NON_VISUAL_BLOCK_TYPES = new Set(["redacted_thinking", "tool_result"]);

function isToolOnlyAssistant(msg: ChatMessage): boolean {
  if (msg.type !== "assistant") return false;
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  return blocks.every(
    (b) =>
      b.type === "tool_use" ||
      NON_VISUAL_BLOCK_TYPES.has(b.type) ||
      (b.type === "text" && (!b.text || !b.text.trim()))
  );
}

function isToolResultOnlyUser(msg: ChatMessage): boolean {
  if (msg.type !== "user") return false;
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  return blocks.length > 0 && blocks.every((b) => b.type === "tool_result");
}

function mergeToolOnlyMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Start a merge run if this is a tool-only assistant message
    if (isToolOnlyAssistant(msg)) {
      const mergedContent: ContentBlock[] = [...(Array.isArray(msg.content) ? msg.content : [])];
      let lastAssistant = msg;
      let j = i + 1;

      // Keep merging: user(tool_result) → assistant pairs
      // Tool-only assistants continue the run; an assistant with text ends the run but is included
      while (j + 1 < messages.length) {
        const userMsg = messages[j];
        const nextAssistant = messages[j + 1];
        if (
          isToolResultOnlyUser(userMsg) &&
          nextAssistant.type === "assistant"
        ) {
          mergedContent.push(...(Array.isArray(userMsg.content) ? userMsg.content : []));
          mergedContent.push(...(Array.isArray(nextAssistant.content) ? nextAssistant.content : []));
          lastAssistant = nextAssistant;
          j += 2;
          // If the assistant message had visible text, stop merging here
          if (!isToolOnlyAssistant(nextAssistant)) break;
        } else {
          break;
        }
      }

      if (j > i + 1) {
        // We merged multiple messages — create a virtual combined message
        result.push({
          ...msg,
          content: mergedContent,
          isStreaming: lastAssistant.isStreaming,
        });
        i = j - 1; // skip consumed messages
      } else {
        result.push(msg);
      }
    } else {
      result.push(msg);
    }
  }

  return result;
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


const normaliseWs = (s: string) => s.replace(/\s+/g, " ").trim();

// ── Component ────────────────────────────────────────────────────────

const AgentChat = memo(function AgentChat({
  sessionId,
  isActive,
  onExit,
  onActivity,
  onBusyChange,
  onUsageUpdate,
  onDraftChange,
  onQuestionChange,
  onClaudeSessionId,
  session,
  onResume,
  onFork,
  onForkWithPrompt,
  currentModel = "claude-opus-4-6",
  onModelChange,
  activeModels: activeModelsProp,
  onInputHeightChange,
  onAvailableModels,
  onRename,
  onMarkTitleGenerated,
  onClearPendingPrompt,
  onNavigateToSession,
  onPermissionModeChange,
  parentSession,
  childSessions,
}: AgentChatProps) {
  const isReadOnly = session?.status === "stopped";
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [images, setImages] = useState<Array<{ id: string; data: string; mediaType: string; name: string }>>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const abortedRef = useRef(false);
  const generationStartRef = useRef<number>(0);
  const isGeneratingRef = useRef(false);
  const isGeneratingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopGenerating = useCallback(() => {
    if (isGeneratingTimeoutRef.current) {
      clearTimeout(isGeneratingTimeoutRef.current);
    }
    isGeneratingTimeoutRef.current = setTimeout(() => {
      isGeneratingRef.current = false;
      setIsGenerating(false);
    }, 150);
  }, []);
  const [currentTodo, setCurrentTodo] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<{ toolName: string; input: Record<string, unknown> } | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<{ blockId: string; questions: AskQuestion[] } | null>(null);
  // Tool expansion state: single object to avoid double state updates
  // "expanded" = user manually expanded, "collapsed" = user manually collapsed, undefined = default
  const [toolStates, setToolStates] = useState<Record<string, "expanded" | "collapsed">>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [fileReferences, setFileReferences] = useState<FileReference[]>([]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [viewingFileRef, setViewingFileRef] = useState<FileReference | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">("high");
  const [openPill, setOpenPill] = useState<"model" | "mode" | "effort" | null>(null);
  const pillRowRef = useRef<HTMLDivElement>(null);
  const [modelSearchTerm, setModelSearchTerm] = useState("");
  const modelSearchRef = useRef<HTMLInputElement>(null);

  const activeModels = activeModelsProp || modelsForProvider(session?.provider || "claude-code");

  const filteredModels = useMemo(() => {
    if (!modelSearchTerm) return activeModels;
    const term = modelSearchTerm.toLowerCase();
    return activeModels.filter(m =>
      m.name.toLowerCase().includes(term) ||
      m.id.toLowerCase().includes(term) ||
      m.desc?.toLowerCase().includes(term)
    );
  }, [activeModels, modelSearchTerm]);

  // For parent sessions with children: route input to the active child
  const activeChildSessionId = useMemo(
    () => childSessions?.find(c => c.status === "running" || c.status === "starting")?.id ?? null,
    [childSessions]
  );
  const targetSessionId = activeChildSessionId ?? sessionId;
  // Accumulated usage for bridge-based sessions (OpenCode) — reported to parent for context bar
  const accumulatedUsageRef = useRef({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, contextTokens: 0 });
  const onUsageUpdateRef = useRef(onUsageUpdate);
  onUsageUpdateRef.current = onUsageUpdate;
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);

  // Close pill dropdown on outside click
  useEffect(() => {
    if (!openPill) {
      setModelSearchTerm("");
      return;
    }
    if (openPill === "model") {
      // Small timeout to allow the dropdown to render before focusing
      setTimeout(() => modelSearchRef.current?.focus(), 50);
    }
    const handleClick = (e: MouseEvent) => {
      if (pillRowRef.current && !pillRowRef.current.contains(e.target as Node)) {
        setOpenPill(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [openPill]);

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

  const sessionDir = session?.directory;

  // ── Cmd+O to open file picker ────────────────────────────────────
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "o") {
        e.preventDefault();
        setShowFilePicker(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isActive]);

  const addFileReference = useCallback((ref: FileReference) => {
    setFileReferences((prev) => {
      // Replace if same file already referenced
      const existing = prev.findIndex((r) => r.filePath === ref.filePath);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = ref;
        return next;
      }
      return [...prev, ref];
    });
    inputRef.current?.focus();
  }, []);

  const removeFileReference = useCallback((filePath: string) => {
    setFileReferences((prev) => prev.filter((r) => r.filePath !== filePath));
  }, []);

  // ── Current git branch (fetch once, no polling — useWorktreeBranches handles periodic updates) ──
  const [currentBranch, setCurrentBranch] = useState("");
  useEffect(() => {
    if (!sessionDir) return;
    let cancelled = false;
    invoke<{ branch: string; files: unknown[]; is_git_repo: boolean }>("get_git_status", { directory: sessionDir })
      .then((result) => { if (!cancelled && result.is_git_repo) setCurrentBranch(result.branch); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionDir]);

  // ── @ file autocomplete ────────────────────────────────────────────
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const [fileMenuIndex, setFileMenuIndex] = useState(0);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const fileSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Detect @query in inputText: find the last "@" that starts a mention
  const atMention = useMemo(() => {
    // Find the last "@" not preceded by a non-space character
    const idx = inputText.lastIndexOf("@");
    if (idx < 0) return null;
    // "@" must be at start or preceded by whitespace
    if (idx > 0 && inputText[idx - 1] !== " " && inputText[idx - 1] !== "\n") return null;
    const query = inputText.slice(idx + 1);
    // Close menu if there's a space after a completed path (user moved on)
    if (query.includes(" ")) return null;
    return { index: idx, query };
  }, [inputText]);

  const showFileMenu = atMention !== null && fileSuggestions.length > 0;

  // Debounced search for project files when @query changes
  useEffect(() => {
    if (fileSearchTimerRef.current) clearTimeout(fileSearchTimerRef.current);
    if (!atMention || !sessionDir) {
      setFileSuggestions([]);
      return;
    }
    fileSearchTimerRef.current = setTimeout(async () => {
      try {
        const results = await invoke<string[]>("search_project_files", {
          directory: sessionDir,
          query: atMention.query,
        });
        setFileSuggestions(results);
        setFileMenuIndex(0);
      } catch {
        setFileSuggestions([]);
      }
    }, atMention.query.length === 0 ? 0 : 100);
    return () => {
      if (fileSearchTimerRef.current) clearTimeout(fileSearchTimerRef.current);
    };
  }, [atMention?.query, sessionDir]);

  // Scroll active file menu item into view
  useEffect(() => {
    if (!fileMenuRef.current) return;
    const active = fileMenuRef.current.children[fileMenuIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [fileMenuIndex]);

  const selectFile = useCallback((filePath: string) => {
    if (!atMention) return;
    const before = inputText.slice(0, atMention.index);
    const after = inputText.slice(atMention.index + 1 + atMention.query.length);
    setInputText(before + "@" + filePath + " " + after);
    setFileSuggestions([]);
    inputRef.current?.focus();
  }, [atMention, inputText]);

  // ── Slash command autocomplete ─────────────────────────────────────
  const [slashCommands, setSlashCommands] = useState<Array<{ name: string; description: string; source: string }>>([]);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  const partialRef = useRef<ContentBlock[]>([]);
  const currentBlockIndexRef = useRef(-1);
  const mountedRef = useRef(true);
  const sdkHistoryLoadedRef = useRef(false);
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
  const onQuestionChangeRef = useRef(onQuestionChange);
  onQuestionChangeRef.current = onQuestionChange;
  const onClaudeSessionIdRef = useRef(onClaudeSessionId);
  onClaudeSessionIdRef.current = onClaudeSessionId;
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;
  const onForkRef = useRef(onFork);
  onForkRef.current = onFork;
  const onForkWithPromptRef = useRef(onForkWithPrompt);
  onForkWithPromptRef.current = onForkWithPrompt;
  const onAvailableModelsRef = useRef(onAvailableModels);
  onAvailableModelsRef.current = onAvailableModels;
  const onRenameRef = useRef(onRename);
  onRenameRef.current = onRename;
  const onMarkTitleGeneratedRef = useRef(onMarkTitleGenerated);
  onMarkTitleGeneratedRef.current = onMarkTitleGenerated;
  const onClearPendingPromptRef = useRef(onClearPendingPrompt);
  onClearPendingPromptRef.current = onClearPendingPrompt;
  const currentModelRef = useRef(currentModel);
  currentModelRef.current = currentModel;
  const titleGeneratedRef = useRef(!!session?.hasTitleBeenGenerated);

  // Sync busy state to parent
  useEffect(() => {
    onBusyChangeRef.current?.(isGenerating);
    // When generation starts again, clear any pending question
    if (isGenerating) {
      onQuestionChangeRef.current?.(false);
    }
  }, [isGenerating]);

  // Sync draft state to parent
  useEffect(() => {
    onDraftChangeRef.current?.(inputText.trim().length > 0);
  }, [inputText]);

  // Fetch slash commands for the session's directory
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
        { name: "session-id", description: "Copy session ID to clipboard", source: "built-in" },
        { name: "editor", description: "Set external editor command (e.g. code, cursor, zed)", source: "built-in" },
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
    const sliced = messages.length <= renderCount ? messages : messages.slice(messages.length - renderCount);
    return mergeToolOnlyMessages(sliced);
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

  // Auto-load more messages when sentinel becomes visible
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    const container = scrollRef.current;
    if (!el || !container) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          // Preserve scroll position when prepending messages
          const prevHeight = container.scrollHeight;
          loadMore();
          requestAnimationFrame(() => {
            container.scrollTop += container.scrollHeight - prevHeight;
          });
        }
      },
      { root: container, rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      isAtBottomRef.current = true;
    }
  }, []);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 40;
  }, []);

  useEffect(() => {
    // Only auto-scroll if the user is already at the bottom
    if (isAtBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom());
    }
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
  // Stable key for child sessions to use as useEffect dependency
  const childSessionsKey = useMemo(
    () => childSessions?.map(c => `${c.id}:${c.claudeSessionId}`).join(",") ?? "",
    [childSessions]
  );

  useEffect(() => {
    mountedRef.current = true;

    // Defer loading until the session is actually visible to avoid
    // loading history for all sessions on app start.
    if (!isActive && lastLoadedClaudeSessionIdRef.current === null) {
      return;
    }

    // Skip reload if we already loaded for this exact claudeSessionId.
    // We must reload when claudeSessionId changes because the JSONL path depends on it.
    const currentClaudeSessionId = session?.claudeSessionId ?? null;
    if (lastLoadedClaudeSessionIdRef.current === currentClaudeSessionId && currentClaudeSessionId !== null) {
      return;
    }

    async function loadHistory() {
      if (!mountedRef.current) return;

      const claudeSessionId = session?.claudeSessionId;
      const dir = session ? jsonlDirectory(session) : "";

      // Extract the user's actual typed text from content blocks,
      // stripping file-context markup that differs between display and JSONL.
      const extractUserText = (content: ContentBlock[]): string =>
        content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .replace(/<file[^>]*>[\s\S]*?<\/file>\s*/g, "")
          .replace(/^📎 .+$/gm, "")
          .replace(/^\/.*claude-orchestrator-images\/.*$/gm, "")
          .trim();

      // Phase 0: Load parent conversation for forked sessions
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
          } catch {}
        }
        // Fallback: load from agent history (OpenCode sessions don't write Claude JSONL files)
        if (parentMessages.length === 0) {
          try {
            const histLines = await invoke<string[]>("get_agent_history", { sessionId: parentSession.id });
            if (histLines.length > 0) {
              const parsed = await parseHistoryLines(histLines, sdkMessageToChatMessage);
              parentMessages = parsed.map(m => ({ ...m, id: `parent-${m.id}`, isParentMessage: true }));
            }
          } catch {}
        }
      }

      // Helper: filter out fork-context system prompt from child messages when parent is loaded
      const filterForkContext = (msgs: ChatMessage[]): ChatMessage[] => {
        if (parentMessages.length === 0) return msgs;
        return msgs.filter(m => {
          if (m.type !== "user") return true;
          const text = m.content.filter(b => b.type === "text").map(b => b.text).join("\n");
          return !text.includes("<fork-context>");
        });
      };

      // Helper to merge replayed messages into state
      const mergeMessages = (replayed: ChatMessage[]) => {
        if (!mountedRef.current) return;
        replayed = filterForkContext(replayed);
        if (replayed.length > 0) {
          console.log(`[loadHistory] ${sessionId}: ${replayed.length} messages, first=${replayed[0].type}:${replayed[0].id.substring(0, 20)}, last=${replayed[replayed.length-1].type}:${replayed[replayed.length-1].id.substring(0, 20)}`);
        }
        setMessages((prev) => {
          lastLoadedClaudeSessionIdRef.current = claudeSessionId ?? null;

          // Separate existing parent messages from own messages to avoid
          // parent messages leaking into `newMessages` and being appended
          // after the child messages (which caused the duplication bug).
          const existingParent = prev.filter(m => m.isParentMessage);
          const existingOwn = prev.filter(m => !m.isParentMessage);
          const finalParent = existingParent.length > 0 ? existingParent : parentMessages;

          if (existingOwn.length === 0) {
            return [...finalParent, ...replayed];
          }

          const newMessages = existingOwn.filter((m) => {
            if (replayed.some((r) => r.id === m.id)) return false;
            if (m.type === "user") {
              const mText = extractUserText(m.content);
              // Plan placeholder ("Execute the plan.") should be replaced by the real JSONL message
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

          if (newMessages.length === 0) {
            return [...finalParent, ...replayed];
          }
          return [...finalParent, ...replayed, ...newMessages];
        });
      };

      // Phase 1: Load tail for fast initial display
      let tailTotal = 0;
      let tailLineCount = 0;
      if (claudeSessionId) {
        try {
          const tail = await invoke<{ lines: string[]; total: number }>("get_conversation_jsonl_tail", {
            claudeSessionId,
            directory: dir,
            maxLines: 300,
          });
          tailTotal = tail.total;
          tailLineCount = tail.lines.length;
          if (tail.lines.length > 0) {
            const replayed = await parseHistoryLines(tail.lines, sdkMessageToChatMessage);
            mergeMessages(replayed);
          }
        } catch {}
      }

      // If no JSONL tail (brand-new session), fall back to in-memory history
      if (tailLineCount === 0) {
        let lines: string[] = [];
        try {
          lines = await invoke<string[]>("get_agent_history", { sessionId });
        } catch {}
        if (lines.length > 0) {
          const replayed = await parseHistoryLines(lines, sdkMessageToChatMessage);
          mergeMessages(replayed);
        } else if (parentMessages.length > 0) {
          mergeMessages([]);
        }
        return;
      }

      // Phase 2: Background backfill if there are older messages
      if (tailTotal > tailLineCount && claudeSessionId) {
        try {
          const allLines = await invoke<string[]>("get_conversation_jsonl", {
            claudeSessionId,
            directory: dir,
          });
          if (!mountedRef.current) return;
          const replayed = await parseHistoryLines(allLines, sdkMessageToChatMessage);
          mergeMessages(replayed);
        } catch {}
      }

      // Phase 3: Load child session messages (for parent sessions with forked children)
      if (childSessions && childSessions.length > 0) {
        for (const child of childSessions) {
          try {
            let childLines: string[] = [];
            if (child.claudeSessionId && child.directory) {
              try {
                childLines = await invoke<string[]>("get_conversation_jsonl", {
                  claudeSessionId: child.claudeSessionId,
                  directory: child.directory,
                });
              } catch {}
            }
            // Fallback: agent history for OpenCode child sessions
            if (childLines.length === 0) {
              try {
                childLines = await invoke<string[]>("get_agent_history", { sessionId: child.id });
              } catch {}
            }
            if (!mountedRef.current) return;
            if (childLines.length > 0) {
              const parsed = await parseHistoryLines(childLines, sdkMessageToChatMessage);
              // Filter out fork-context system prompt from child messages
              const filtered = parsed.filter(m => {
                if (m.type !== "user") return true;
                const text = m.content.filter(b => b.type === "text").map(b => b.text).join("\n");
                return !text.includes("<fork-context>");
              });
              // Prefix child message IDs to avoid collisions
              const childMessages = filtered.map(m => ({
                ...m,
                id: `child-${child.id}-${m.id}`,
              }));
              // Insert a separator before child messages
              const separator: ChatMessage = {
                id: `child-separator-${child.id}`,
                type: "system",
                content: [{ type: "text", text: `── Executing plan ──` }],
                timestamp: Date.now(),
              };
              setMessages((prev) => {
                // Don't add if already present
                if (prev.some(m => m.id === separator.id)) return prev;
                return [...prev, separator, ...childMessages];
              });
            }
          } catch {}
        }
      }
    }

    loadHistory();

    return () => {
      mountedRef.current = false;
    };
  }, [sessionId, session?.claudeSessionId, isActive, childSessionsKey]);

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

    if (msgType === "available_models") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onAvailableModelsRef.current?.(msg.models as any);
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
        onClearPendingPromptRef.current?.();
        const prompt = session.pendingPrompt;
        // Show user message in chat
        setMessages((prev) => [
          ...prev,
          {
            id: `user-${Date.now()}`,
            type: "user",
            content: [{ type: "text", text: session?.planContent ? "Execute the plan." : prompt }],
            timestamp: Date.now(),
          },
        ]);
        abortedRef.current = false;
        generationStartRef.current = Date.now();
        isGeneratingRef.current = true;
        setIsGenerating(true);
        const jsonLine = JSON.stringify({
          type: "user",
          message: { role: "user", content: prompt },
        });
        const trySendAuto = (attempt: number) => {
          invoke("send_agent_message", { sessionId, message: jsonLine }).then(() => {
            // Generate smart title for OpenCode sessions (no JSONL to watch)
            if (session?.provider === "opencode" && !titleGeneratedRef.current) {
              titleGeneratedRef.current = true;
              invoke<string | null>("generate_title_from_text", { message: prompt.substring(0, 500) })
                .then((title) => {
                  if (title) {
                    onRenameRef.current?.(title);
                    onMarkTitleGeneratedRef.current?.();
                  }
                })
                .catch(() => {});
            }
          }).catch((err) => {
            const errStr = String(err);
            if (attempt === 0 && errStr.includes("query is already in progress")) {
              setTimeout(() => trySendAuto(1), 1000);
              return;
            }
            stopGenerating();
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
        };
        trySendAuto(0);
      }
      return;
    }

    // Assistant message (may be partial during streaming or final)
    // NOTE: The SDK sends each content block as a SEPARATE event with the same
    // message ID, not as accumulated content. We must merge blocks ourselves.
    if (msgType === "assistant") {
      // Drop messages arriving after abort — the process may still be winding down
      if (abortedRef.current) {
        return;
      }
      if (!isGeneratingRef.current) {
        isGeneratingRef.current = true;
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

        // Detect AskUserQuestion tool call
        for (const block of content) {
          if (block.type === "tool_use" && block.name === "AskUserQuestion") {
            onQuestionChangeRef.current?.(true);
            const input = (block as { input?: { questions?: AskQuestion[] } }).input;
            const questions = Array.isArray(input?.questions) ? input.questions : [];
            if (questions.length > 0) {
              setPendingQuestion({ blockId: (block as { id: string }).id, questions });
            }
          }
        }

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

    // Usage-only update (OpenCode mid-turn completions — no stop)
    if (msgType === "usage") {
      const result = msg as Record<string, unknown>;
      const resultUsage = result.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
      if (resultUsage) {
        const inp = resultUsage.input_tokens || 0;
        const out = resultUsage.output_tokens || 0;
        const cr = resultUsage.cache_read_input_tokens || 0;
        const cc = resultUsage.cache_creation_input_tokens || 0;
        const acc = accumulatedUsageRef.current;
        acc.inputTokens += inp;
        acc.outputTokens += out;
        acc.cacheReadInputTokens += cr;
        acc.cacheCreationInputTokens += cc;
        acc.contextTokens = inp + cr + cc;
        acc.costUsd += (result.cost_usd as number) || 0;
        onUsageUpdateRef.current?.({ ...acc, isBusy: true });
      }
      return;
    }

    // Result message
    if (msgType === "result") {
      stopGenerating();
      setCurrentTodo(null);
      setPendingQuestion(null);
      accumulatedBlocksRef.current.clear();
      const result = msg as Record<string, unknown>;
      const durationMs = generationStartRef.current ? Date.now() - generationStartRef.current : undefined;

      // Accumulate usage for context bar (bridge-based sessions)
      const resultUsage = result.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
      if (resultUsage) {
        const inp = resultUsage.input_tokens || 0;
        const out = resultUsage.output_tokens || 0;
        const cr = resultUsage.cache_read_input_tokens || 0;
        const cc = resultUsage.cache_creation_input_tokens || 0;
        const acc = accumulatedUsageRef.current;
        acc.inputTokens += inp;
        acc.outputTokens += out;
        acc.cacheReadInputTokens += cr;
        acc.cacheCreationInputTokens += cc;
        acc.contextTokens = inp + cr + cc; // latest turn's context window usage
        acc.costUsd += (result.cost_usd as number) || 0;
        onUsageUpdateRef.current?.({ ...acc, isBusy: false });
      }

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
            usage: resultUsage as { input_tokens?: number; output_tokens?: number } | undefined,
            durationMs,
          },
        ];
      });
      partialRef.current = [];
      currentBlockIndexRef.current = -1;
      return;
    }

    // Query complete
    if (msgType === "query_complete") {
      stopGenerating();
      setCurrentTodo(null);
      setPendingQuestion(null);
      accumulatedBlocksRef.current.clear();
      onUsageUpdateRef.current?.({ ...accumulatedUsageRef.current, isBusy: false });
      // Restore plan mode for next message (may have been switched to bypass by auto-classify)
      if (session?.permissionMode === "plan") {
        const restoreMsg = JSON.stringify({ type: "set_permission_mode", permissionMode: "plan" });
        invoke("send_agent_message", { sessionId, message: restoreMsg }).catch(() => {});
      }
      return;
    }

    // Abort
    if (msgType === "aborted") {
      stopGenerating();
      setCurrentTodo(null);
      setPendingQuestion(null);
      accumulatedBlocksRef.current.clear();
      return;
    }

    // Error
    if (msgType === "error") {
      stopGenerating();
      setCurrentTodo(null);
      setPendingQuestion(null);
      accumulatedBlocksRef.current.clear();
      // Suppress "aborted by user" errors — treat like a silent abort
      // (SDK's AbortError class doesn't set name="AbortError", so the bridge
      // emits it as a regular error instead of the "aborted" event type)
      const errorText = (msg.error as string) || "";
      if (errorText.includes("aborted by user")) {
        return;
      }
      setMessages((prev) => [
        ...prev.filter((m) => !m.isStreaming),
        {
          id: `error-${Date.now()}`,
          type: "error",
          content: [{ type: "text", text: errorText || "Unknown error" }],
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    // Permission request (plan mode)
    if (msgType === "permission_request") {
      setPendingPermission({
        toolName: msg.toolName as string,
        input: msg.input as Record<string, unknown>,
      });
      onQuestionChangeRef.current?.(true);
      if (msg.toolName === "ExitPlanMode") {
        sendNotification({
          title: "Plan ready",
          body: session?.name || "A session needs your approval",
        });
      }
      return;
    }

    // Question request (from OpenCode bridge)
    if (msgType === "ask_user_question") {
      const questions = (msg.questions as AskQuestion[]) || [];
      if (questions.length > 0) {
        setPendingQuestion({ blockId: `ask-${Date.now()}`, questions });
        onQuestionChangeRef.current?.(true);
      }
      return;
    }

    // User message from SDK history replay (OpenCode session resumption)
    if (msgType === "user_history") {
      const messageObj = msg.message as Record<string, unknown> | undefined;
      const content = normalizeContent(messageObj?.content);
      if (content) {
        setMessages((prev) => [
          ...prev,
          {
            id: (messageObj?.id as string) || `user-history-${Date.now()}`,
            type: "user",
            content,
            timestamp: Date.now(),
          },
        ]);
      }
      return;
    }

    // SDK history fully loaded — mark so we skip JSONL replay
    if (msgType === "history_loaded") {
      sdkHistoryLoadedRef.current = true;
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
    const unlistenFns: (() => void)[] = [];

    const registerListener = (promise: Promise<() => void>) => {
      promise.then((fn) => {
        if (cancelled) fn();
        else unlistenFns.push(fn);
      });
    };

    // Listen to this session's own events
    registerListener(listen<string>(
      `agent-message-${sessionId}`,
      (event) => {
        if (cancelled || !mountedRef.current) return;
        try {
          const msg = JSON.parse(event.payload);
          handleAgentMessage(msg);
        } catch {}
      }
    ));

    registerListener(listen<string>(
      `agent-exit-${sessionId}`,
      (event) => {
        if (cancelled || !mountedRef.current) return;
        stopGenerating();
        const code = parseInt(event.payload, 10);
        onExitRef.current(isNaN(code) ? undefined : code);
      }
    ));

    // Also listen to child session events (merged view)
    if (childSessions && childSessions.length > 0) {
      for (const child of childSessions) {
        registerListener(listen<string>(
          `agent-message-${child.id}`,
          (event) => {
            if (cancelled || !mountedRef.current) return;
            try {
              const msg = JSON.parse(event.payload);
              // Skip system init messages from children — they would overwrite
              // this (parent) session's claudeSessionId with the child's value.
              if (msg.type === "system" && msg.subtype === "init") return;
              // Prefix message IDs from children to avoid collisions
              if (msg.message && typeof msg.message === "object") {
                const apiId = msg.message.id;
                if (apiId) msg.message.id = `child-${child.id}-${apiId}`;
              }
              handleAgentMessage(msg);
            } catch {}
          }
        ));

        registerListener(listen<string>(
          `agent-exit-${child.id}`,
          () => {
            if (cancelled || !mountedRef.current) return;
            // Child exited — stop generating only if no other children are running
            const otherRunning = childSessions.some(
              (c) => c.id !== child.id && (c.status === "running" || c.status === "starting")
            );
            if (!otherRunning) {
              stopGenerating();
            }
          }
        ));
      }
    }

    return () => {
      cancelled = true;
      for (const fn of unlistenFns) fn();
    };
  }, [sessionId, handleAgentMessage, childSessionsKey]);

  // ── Poll OpenCode usage ─────────────────────────────────────────
  useEffect(() => {
    if (session?.provider !== "opencode") return;
    if (session?.status !== "running" && session?.status !== "starting") return;

    const fetchUsage = () => {
      invoke("send_agent_message", {
        sessionId,
        message: JSON.stringify({ type: "get_usage" }),
      }).catch(() => {});
    };

    // Fetch immediately, then every 30s
    fetchUsage();
    const interval = setInterval(fetchUsage, 30_000);
    return () => clearInterval(interval);
  }, [sessionId, session?.provider, session?.status]);

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

  function looksLikeBackgroundTaskNotification(text: string): boolean {
    // Background task completion messages injected by the SDK follow a pattern:
    // line1: task ID, line2: toolu_..., line3: .output path, line4: completed
    return /^[a-z0-9]+\ntoolu_/.test(text) && text.includes("completed");
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
      // If the message contains any tool_result blocks, it's tool plumbing — not user input.
      // Accompanying text blocks are system-injected (e.g. "Tool loaded.", system-reminders).
      const hasToolResults = blocks.some((b) => b.type === "tool_result");
      if (hasToolResults) return null;
      // Also filter out system-reminder-only messages
      const visibleBlocks = blocks.filter((b) => {
        if (b.type === "text" && typeof b.text === "string" && b.text.trimStart().startsWith("<system-reminder>")) return false;
        return true;
      });
      if (visibleBlocks.length === 0) return null;
      // Skip messages that look like Task/Agent tool prompts
      const textContent = visibleBlocks.find((b) => b.type === "text")?.text || "";
      if (looksLikeBackgroundTaskNotification(textContent)) return null;
      if (looksLikeTaskPrompt(textContent)) {
        // Don't filter out the plan execution message
        const isPlanMessage = session?.planContent && textContent.length > 200 &&
          normaliseWs(textContent).includes(normaliseWs(session.planContent).slice(0, 200));
        if (!isPlanMessage) return null;
      }
      return {
        id: `user-${Date.now()}-${Math.random()}`,
        type: "user",
        content: visibleBlocks,
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

    // Always scroll to bottom when user sends a message
    isAtBottomRef.current = true;
    requestAnimationFrame(() => scrollToBottom());

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
    if (text === "/session-id") {
      const sid = session?.claudeSessionId;
      if (sid) {
        navigator.clipboard.writeText(sid);
      }
      setInputText("");
      return;
    }
    if (text === "/editor" || text.startsWith("/editor ")) {
      const arg = text.slice("/editor".length).trim();
      if (arg) {
        localStorage.setItem("claude-orchestrator-editor-command", arg);
        setMessages((prev) => [...prev, { id: `editor-${Date.now()}`, type: "system", content: [{ type: "text", text: `Editor set to: ${arg}` }], timestamp: Date.now() }]);
      } else {
        const current = localStorage.getItem("claude-orchestrator-editor-command") || "code";
        setMessages((prev) => [...prev, { id: `editor-${Date.now()}`, type: "system", content: [{ type: "text", text: `Current editor: ${current}\nUsage: /editor <command> (e.g. code, cursor, zed, subl)` }], timestamp: Date.now() }]);
      }
      setInputText("");
      return;
    }
    // Build file reference context prefix
    const refs = fileReferences;
    let fileContext = "";
    if (refs.length > 0) {
      fileContext = refs.map((ref) => {
        const lineRange = ref.startLine === 1 && ref.endLine >= ref.content.split("\n").length
          ? ""
          : `:${ref.startLine}-${ref.endLine}`;
        return `<file path="${ref.filePath}${lineRange}">\n${ref.content}\n</file>`;
      }).join("\n\n") + "\n\n";
    }

    // Build content blocks
    const fullText = fileContext + text;
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
      if (fullText) {
        blocks.push({ type: "text", text: fullText });
      }
      content = blocks;
    } else {
      content = fullText;
    }

    // Add user message to UI (show the display text, not the raw file context)
    const displayParts: ContentBlock[] = [];
    if (refs.length > 0) {
      const refSummary = refs.map((ref) => {
        const lineRange = ref.startLine === 1 && ref.endLine >= ref.content.split("\n").length
          ? "" : `:${ref.startLine}-${ref.endLine}`;
        return `📎 ${ref.filePath}${lineRange}`;
      }).join("\n");
      displayParts.push({ type: "text", text: refSummary });
    }
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      type: "user",
      content: [
        ...images.map((img) => ({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.data },
        })),
        ...displayParts,
        ...(text ? [{ type: "text", text }] : []),
      ],
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInputText("");
    setImages([]);
    setFileReferences([]);
    abortedRef.current = false;
    generationStartRef.current = Date.now();
    isGeneratingRef.current = true;
    setIsGenerating(true);
    onActivityRef.current(); // Update session timestamp when user sends a message

    // If the session is stopped, transparently restart the bridge first
    if (isReadOnly && onResumeRef.current) {
      try {
        await onResumeRef.current();
      } catch (err) {
        stopGenerating();
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

    // Auto-classify for plan-mode sessions: switch to bypass for simple prompts
    if (session?.permissionMode === "plan") {
      try {
        const classification = await invoke<string>("classify_prompt", {
          message: typeof content === "string" ? content : text,
        });
        const targetMode = classification === "simple" ? "bypassPermissions" : "plan";
        const modeMsg = JSON.stringify({ type: "set_permission_mode", permissionMode: targetMode });
        await invoke("send_agent_message", { sessionId: targetSessionId, message: modeMsg });
      } catch {
        // Classification failed — keep current mode (plan)
      }
    }

    // Send to backend
    const jsonLine = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });
    const trySend = async (attempt: number) => {
      try {
        await invoke("send_agent_message", { sessionId: targetSessionId, message: jsonLine });

        // Generate smart title for OpenCode sessions (no JSONL to watch)
        if (session?.provider === "opencode" && !titleGeneratedRef.current && text) {
          titleGeneratedRef.current = true;
          invoke<string | null>("generate_title_from_text", { message: text })
            .then((title) => {
              if (title) {
                onRenameRef.current?.(title);
                onMarkTitleGeneratedRef.current?.();
              }
            })
            .catch(() => {});
        }
      } catch (err) {
        const errStr = String(err);
        // Bridge still winding down after abort — retry once after a short delay
        if (attempt === 0 && errStr.includes("query is already in progress")) {
          setTimeout(() => trySend(1), 1000);
          return;
        }
        stopGenerating();
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
    };
    trySend(0);
  }, [inputText, images, targetSessionId, isReadOnly, editingMessageId, fileReferences, scrollToBottom]);

  const handleAbort = useCallback(() => {
    invoke("abort_agent", { sessionId: targetSessionId }).catch(() => {});
    abortedRef.current = true;
    if (isGeneratingTimeoutRef.current) {
      clearTimeout(isGeneratingTimeoutRef.current);
      isGeneratingTimeoutRef.current = null;
    }
    isGeneratingRef.current = false;
    setIsGenerating(false);
    setCurrentTodo(null);
    accumulatedBlocksRef.current.clear();
  }, [targetSessionId]);

  // Answer an AskUserQuestion by sending the structured answers to the bridge.
  // The bridge's canUseTool callback expects a Record<questionText, answerString>.
  const answerQuestion = useCallback((answer: Record<string, string>) => {
    onQuestionChangeRef.current?.(false);
    setPendingQuestion(null);
    const msg = JSON.stringify({ type: "ask_user_answer", answer });
    invoke("send_agent_message", { sessionId: targetSessionId, message: msg }).catch(() => {
      setInputText(Object.values(answer).join(", "));
      inputRef.current?.focus();
    });
    // Show the answer as a user message in the chat
    const displayText = Object.values(answer).join("\n");
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        type: "user",
        content: [{ type: "text", text: displayText }],
        timestamp: Date.now(),
      },
    ]);
  }, [targetSessionId]);

  // Respond to a permission request (plan mode)
  const respondPermission = useCallback((allowed: boolean) => {
    setPendingPermission(null);
    onQuestionChangeRef.current?.(false);
    if (!allowed) {
      // Deny ends the agent turn — stop spinner immediately
      stopGenerating();
      onUsageUpdateRef.current?.({ ...accumulatedUsageRef.current, isBusy: false });
    }
    const msg = JSON.stringify({ type: "permission_response", allowed });
    invoke("send_agent_message", { sessionId: targetSessionId, message: msg }).catch(() => {});
  }, [targetSessionId]);

  // Allow in a new conversation: fork with plan as pending prompt, deny current
  const allowInNewConversation = useCallback(async () => {
    if (!onForkWithPromptRef.current) return;
    // Extract plan file content from Write tool calls targeting .claude/plans/
    const planFileContent = messages
      .filter((m) => m.type === "assistant")
      .flatMap((m) => Array.isArray(m.content) ? m.content : [])
      .filter((b: ContentBlock) => b.type === "tool_use" && (b.name === "Write" || b.name === "write" || b.name === "Edit" || b.name === "edit"))
      .map((b: ContentBlock) => b.input)
      .find((input) => (input?.file_path as string)?.includes(".claude/plans/"));
    const planMarkdown = (planFileContent?.content as string) || "";
    // Extract plan text from assistant messages (fallback)
    const assistantTexts = messages
      .filter((m) => m.type === "assistant")
      .map((m) =>
        Array.isArray(m.content)
          ? m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
          : ""
      )
      .filter(Boolean);
    const planText = planMarkdown || assistantTexts[assistantTexts.length - 1] || "";
    // Build fork context (transcript of all messages)
    const lines = messages.map((m) => {
      const text = Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
        : "";
      if (m.type === "user") return `Human: ${text}`;
      if (m.type === "assistant") return `Assistant: ${text}`;
      return "";
    }).filter(Boolean);
    const systemPrompt = `This conversation was forked from a plan-mode session. Here is the conversation context:\n\n<fork-context>\n${lines.join("\n\n")}\n</fork-context>\n\nExecute the plan. Do not ask for confirmation — proceed directly.`;
    // Deny current permission and abort agent so it actually stops
    onQuestionChangeRef.current?.(false);
    respondPermission(false);
    onBusyChangeRef.current?.(false);
    invoke("abort_agent", { sessionId }).catch(() => {});
    abortedRef.current = true;
    // Create new session with bypass permissions, including plan content for display
    const execName = `Execute: ${session?.name || "plan"}`;
    const newSessionId = await onForkWithPromptRef.current(systemPrompt, planText, planMarkdown || undefined);
    setMessages((prev) => [
      ...prev,
      {
        id: `fork-link-${Date.now()}`,
        type: "system",
        content: [{ type: "text", text: `Plan executing in → ${execName}` }],
        timestamp: Date.now(),
        forkSessionId: newSessionId,
        forkSessionName: execName,
      },
    ]);
  }, [messages, respondPermission, session?.name]);

  // ── Edit / resend a user message ──────────────────────────────────

  const editMessage = useCallback((messageId: string) => {
    const msg = messages.find((m) => m.id === messageId);
    if (!msg || msg.type !== "user") return;
    // Extract text from the message content blocks
    const text = (Array.isArray(msg.content)
      ? msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
      : typeof msg.content === "string" ? msg.content : ""
    );
    // Restore image blocks
    if (Array.isArray(msg.content)) {
      const imgs = msg.content
        .filter((b) => b.type === "image" && b.source?.type === "base64")
        .map((b, i) => ({
          id: `edit-img-${Date.now()}-${i}`,
          data: b.source!.data as string,
          mediaType: b.source!.media_type as string,
          name: "image",
        }));
      setImages(imgs);
    }
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

  const addImageFromFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
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
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) addImageFromFile(file);
        }
      }
    },
    [addImageFromFile]
  );

  // Document-level paste listener for when the input is not focused
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: ClipboardEvent) => {
      // Skip if the textarea already has focus (handlePaste on the element will handle it)
      if (document.activeElement === inputRef.current) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      let hasImage = false;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          hasImage = true;
          const file = item.getAsFile();
          if (file) addImageFromFile(file);
        }
      }
      if (hasImage) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [addImageFromFile, isActive]);

  // Listen for orchestrator-commit event (Cmd+Shift+C)
  useEffect(() => {
    if (!isActive) return;
    const handler = () => {
      const hasCommitCommand = slashCommands.some((cmd) => cmd.name === "commit");
      if (hasCommitCommand) {
        sendMessage("/commit");
      } else {
        sendMessage("Look at the current git diff and create a commit with an appropriate message. Stage relevant files if needed.");
      }
    };
    window.addEventListener("orchestrator-commit", handler);
    return () => window.removeEventListener("orchestrator-commit", handler);
  }, [isActive, slashCommands, sendMessage]);

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
      // File menu navigation (@mentions)
      if (showFileMenu) {
        if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
          e.preventDefault();
          setFileMenuIndex((i) => Math.min(i + 1, fileSuggestions.length - 1));
          return;
        }
        if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
          e.preventDefault();
          setFileMenuIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          selectFile(fileSuggestions[fileMenuIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setFileSuggestions([]);
          return;
        }
      }
      // Slash menu navigation
      if (showSlashMenu && filteredSlashCommands.length > 0) {
        if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
          e.preventDefault();
          setSlashMenuIndex((i) => Math.min(i + 1, filteredSlashCommands.length - 1));
          return;
        }
        if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
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
    [sendMessage, isGenerating, handleAbort, showSlashMenu, filteredSlashCommands, slashMenuIndex, selectSlashCommand, showFileMenu, fileSuggestions, fileMenuIndex, selectFile]
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
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-5 pr-16 py-4 flex flex-col gap-5"
      >
        {/* Skip rendering message DOM for inactive tabs to avoid layout thrash */}
        {isActive ? (
          <>
            {messages.length === 0 && !isGenerating && !session?.planContent && (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-[var(--text-tertiary)]">
                  Send a message to start the conversation
                </p>
              </div>
            )}

            {hasMore && <div ref={sentinelRef} className="h-1" />}

            {deferredMessages.map((msg, idx) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  toolStates={toolStates}
                  onToggleTool={toggleTool}
                  isLastMessage={isGenerating && idx === deferredMessages.length - 1 && trailingMessages.length === 0}
                  planContent={session?.planContent}
                  onEdit={msg.isParentMessage || msg.id.startsWith("child-") ? undefined : editMessage}
                  onFork={msg.isParentMessage || msg.id.startsWith("child-") ? undefined : forkFromMessage}
                  onRetry={msg.isParentMessage || msg.id.startsWith("child-") ? undefined : retryMessage}
                  onCopy={copyMessage}
                  onNavigateToSession={onNavigateToSession}
                />
            ))}
            {trailingMessages.map((msg, idx) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  toolStates={toolStates}
                  onToggleTool={toggleTool}
                  isLastMessage={isGenerating && idx === trailingMessages.length - 1}
                  planContent={session?.planContent}
                  onEdit={msg.isParentMessage || msg.id.startsWith("child-") ? undefined : editMessage}
                  onFork={msg.isParentMessage || msg.id.startsWith("child-") ? undefined : forkFromMessage}
                  onRetry={msg.isParentMessage || msg.id.startsWith("child-") ? undefined : retryMessage}
                  onCopy={copyMessage}
                  onNavigateToSession={onNavigateToSession}
                />
            ))}

            {isGenerating && !pendingPermission && !pendingQuestion && (
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
      <div className="border-t border-[var(--border-subtle)] px-5 py-4 bg-[var(--bg-secondary)]/40 relative flex flex-col gap-2" ref={inputAreaRef}>
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
        {/* @ file autocomplete */}
        {showFileMenu && (
          <div
            ref={fileMenuRef}
            className="absolute bottom-full left-0 right-0 mx-4 mb-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg overflow-hidden z-50 max-h-64 overflow-y-auto"
          >
            {fileSuggestions.map((filePath, i) => {
              const parts = filePath.split("/");
              const fileName = parts.pop()!;
              const dirPath = parts.join("/");
              return (
                <button
                  key={filePath}
                  className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-sm transition-colors ${
                    i === fileMenuIndex
                      ? "bg-[var(--accent)]/15 text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                  }`}
                  onMouseEnter={() => setFileMenuIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectFile(filePath);
                  }}
                >
                  <span className="font-mono text-[var(--text-primary)] truncate">{fileName}</span>
                  {dirPath && (
                    <span className="text-[var(--text-tertiary)] text-xs truncate ml-auto">{dirPath}/</span>
                  )}
                </button>
              );
            })}
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

        {/* Inline question / permission composer OR normal input */}
        {pendingQuestion ? (
          <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3">
            <div className="text-[10px] font-semibold text-[var(--accent)] uppercase tracking-wide mb-1.5">Agent is asking</div>
            <InlineQuestionComposer
              questions={pendingQuestion.questions}
              onAnswer={answerQuestion}
            />
          </div>
        ) : pendingPermission ? (
          <div className="rounded-lg border border-[var(--warning-border,var(--border-color))] bg-[var(--bg-secondary)] p-3">
            <InlinePermissionComposer
              permission={pendingPermission}
              onAllow={() => respondPermission(true)}
              onDeny={() => respondPermission(false)}
              onAllowInNew={allowInNewConversation}
            />
          </div>
        ) : (
          <>
            {/* Attachments: file refs + images on one line */}
            {(fileReferences.length > 0 || images.length > 0) && (
              <div className="flex gap-2 flex-wrap items-center">
                {fileReferences.map((ref) => {
                  const fileName = ref.filePath.split("/").pop()!;
                  const previewLines = ref.content.split("\n").slice(0, 8);
                  return (
                    <div
                      key={ref.filePath}
                      className="relative group w-16 h-16 rounded-lg overflow-hidden border border-[var(--border-color)] cursor-pointer hover:border-[var(--accent)] transition-colors"
                      onClick={() => setViewingFileRef(ref)}
                    >
                      <div className="w-full h-full bg-[var(--bg-tertiary)] p-1 overflow-hidden">
                        <pre className="text-[3.5px] leading-[4.5px] text-[var(--text-tertiary)] font-mono whitespace-pre overflow-hidden pointer-events-none select-none">{previewLines.join("\n")}</pre>
                      </div>
                      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent pt-3 pb-0.5 px-1">
                        <span className="text-[8px] text-white/90 font-medium truncate block leading-tight">{fileName}</span>
                        <span className="text-[7px] text-white/60 block leading-tight">L{ref.startLine}-{ref.endLine}</span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeFileReference(ref.filePath); }}
                        className="absolute top-0 right-0 p-0.5 bg-black/60 rounded-bl text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
                {images.map((img) => (
                  <div
                    key={img.id}
                    className="relative group w-16 h-16 rounded-lg overflow-hidden border border-[var(--border-color)]"
                  >
                    <ImageWithLightbox src={`data:${img.mediaType};base64,${img.data}`} thumbnail />
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
              <div className="flex-1 flex items-end min-h-[38px] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl focus-within:border-[var(--accent)] transition-colors">
              {sessionDir && (
                <button
                  onClick={() => setShowFilePicker(true)}
                  className="p-2 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors shrink-0 self-center"
                  title="Attach file (⌘O)"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
              )}
              <textarea
                ref={inputRef}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="Message…"
                rows={1}
                className="flex-1 resize-none bg-transparent border-none px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none max-h-32 overflow-y-auto"
                style={{ minHeight: "20px" }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = "auto";
                  target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
                }}
              />
              </div>
              {isGenerating ? (
                <button
                  onClick={handleAbort}
                  className="px-3 min-h-[38px] bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm font-medium transition-colors shrink-0"
                >
                  Stop
                </button>
              ) : (
                <button
                  onClick={() => sendMessage()}
                  disabled={!inputText.trim() && images.length === 0 && fileReferences.length === 0}
                  className="px-3 min-h-[38px] bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors shrink-0"
                >
                  Send
                </button>
              )}
            </div>
            {/* Pill row: Model, Mode, Effort */}
            <div ref={pillRowRef} className="flex items-center gap-1.5 mt-1 opacity-80 hover:opacity-100 transition-opacity">
              {/* Model pill */}
              <div className="relative">
                <button
                  onClick={() => setOpenPill(openPill === "model" ? null : "model")}
                  className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  {activeModels.find((m) => m.id === currentModel)?.name ?? currentModel?.split("/").pop() ?? "Model"}
                  <svg className="w-2.5 h-2.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                </button>
                {openPill === "model" && (
                  <div className="absolute bottom-full mb-1 left-0 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg z-50 min-w-[200px] max-h-[300px] overflow-hidden flex flex-col">
                    <div className="p-2 border-b border-[var(--border-color)]">
                      <div className="relative">
                        <input
                          ref={modelSearchRef}
                          type="text"
                          value={modelSearchTerm}
                          onChange={(e) => setModelSearchTerm(e.target.value)}
                          placeholder="Search models..."
                          className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-2 py-1 text-[11px] outline-none focus:border-[var(--accent)]"
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && filteredModels.length > 0) {
                              onModelChange?.(filteredModels[0].id);
                              setOpenPill(null);
                            }
                            if (e.key === "Escape") setOpenPill(null);
                          }}
                        />
                      </div>
                    </div>
                    <div className="overflow-y-auto flex-1">
                      {filteredModels.length === 0 ? (
                        <div className="px-3 py-2 text-[10px] text-[var(--text-tertiary)] italic">No models found</div>
                      ) : (
                        filteredModels.map((model) => (
                          <button
                            key={model.id}
                            className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
                              currentModel === model.id
                                ? "bg-[var(--accent)]/15 text-[var(--text-primary)]"
                                : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                            }`}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              onModelChange?.(model.id);
                              setOpenPill(null);
                            }}
                          >
                            <div className="font-medium">{model.name}</div>
                            {model.desc && <div className="text-[10px] text-[var(--text-tertiary)]">{model.desc}</div>}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
              {/* Mode toggle */}
              <button
                onClick={async () => {
                  const newMode = session?.permissionMode === "bypassPermissions" ? "plan" : "bypassPermissions";
                  onPermissionModeChange?.(newMode);
                  try {
                    const msg = JSON.stringify({ type: "set_permission_mode", permissionMode: newMode });
                    await invoke("send_agent_message", { sessionId: targetSessionId, message: msg });
                  } catch {}
                }}
                className="px-2 py-0.5 text-[11px] rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                {session?.permissionMode === "bypassPermissions" ? "Chat" : "Plan"}
              </button>
              {/* Effort pill */}
              <div className="relative">
                <button
                  onClick={() => setOpenPill(openPill === "effort" ? null : "effort")}
                  className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  {reasoningEffort === "low" ? "Low" : reasoningEffort === "medium" ? "Medium" : "High"}
                  <svg className="w-2.5 h-2.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                </button>
                {openPill === "effort" && (
                  <div className="absolute bottom-full mb-1 left-0 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg z-50 min-w-[100px]">
                    {(["low", "medium", "high"] as const).map((level) => (
                      <button
                        key={level}
                        className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
                          reasoningEffort === level
                            ? "bg-[var(--accent)]/15 text-[var(--text-primary)]"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                        }`}
                        onMouseDown={async (e) => {
                          e.preventDefault();
                          setReasoningEffort(level);
                          try {
                            const msg = JSON.stringify({ type: "set_reasoning_effort", effort: level });
                            await invoke("send_agent_message", { sessionId: targetSessionId, message: msg });
                          } catch {}
                          setOpenPill(null);
                        }}
                      >
                        {level === "low" ? "Low" : level === "medium" ? "Medium" : "High"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Branch info */}
              {currentBranch && (
                <span className="flex items-center gap-1 ml-auto text-[10px] text-[var(--text-tertiary)]">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  {currentBranch}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* File picker modal */}
      {showFilePicker && sessionDir && (
        <FilePickerModal
          directory={sessionDir}
          onSelect={addFileReference}
          onClose={() => setShowFilePicker(false)}
        />
      )}
      {viewingFileRef && sessionDir && (
        <FilePickerModal
          directory={sessionDir}
          initialFile={viewingFileRef}
          onSelect={addFileReference}
          onClose={() => setViewingFileRef(null)}
        />
      )}
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
  onEdit,
  onFork,
  onRetry,
  onCopy,
  planContent,
  onNavigateToSession,
}: {
  message: ChatMessage;
  toolStates: Record<string, "expanded" | "collapsed">;
  onToggleTool: (id: string, isCurrentlyExpanded: boolean) => void;
  isLastMessage: boolean;
  onEdit?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  onRetry?: (messageId: string) => void;
  onCopy?: (messageId: string) => void;
  planContent?: string;
  onNavigateToSession?: (sessionId: string) => void;
}) {
  const [copied, setCopied] = useState(false);

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
    const hasPlan = planContent && visible.some(b => {
      if (b.type !== "text" || !b.text) return false;
      if (b.text.includes("Execute the plan")) return true;
      // After JSONL reload, the user message contains the full plan text
      if (b.text.length > 200) {
        const normText = normaliseWs(b.text);
        const normPlan = normaliseWs(planContent);
        return normPlan.includes(normText.slice(0, 200)) || normText.includes(normPlan.slice(0, 200));
      }
      return false;
    });
    return (
      <div className="flex flex-col items-end gap-1">
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
                onClick={() => { onCopy(message.id); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                title="Copy message"
              >
                {copied ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
            )}
          </div>
          <div className="max-w-[80%] max-h-96 overflow-y-auto bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-primary)] rounded-2xl rounded-br-md px-5 py-3 shadow-sm">
            {visible.map((block, i) => {
              // If this is a plan execution message loaded from JSONL, show short label instead of full plan text
              if (hasPlan && block.type === "text" && block.text && block.text.length > 200) {
                return <ContentBlockView key={i} block={{ type: "text", text: "Execute the plan." }} />;
              }
              if (block.type === "text" && block.text?.startsWith("\u{1F4CE} ")) {
                return (
                  <div key={i} className="flex flex-wrap gap-1.5 mb-2">
                    {block.text.split("\n").map((line, j) => (
                      <span key={j} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-[var(--accent)]/15 text-[var(--text-secondary)] border border-[var(--accent)]/20">
                        <svg className="w-3 h-3 shrink-0 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                        </svg>
                        {line.replace(/^\u{1F4CE}\s*/u, "")}
                      </span>
                    ))}
                  </div>
                );
              }
              return <ContentBlockView key={i} block={block} />;
            })}
          </div>
        </div>
        {hasPlan && <InlinePlanBlock content={planContent} />}
      </div>
    );
  }

  if (message.type === "system") {
    if (message.forkSessionId) {
      return (
        <div className="mx-3 my-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center gap-2 text-xs text-blue-400">
          <span>→</span>
          <span>Plan executing in</span>
          <button
            className="font-medium underline underline-offset-2 hover:text-blue-300 transition-colors cursor-pointer"
            onClick={() => onNavigateToSession?.(message.forkSessionId!)}
          >
            {message.forkSessionName || "new session"}
          </button>
        </div>
      );
    }
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
    const durationMs = message.durationMs;
    if (!usage && !cost && !durationMs) return null;
    const formatDuration = (ms: number) => {
      if (ms < 1000) return `${ms}ms`;
      const seconds = ms / 1000;
      if (seconds < 60) return `${seconds.toFixed(1)}s`;
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = Math.round(seconds % 60);
      return `${minutes}m ${remainingSeconds}s`;
    };
    return (
      <div className="flex items-center gap-3 px-3 py-1 text-[10px] text-[var(--text-tertiary)]">
        {usage && (
          <span>
            {((usage.input_tokens || 0) + (usage.output_tokens || 0)).toLocaleString()} tokens
          </span>
        )}
        {durationMs !== undefined && durationMs > 0 && (
          <span>{formatDuration(durationMs)}</span>
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

  const bundledItems = useMemo(
    () => bundleConsecutiveToolGroups(grouped, isLastMessage),
    [grouped, isLastMessage]
  );

  // Find the last tool group ID across all items (for auto-expand of in-progress tool)
  const lastToolGroupId = useMemo(() => {
    if (!isLastMessage) return null;
    for (let i = bundledItems.length - 1; i >= 0; i--) {
      const item = bundledItems[i];
      if (item.type === "toolGroup") return item.group.blockId;
      if (item.type === "toolBundle") {
        return item.bundle.groups[item.bundle.groups.length - 1].blockId;
      }
    }
    return null;
  }, [bundledItems, isLastMessage]);

  // The last bundle in the last message defaults to expanded
  const lastBundleId = useMemo(() => {
    if (!isLastMessage) return null;
    for (let i = bundledItems.length - 1; i >= 0; i--) {
      if (bundledItems[i].type === "toolBundle") return (bundledItems[i] as { type: "toolBundle"; bundle: ToolBundle }).bundle.id;
    }
    return null;
  }, [bundledItems, isLastMessage]);

  return (
    <div className="max-w-[95%]">
      <div className="flex flex-col gap-3">
        {bundledItems.map((item, i) => {
          if (item.type === "toolBundle") {
            const { bundle } = item;
            const isExpanded = toolStates[bundle.id] === "expanded" ||
              (bundle.id === lastBundleId && toolStates[bundle.id] !== "collapsed");
            return (
              <ToolBundleSummaryBar
                key={bundle.id}
                bundle={bundle}
                expanded={isExpanded}
                onToggleBundle={() => onToggleTool(bundle.id, isExpanded)}
                toolStates={toolStates}
                onToggleTool={onToggleTool}
                isLastMessage={isLastMessage}
              />
            );
          }
          if (item.type === "toolGroup") {
            const { group } = item;
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
          // Collapse text blocks that duplicate the pinned plan content
          if (planContent && item.block.type === "text" && item.block.text && item.block.text.length > 200) {
            const text = item.block.text;
            const normalise = (s: string) => s.replace(/\s+/g, " ").trim();
            const normText = normalise(text);
            const normPlan = normalise(planContent);
            if (normPlan.includes(normText.slice(0, 200)) || normText.includes(normPlan.slice(0, 200))) {
              return (
                <details key={i} className="text-xs text-[var(--text-tertiary)]">
                  <summary className="cursor-pointer hover:text-[var(--text-secondary)] select-none inline-flex items-center gap-1.5 py-1">
                    <span className="px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 text-[10px] font-medium">Plan</span>
                    Plan description (shown in pinned block above)
                  </summary>
                  <div className="mt-1 pl-3 border-l border-[var(--border-color)]">
                    <ContentBlockView block={item.block} />
                  </div>
                </details>
              );
            }
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

marked.use({
  renderer: {
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<a href="${href}" class="text-[var(--accent)] underline" target="_blank" rel="noreferrer">${text}</a>`;
    },
  },
});

const markedOptions = {};

function MarkdownContent({ text }: { text: string }) {
  const html = useMemo(() => {
    // Unescape literal \n that may arrive from plan/tool content
    const unescaped = text.replace(/\\n/g, "\n");
    // Strip CLI XML-like tags (e.g. <command-message-help>, <command-name>)
    // that DOMPurify preserves as valid custom elements
    const cleaned = unescaped.replace(/<\/?[a-z]+-[a-z-]*>/g, "");
    const raw = marked.parse(cleaned, markedOptions) as string;
    if (text.includes("##") || text.includes("\\n")) {
      console.log("[MD debug] text:", JSON.stringify(text.slice(0, 200)));
      console.log("[MD debug] html:", raw.slice(0, 200));
    }
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

// ── Inline plan block (tool-call style) ─────────────────────────────

function InlinePlanBlock({ content }: { content: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const title = useMemo(() => {
    const m = content.match(/^#\s+(.+)$/m);
    return m ? m[1] : undefined;
  }, [content]);
  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);
  return (
    <div className="border border-[var(--border-color)] rounded-lg overflow-hidden w-[80%]">
      <div
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer"
      >
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span className="text-xs font-medium text-violet-400">Plan</span>
        {title && (
          <span className="text-xs font-mono text-[var(--text-tertiary)] truncate flex-1">
            {title}
          </span>
        )}
        <button
          onClick={handleCopy}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          title="Copy plan"
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
        <span className="text-xs text-green-400">✓</span>
      </div>
      {!collapsed && (
        <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 pt-3 pb-6 text-sm text-[var(--text-primary)] overflow-y-auto max-h-96">
          <MarkdownContent text={content} />
        </div>
      )}
    </div>
  );
}

// ── Image lightbox ─────────────────────────────────────────────────

function ImageWithLightbox({ src, thumbnail }: { src: string; thumbnail?: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <>
      <img
        src={src}
        className={thumbnail
          ? "w-full h-full object-cover cursor-zoom-in"
          : "max-w-full max-h-64 rounded-lg my-1 cursor-zoom-in"
        }
        alt="Attached image"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      />
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 cursor-zoom-out"
            onClick={() => setOpen(false)}
          >
            <img
              src={src}
              className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
              alt="Attached image"
              onClick={(e) => e.stopPropagation()}
            />
          </div>,
          document.body
        )}
    </>
  );
}

// ── Thinking block (collapsible) ───────────────────────────────────

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(false);
  const summary = thinking.replace(/\s+/g, " ").trim().slice(0, 100);
  return (
    <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
      >
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span className="text-xs font-medium text-sky-400">Thinking</span>
        {!open && summary && (
          <span className="text-xs text-[var(--text-tertiary)] truncate flex-1 font-mono">{summary}</span>
        )}
      </button>
      {open && (
        <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)] max-h-96 overflow-y-auto px-3 py-2">
          <MarkdownContent text={thinking} />
        </div>
      )}
    </div>
  );
}

// ── Content block rendering ────────────────────────────────────────

function ContentBlockView({ block }: { block: ContentBlock }) {
  if (block.type === "text" && block.text) {
    return <MarkdownContent text={block.text} />;
  }

  if (block.type === "thinking" && block.thinking) {
    return <ThinkingBlock thinking={block.thinking} />;
  }

  if (block.type === "image" && block.source) {
    const src = block.source.type === "base64"
      ? `data:${block.source.media_type};base64,${block.source.data}`
      : block.source.url ?? "";
    return <ImageWithLightbox src={src} />;
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
      const result = hl.codeToTokens(code, { lang, theme: "one-dark-pro" });
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

function WriteContentView({ filePath, content, startLine }: {
  filePath: string;
  content: string;
  startLine?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => content.split("\n"), [content]);
  const tokens = useShikiHighlight(content, filePath, containerRef);
  const maxLines = 30;
  const truncated = lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;
  const displayTokens = truncated ? tokens?.slice(0, maxLines) : tokens;
  const lineOffset = (startLine ?? 1) - 1;

  return (
    <div ref={containerRef} className="font-mono text-[11px] leading-[18px] overflow-x-auto">
      <table style={{ minWidth: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {displayLines.map((line, i) => (
            <tr key={i}>
              <td className="text-[var(--text-tertiary)] w-8 text-right select-none pr-2 align-top opacity-50">
                {i + 1 + lineOffset}
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
          <span className="block w-3.5 h-3.5 rounded-full border border-[var(--text-tertiary)] shrink-0" />
        );

        const textColor = todo.status === "completed"
          ? "text-[var(--text-tertiary)] line-through"
          : todo.status === "in_progress"
          ? "text-[var(--text-primary)] font-medium"
          : "text-[var(--text-secondary)]";

        const rowBg = todo.status === "in_progress"
          ? "bg-[var(--bg-tertiary)] rounded"
          : "";

        return (
          <div key={i} className={`flex items-start gap-2 px-1.5 py-0.5 -mx-1.5 ${rowBg}`}>
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

// ── Inline composer overlays ─────────────────────────────────────────

interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

function InlineQuestionComposer({
  questions,
  onAnswer,
}: {
  questions: AskQuestion[];
  onAnswer: (answer: Record<string, string>) => void;
}) {
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [customText, setCustomText] = useState("");
  const isSingle = questions.length === 1;

  const handleSelect = (qi: number, label: string) => {
    if (isSingle) {
      onAnswer({ [questions[0].question]: label });
    } else {
      setSelected((prev) => ({ ...prev, [qi]: label }));
    }
  };

  const handleCustomSubmit = () => {
    const text = customText.trim();
    if (!text) return;
    if (isSingle) {
      onAnswer({ [questions[0].question]: text });
    } else {
      const answers: Record<string, string> = {};
      questions.forEach((q) => { answers[q.question] = text; });
      onAnswer(answers);
    }
  };

  const allAnswered = !isSingle && questions.every((_, qi) => selected[qi] != null);

  const handleSubmit = () => {
    if (!allAnswered) return;
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => { answers[q.question] = selected[qi]; });
    onAnswer(answers);
  };

  return (
    <div className="flex flex-col gap-2">
      {questions.map((q, qi) => (
        <div key={qi} className="flex flex-col gap-1.5">
          {q.header && (
            <div className="text-[10px] font-semibold text-[var(--accent)] uppercase tracking-wide">
              {q.header}
            </div>
          )}
          <div className="text-xs text-[var(--text-secondary)]">
            {q.question}
          </div>
          {q.options && q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt, oi) => {
                const isSelected = selected[qi] === opt.label;
                return (
                  <button
                    key={oi}
                    onClick={() => handleSelect(qi, opt.label)}
                    title={opt.description}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      isSelected
                        ? "bg-[var(--accent)] text-white"
                        : "bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--accent)]/15 hover:text-[var(--accent)]"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      <div className="flex gap-1.5 mt-0.5">
        <input
          type="text"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleCustomSubmit(); }}
          placeholder="Type a custom answer…"
          className="flex-1 px-3 py-1.5 rounded-md text-xs bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border-color)] outline-none focus:border-[var(--accent)] transition-colors placeholder:text-[var(--text-tertiary)]"
        />
        <button
          disabled={!customText.trim()}
          onClick={handleCustomSubmit}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            customText.trim()
              ? "bg-[var(--accent)] text-white hover:bg-[var(--accent)]/90"
              : "bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] cursor-not-allowed"
          }`}
        >
          Send
        </button>
      </div>
      {!isSingle && (
        <button
          disabled={!allAnswered}
          onClick={handleSubmit}
          className={`self-end px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            allAnswered
              ? "bg-[var(--accent)] text-white hover:bg-[var(--accent)]/90"
              : "bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] cursor-not-allowed"
          }`}
        >
          Submit
        </button>
      )}
    </div>
  );
}

function InlinePermissionComposer({
  permission,
  onAllow,
  onDeny,
  onAllowInNew,
}: {
  permission: { toolName: string; input: Record<string, unknown> };
  onAllow: () => void;
  onDeny: () => void;
  onAllowInNew: () => void;
}) {
  const isExitPlan = permission.toolName === "ExitPlanMode";
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-[var(--text-secondary)]">
        {isExitPlan ? "Plan ready — how do you want to proceed?" : "Permission requested"}
      </div>
      {!isExitPlan && (
        <div className="text-sm text-[var(--text-primary)] font-mono truncate">
          {permission.toolName}
          {permission.input?.command != null && (
            <span className="text-[var(--text-tertiary)] ml-1">
              {String(permission.input.command).substring(0, 200)}
            </span>
          )}
          {permission.input?.file_path != null && (
            <span className="text-[var(--text-tertiary)] ml-1">
              {String(permission.input.file_path)}
            </span>
          )}
        </div>
      )}
      <div className="flex gap-2">
        {!isExitPlan && (
          <button
            onClick={onAllow}
            className="px-3 py-1.5 text-xs rounded-md bg-[var(--accent)] text-white hover:opacity-90 font-medium"
          >
            Allow
          </button>
        )}
        <button
          onClick={onAllowInNew}
          className="px-3 py-1.5 text-xs rounded-md bg-[var(--accent)] text-white hover:opacity-90 font-medium"
        >
          {isExitPlan ? "Execute" : "Allow in new"}
        </button>
        <button
          onClick={onDeny}
          className="px-3 py-1.5 text-xs rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  );
}


function getToolColor(toolName: string, isPlanFile = false): string {
  if (isPlanFile) return "text-violet-400";
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
}

function ToolBundleSummaryBar({
  bundle,
  expanded,
  onToggleBundle,
  toolStates,
  onToggleTool,
  isLastMessage,
}: {
  bundle: ToolBundle;
  expanded: boolean;
  onToggleBundle: () => void;
  toolStates: Record<string, "expanded" | "collapsed">;
  onToggleTool: (id: string, isCurrentlyExpanded: boolean) => void;
  isLastMessage: boolean;
}) {
  // Sort pills by count descending
  const pills = useMemo(() =>
    Object.entries(bundle.toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count, color: getToolColor(name) })),
    [bundle.toolCounts]
  );

  const totalCount = bundle.groups.length;
  const lastGroupId = bundle.groups[bundle.groups.length - 1].blockId;

  return (
    <div className="border border-[var(--border-subtle)] rounded-lg overflow-hidden shadow-sm">
      <button
        onClick={onToggleBundle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-all duration-150"
      >
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span className="text-xs text-[var(--text-secondary)] font-medium">
          {totalCount} tool calls
        </span>
        <span className="flex items-center gap-1.5 flex-1 min-w-0">
          {pills.map(({ name, count, color }) => (
            <span key={name} className={`text-[10px] font-medium ${color} opacity-80`}>
              {count} {name}
            </span>
          ))}
        </span>
        {bundle.allDone && !expanded && (
          <span className={`text-xs ${bundle.anyError ? "text-red-400" : "text-green-400"}`}>
            {bundle.anyError ? "✗" : "✓"}
          </span>
        )}
        {!bundle.allDone && !expanded && (
          <span className="w-3 h-3 border-2 border-[var(--text-tertiary)] border-t-transparent rounded-full animate-spin" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 flex flex-col gap-1.5">
          {bundle.groups.map((group) => {
            const isLast = isLastMessage && group.blockId === lastGroupId;
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
          })}
        </div>
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
  const rawToolName = group.toolUse.name || "Unknown tool";
  // Normalize tool names to PascalCase so OpenCode's lowercase names
  // (e.g. "write", "glob", "edit") match the same colors/summaries as Claude Code's
  const toolName = useMemo(() => {
    return canonicalToolName(rawToolName);
  }, [rawToolName]);
  const input = group.toolUse.input || {};
  // Detect Write/Edit targeting .claude/plans/ files
  const isPlanFile = (toolName === "Write" || toolName === "Edit") &&
    typeof input.file_path === "string" && (input.file_path as string).includes(".claude/plans/");
  // Tool has a result if either:
  // 1. We have an explicit tool_result block matched to it, OR
  // 2. This is not the last message (so Claude must have received the result to continue)
  const hasResult = !!group.toolResult || !isLastMessage;
  const isError = group.toolResult?.is_error;

  // Determine if this should be shown expanded:
  // - Expanded if manually expanded
  // - Expanded if last tool AND still in-progress (no result yet) AND not manually collapsed
  // - Plan file tools default to collapsed (unless manually expanded)
  const shouldExpand = isPlanFile
    ? expanded
    : expanded || (isLast && !hasResult && !collapsed);

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
      case "ExitPlanMode":
        return "Plan ready for review";
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
  const toolColor = useMemo(() => getToolColor(toolName, isPlanFile), [toolName, isPlanFile]);

  // Result content for inline display
  const resultContent = useMemo(() => {
    if (!group.toolResult) return null;
    const content = group.toolResult.content;
    return typeof content === "string" ? content : JSON.stringify(content, null, 2);
  }, [group.toolResult]);

  // For Read tool: strip `cat -n` line number prefixes and extract starting line
  const readContent = useMemo(() => {
    if (toolName !== "Read" || !resultContent) return null;
    const lines = resultContent.split("\n");
    let firstLineNum = 1;
    const stripped = lines.map((line, i) => {
      const m = line.match(/^\s*(\d+)\t(.*)$/);
      if (m) {
        if (i === 0) firstLineNum = parseInt(m[1], 10);
        return m[2];
      }
      return line;
    });
    return { content: stripped.join("\n"), startLine: firstLineNum };
  }, [toolName, resultContent]);

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
        <span className={`text-xs font-medium ${toolColor}`}>{isPlanFile ? "Plan" : toolName}</span>
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
          ) : toolName === "Read" && readContent && input.file_path ? (
            <div className="py-1">
              <WriteContentView
                filePath={input.file_path as string}
                content={readContent.content}
                startLine={readContent.startLine}
              />
            </div>
          ) : toolName === "TodoWrite" && input.todos ? (
            <TodoListView todos={input.todos as TodoItem[]} />
          ) : toolName === "ExitPlanMode" && resultContent ? (
            <div className="px-4 pt-3 pb-3 text-sm text-[var(--text-primary)] overflow-y-auto max-h-96">
              <MarkdownContent text={resultContent} />
            </div>
          ) : resultContent ? (
            <>
              <ToolInputView toolName={toolName} input={input} />
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
            </>
          ) : (
            <ToolInputView toolName={toolName} input={input} />
          )}
        </div>
      )}
    </div>
  );
}
