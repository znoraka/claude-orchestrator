import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { invoke } from "../../lib/bridge";
import { modelsForProvider } from "../../types";
import FilePickerModal, { type FileReference } from "../FilePickerModal";
import type { AgentChatProps, ChatMessage, ContentBlock, AskQuestion, ChangedFile, TodoItem } from "./types";
import { TodoListView } from "./messages/ToolExpandedDetail";
import { normalizeContent, normaliseWs, canonicalToolName } from "./constants";
import { useStreamAccumulator } from "./hooks/useStreamAccumulator";
import { useScrollManager } from "./hooks/useScrollManager";
import { useVirtualMessages } from "./hooks/useVirtualMessages";
import { useAttachments } from "./hooks/useAttachments";
import { useInputAutocomplete } from "./hooks/useInputAutocomplete";
import { useHistoryLoader, parseContentWithImages } from "./hooks/useHistoryLoader";
import { useAgentEvents } from "./hooks/useAgentEvents";
import { useMessageActions } from "./hooks/useMessageActions";
import { MessageBubble } from "./messages/MessageList";
import { ChatInput } from "./input/ChatInput";

interface PendingTodosPanelProps {
  todos: TodoItem[];
  collapsed: boolean;
  onToggle: () => void;
}

function PendingTodosPanel({ todos, collapsed, onToggle }: PendingTodosPanelProps) {
  const completedCount = todos.filter((t) => t.status === "completed").length;
  const inProgressCount = todos.filter((t) => t.status === "in_progress").length;

  return (
    <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-2 hover:bg-[var(--bg-hover)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-[var(--text-tertiary)] shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <span className="text-xs font-medium text-[var(--text-secondary)]">Tasks</span>
          <div className="flex items-center gap-1">
            {inProgressCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 font-medium">
                {inProgressCount} active
              </span>
            )}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]">
              {completedCount}/{todos.length}
            </span>
          </div>
        </div>
        <svg
          className={`w-3.5 h-3.5 text-[var(--text-tertiary)] transition-transform duration-150 ${collapsed ? "" : "rotate-180"}`}
          viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2}
        >
          <polyline points="4 7 10 13 16 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {!collapsed && (
        <div className="px-1 pb-2 max-h-48 overflow-y-auto">
          <TodoListView todos={todos} />
        </div>
      )}
    </div>
  );
}

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
  onOpenFile,
  providerAvailability,
  onProviderChange,
  onStartPendingSession,
}: AgentChatProps) {
  const isReadOnly = session?.status === "stopped";
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentTodo, setCurrentTodo] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<{ toolName: string; input: Record<string, unknown> } | null>(null);
  const pendingPermissionRef = useRef<{ toolName: string; input: Record<string, unknown> } | null>(null);
  pendingPermissionRef.current = pendingPermission;
  const [pendingQuestion, setPendingQuestion] = useState<{ blockId: string; questions: AskQuestion[] } | null>(null);
  const [toolStates, setToolStates] = useState<Record<string, "expanded" | "collapsed">>({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [fileReferences, setFileReferences] = useState<FileReference[]>([]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [viewingFileRef, setViewingFileRef] = useState<FileReference | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">("high");
  const [openPill, setOpenPill] = useState<"provider" | "model" | "mode" | "effort" | null>(null);
  const [todosPanelCollapsed, setTodosPanelCollapsed] = useState(false);
  const [modelSearchTerm, setModelSearchTerm] = useState("");
  const [queuedMessage, setQueuedMessage] = useState<{
    text: string; images: Array<{ id: string; data: string; mediaType: string; name: string }>;
    fileReferences: FileReference[]; pastedFiles: Array<{ id: string; name: string; content: string; mimeType: string }>;
  } | null>(null);
  const [currentBranch, setCurrentBranch] = useState("");

  const abortedRef = useRef(false);
  const planDeniedRef = useRef(false);
  const generationStartRef = useRef<number>(0);
  const isGeneratingRef = useRef(false);
  const isGeneratingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationCountRef = useRef(0);
  const queuedMessageRef = useRef<typeof queuedMessage>(null);
  const sendMessageRef = useRef<((...args: Parameters<typeof sendMessage>) => void) | null>(null);
  const sendPlanFeedbackRef = useRef<((text: string) => void) | null>(null);
  const mountedRef = useRef(true);
  const pendingPromptConsumedRef = useRef(false);
  const queuedQuestionAnswerRef = useRef<Record<string, string> | null>(null);
  const titleGeneratedRef = useRef(!!session?.hasTitleBeenGenerated);
  const accumulatedUsageRef = useRef({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, contextTokens: 0 });

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const inputHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const savedInputRef = useRef<string>("");
  const pillRowRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);

  // Stable refs for callback props
  const wrappedOnExit = useCallback((exitCode?: number) => {
    onExit(planDeniedRef.current ? undefined : exitCode);
    planDeniedRef.current = false;
  }, [onExit]);
  const onExitRef = useRef(wrappedOnExit); onExitRef.current = wrappedOnExit;
  const onActivityRef = useRef(onActivity); onActivityRef.current = onActivity;
  const onBusyChangeRef = useRef(onBusyChange); onBusyChangeRef.current = onBusyChange;
  const onDraftChangeRef = useRef(onDraftChange); onDraftChangeRef.current = onDraftChange;
  const onQuestionChangeRef = useRef(onQuestionChange); onQuestionChangeRef.current = onQuestionChange;
  const onClaudeSessionIdRef = useRef(onClaudeSessionId); onClaudeSessionIdRef.current = onClaudeSessionId;
  const onResumeRef = useRef(onResume); onResumeRef.current = onResume;
  const onStartPendingSessionRef = useRef(onStartPendingSession); onStartPendingSessionRef.current = onStartPendingSession;
  const sessionRef = useRef(session); sessionRef.current = session;
  const onForkRef = useRef(onFork); onForkRef.current = onFork;
  const onForkWithPromptRef = useRef(onForkWithPrompt); onForkWithPromptRef.current = onForkWithPrompt;
  const onAvailableModelsRef = useRef(onAvailableModels); onAvailableModelsRef.current = onAvailableModels;
  const onRenameRef = useRef(onRename); onRenameRef.current = onRename;
  const onMarkTitleGeneratedRef = useRef(onMarkTitleGenerated); onMarkTitleGeneratedRef.current = onMarkTitleGenerated;
  const onClearPendingPromptRef = useRef(onClearPendingPrompt); onClearPendingPromptRef.current = onClearPendingPrompt;
  const onUsageUpdateRef = useRef(onUsageUpdate); onUsageUpdateRef.current = onUsageUpdate;
  const currentModelRef = useRef(currentModel); currentModelRef.current = currentModel;

  const activeModels = activeModelsProp || modelsForProvider(session?.provider || "claude-code");
  const filteredModels = useMemo(() => {
    if (!modelSearchTerm) return activeModels;
    const term = modelSearchTerm.toLowerCase();
    return activeModels.filter(m =>
      m.name.toLowerCase().includes(term) || m.id.toLowerCase().includes(term) || m.desc?.toLowerCase().includes(term)
    );
  }, [activeModels, modelSearchTerm]);

  const activeChildSessionId = useMemo(
    () => childSessions?.find(c => c.status === "running" || c.status === "starting")?.id ?? null,
    [childSessions]
  );
  const targetSessionId = activeChildSessionId ?? sessionId;
  const sessionDir = session?.directory;

  // Sync busy state
  useEffect(() => {
    onBusyChangeRef.current?.(isGenerating);
    if (isGenerating) onQuestionChangeRef.current?.(false);
  }, [isGenerating]);

  // Sync draft state
  useEffect(() => { onDraftChangeRef.current?.(inputText.trim().length > 0); }, [inputText]);

  // Close pill on outside click
  useEffect(() => {
    if (!openPill) { setModelSearchTerm(""); return; }
    if (openPill === "model") setTimeout(() => modelSearchRef.current?.focus(), 50);
    const handleClick = (e: MouseEvent) => {
      if (pillRowRef.current && !pillRowRef.current.contains(e.target as Node)) setOpenPill(null);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [openPill]);

  // Reset textarea height
  useEffect(() => {
    if (!inputText && inputRef.current) inputRef.current.style.height = "auto";
  }, [inputText]);

  // Auto-focus when typing anywhere (only for the active session)
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || inputRef.current === document.activeElement ||
        (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA"))) return;
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isActive]);

  // Cmd+O to open file picker
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "o") { e.preventDefault(); setShowFilePicker(true); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isActive]);

  // Focus on active — retry briefly in case the input hasn't mounted yet
  useEffect(() => {
    if (!isActive) return;
    let attempts = 0;
    const tryFocus = () => {
      if (inputRef.current) {
        inputRef.current.focus();
      } else if (attempts < 10) {
        attempts++;
        id = requestAnimationFrame(tryFocus);
      }
    };
    let id = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(id);
  }, [isActive]);

  const addFileReference = useCallback((ref: FileReference) => {
    setFileReferences((prev) => {
      const existing = prev.findIndex((r) => r.filePath === ref.filePath);
      if (existing >= 0) { const next = [...prev]; next[existing] = ref; return next; }
      return [...prev, ref];
    });
    inputRef.current?.focus();
  }, []);

  const removeFileReference = useCallback((filePath: string) => {
    setFileReferences((prev) => prev.filter((r) => r.filePath !== filePath));
  }, []);

  // Current git branch
  useEffect(() => {
    if (!sessionDir) return;
    let cancelled = false;
    invoke<{ branch: string; files: unknown[]; is_git_repo: boolean }>("get_git_status", { directory: sessionDir })
      .then((result) => { if (!cancelled && result.is_git_repo) setCurrentBranch(result.branch); })
      .catch(() => { });
    return () => { cancelled = true; };
  }, [sessionDir]);

  // Stream accumulator
  const streamAccumulator = useStreamAccumulator(setMessages);
  const { accumulatedBlocksRef, currentStreamIdRef, flushPendingStream } = streamAccumulator;

  // Scroll manager
  const { scrollRef, isAtBottomRef, isAtBottom, scrollToBottom, handleScroll } = useScrollManager(isActive);
  const suppressNextScrollRef = useRef(false);

  // Attachments
  const { images, setImages, pastedFiles, setPastedFiles, isDragging, handlePaste, removeImage, removePastedFile } = useAttachments(isActive, inputRef);

  // When editing, hide messages after the edit point (they'll be removed on submit)
  const displayMessages = useMemo(() => {
    if (!editingMessageId) return messages;
    const idx = messages.findIndex((m) => m.id === editingMessageId);
    return idx >= 0 ? messages.slice(0, idx) : messages;
  }, [messages, editingMessageId]);

  // Virtual messages
  const {
    allMessages, hasMore, loadMore, useVirtualRendering, isLayoutReady,
    rowVirtualizer, virtualizerTotalSize, virtualItems, deferredMessages, trailingMessages,
  } = useVirtualMessages(displayMessages, isActive, sessionId, scrollRef, isGenerating);

  // Modified files (for "Changed files" panel), scoped per run
  const modifiedFilesByResult = useMemo(() => {
    if (!onOpenFile) return new Map<string, ChangedFile[]>();
    const dir = session?.directory;
    const prefix = dir ? (dir.endsWith("/") ? dir : dir + "/") : "";

    function computeFiles(msgs: ChatMessage[]): ChangedFile[] {
      const fileMap = new Map<string, { added: number; removed: number; chunks: string[] }>();
      for (const m of msgs) {
        if (m.type !== "assistant") continue;
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const b of blocks) {
          if (b.type !== "tool_use") continue;
          const name = canonicalToolName(b.name ?? "");
          const fp = b.input?.file_path as string;
          if (!fp) continue;
          const relPath = prefix && fp.startsWith(prefix) ? fp.slice(prefix.length) : fp;
          const prev = fileMap.get(relPath) ?? { added: 0, removed: 0, chunks: [] };
          if (name === "Write") {
            const content = (b.input?.content as string) ?? "";
            const lines = content.split("\n").length;
            const chunk = content.split("\n").map((l: string) => `+${l}`).join("\n");
            fileMap.set(relPath, { added: prev.added + lines, removed: prev.removed, chunks: [...prev.chunks, `@@ -0,0 +1,${lines} @@\n${chunk}`] });
          } else if (name === "Edit") {
            const oldStr = (b.input?.old_string as string) ?? (b.input?.old_str as string) ?? "";
            const newStr = (b.input?.new_string as string) ?? (b.input?.new_str as string) ?? "";
            const removed = oldStr ? oldStr.split("\n").length : 0;
            const added = newStr ? newStr.split("\n").length : 0;
            const oldStart = prev.removed + 1; const newStart = prev.added + 1;
            const chunk = [`@@ -${oldStart},${removed} +${newStart},${added} @@`, ...oldStr.split("\n").map((l: string) => `-${l}`), ...newStr.split("\n").map((l: string) => `+${l}`)].join("\n");
            fileMap.set(relPath, { added: prev.added + added, removed: prev.removed + removed, chunks: [...prev.chunks, chunk] });
          }
        }
      }
      for (const m of msgs) {
        if (m.type !== "assistant") continue;
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const b of blocks) {
          if (b.type !== "tool_use" || canonicalToolName(b.name ?? "") !== "FileChange") continue;
          const changes = (b.input?.changes as Array<{ kind: string; path: string }>) ?? [];
          for (const c of changes) {
            const relPath = prefix && c.path.startsWith(prefix) ? c.path.slice(prefix.length) : c.path;
            if (!fileMap.has(relPath)) fileMap.set(relPath, { added: 0, removed: 0, chunks: [] });
          }
        }
      }
      return Array.from(fileMap.entries()).map(([path, { added, removed, chunks }]) => ({
        path, added, removed,
        diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${chunks.join("\n")}`,
      }));
    }

    const resultMap = new Map<string, ChangedFile[]>();
    let runStart = 0;
    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i];
      if (msg.type === "user") {
        runStart = i + 1;
      } else if (msg.type === "result") {
        const files = computeFiles(allMessages.slice(runStart, i));
        if (files.length > 0) resultMap.set(msg.id, files);
      }
    }
    return resultMap;
  }, [allMessages, onOpenFile, session?.directory]);

  const latestTodos = useMemo<TodoItem[] | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== "assistant") continue;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j];
        if (block.type === "tool_use" && block.name === "TodoWrite" && Array.isArray((block.input as { todos?: unknown })?.todos)) {
          return (block.input as { todos: TodoItem[] }).todos;
        }
      }
    }
    return null;
  }, [messages]);

  const hasPendingTodos = useMemo(
    () => latestTodos !== null && latestTodos.some((t) => t.status === "pending"),
    [latestTodos]
  );

  // Sentinel for load-more
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    const container = scrollRef.current;
    if (!el || !container) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          const prevHeight = container.scrollHeight;
          loadMore();
          requestAnimationFrame(() => { container.scrollTop += container.scrollHeight - prevHeight; });
        }
      },
      { root: container, rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  // Stop generating logic
  const stopGenerating = useCallback(() => {
    if (isGeneratingTimeoutRef.current) { isGeneratingTimeoutRef.current = null; return; }
    isGeneratingTimeoutRef.current = 1 as unknown as ReturnType<typeof setTimeout>;
    const generation = generationCountRef.current;
    queueMicrotask(() => {
      isGeneratingTimeoutRef.current = null;
      if (generationCountRef.current !== generation) return;
      const queued = queuedMessageRef.current;
      if (queued && !abortedRef.current && sendMessageRef.current) {
        queuedMessageRef.current = null;
        setQueuedMessage(null);
        isGeneratingRef.current = false;
        sendMessageRef.current(queued.text || undefined, queued.images, queued.fileReferences, queued.pastedFiles);
        isGeneratingTimeoutRef.current = 1 as unknown as ReturnType<typeof setTimeout>;
      } else {
        isGeneratingRef.current = false;
        setIsGenerating(false);
      }
    });
  }, []);

  function looksLikeTaskPrompt(text: string): boolean {
    if (!text || text.length < 50) return false;
    const lines = text.split("\n");
    if (lines.length < 3) return false;
    const hasInstructionalPatterns = text.includes("Focus on") || text.includes("I need to understand") ||
      text.includes("Return file paths") || text.includes("Return the") || text.includes("Do not") ||
      text.includes("Make sure to") || /thoroughly|comprehensive|investigate|explore|search/i.test(text);
    const hasNumberedList = /^\s*\d+\.\s/m.test(text) && /^\s*[2-9]\.\s/m.test(text);
    return hasInstructionalPatterns && (hasNumberedList || lines.length >= 5);
  }

  function looksLikeBackgroundTaskNotification(text: string): boolean {
    return /^[a-z0-9]+\ntoolu_/.test(text) && text.includes("completed");
  }

  const sdkMessageToChatMessage = useCallback((msg: Record<string, unknown>, isHistoryReplay = false): ChatMessage | null => {
    const msgType = msg.type as string;

    if (msgType === "user") {
      if (!isHistoryReplay) {
        const message = msg.message as Record<string, unknown> | undefined;
        const rawContent = normalizeContent(message?.content);
        if (rawContent && currentStreamIdRef.current) {
          const toolResults = rawContent.filter((b) => b.type === "tool_result");
          if (toolResults.length > 0) {
            const streamId = currentStreamIdRef.current;
            const existing = accumulatedBlocksRef.current.get(streamId) || [];
            const existingIds = new Set(existing.filter((b) => b.type === "tool_result").map((b) => (b as { tool_use_id?: string }).tool_use_id));
            const newResults = toolResults.filter((b) => !existingIds.has((b as { tool_use_id?: string }).tool_use_id));
            if (newResults.length > 0) {
              const updated = [...existing, ...newResults];
              accumulatedBlocksRef.current.set(streamId, updated);
              streamAccumulator.pendingStreamRef.current = { id: streamId, content: updated };
              flushPendingStream();
            }
          }
        }
        return null;
      }

      const message = msg.message as Record<string, unknown> | undefined;
      const rawContent = message?.content;
      let blocks: ContentBlock[];
      if (typeof rawContent === "string") blocks = parseContentWithImages(rawContent);
      else if (Array.isArray(rawContent)) blocks = rawContent as ContentBlock[];
      else return null;

      const hasToolResults = blocks.some((b) => b.type === "tool_result");
      if (hasToolResults) return null;
      const visibleBlocks = blocks.filter((b) => {
        if (b.type === "text" && typeof b.text === "string" && b.text.trimStart().startsWith("<system-reminder>")) return false;
        return true;
      });
      if (visibleBlocks.length === 0) return null;
      const textContent = visibleBlocks.find((b) => b.type === "text")?.text || "";
      if (looksLikeBackgroundTaskNotification(textContent)) return null;
      if (looksLikeTaskPrompt(textContent)) {
        const isPlanMessage = session?.planContent && textContent.length > 200 &&
          normaliseWs(textContent).includes(normaliseWs(session.planContent).slice(0, 200));
        if (!isPlanMessage) return null;
      }
      return { id: `user-${Date.now()}-${Math.random()}`, type: "user", content: visibleBlocks, timestamp: Date.now() };
    }

    if (msgType === "assistant") {
      const messageObj = msg.message as Record<string, unknown> | undefined;
      const content = normalizeContent(messageObj?.content);
      if (!content) return null;
      return { id: `assistant-${Date.now()}-${Math.random()}`, type: "assistant", content, timestamp: Date.now() };
    }

    if (msgType === "result") {
      return {
        id: `result-${Date.now()}-${Math.random()}`, type: "result",
        content: [{ type: "text", text: (msg.result as string) || "" }], timestamp: Date.now(),
        costUsd: msg.cost_usd as number | undefined,
        usage: msg.usage as { input_tokens?: number; output_tokens?: number } | undefined,
      };
    }

    if (msgType === "error") {
      return {
        id: `error-${Date.now()}-${Math.random()}`, type: "error",
        content: [{ type: "text", text: (msg.error as string) || "Unknown error" }], timestamp: Date.now(),
      };
    }

    return null;
  }, [session?.planContent]);

  // History loader
  const { childSessionsKey } = useHistoryLoader({
    sessionId, session, isActive, childSessions, parentSession,
    setMessages, sdkMessageToChatMessage,
  });

  // Recover ephemeral state from loaded messages (survives page refresh)
  const hasRecoveredStateRef = useRef(false);
  // Reset recovery flag when switching sessions
  useEffect(() => { hasRecoveredStateRef.current = false; }, [sessionId]);
  useEffect(() => {
    if (hasRecoveredStateRef.current || messages.length === 0) return;
    // Only run once per session after initial history load
    hasRecoveredStateRef.current = true;

    const ownMessages = messages.filter(m => !m.isParentMessage);
    if (ownMessages.length === 0) return;

    const lastMsg = ownMessages[ownMessages.length - 1];

    // 1. Recover pendingQuestion: scan last assistant message for AskUserQuestion tool_use.
    //    Run this BEFORE the isGenerating gate — there's a race with useAgentEvents'
    //    history scan which may set isGeneratingRef=true before this effect fires,
    //    causing question recovery to be skipped entirely.
    if (lastMsg.type === "assistant") {
      const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : [];
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j];
        if (block.type === "tool_use" && block.name === "AskUserQuestion") {
          const input = (block as { input?: { questions?: AskQuestion[] } }).input;
          const questions = Array.isArray(input?.questions) ? input.questions : [];
          if (questions.length > 0) {
            setPendingQuestion({ blockId: (block as { id: string }).id, questions });
            break;
          }
        }
      }
    }

    // Skip remaining recovery if already generating (live session connected)
    if (isGeneratingRef.current) return;

    // Skip isGenerating/todo recovery for stopped sessions — they are not processing
    // anything and marking them as generating would cause messages to be silently queued.
    if (isReadOnly) return;

    // 2. Recover isGenerating: if the last message is "user" type, Claude is processing;
    //    also if the last message is "assistant" with tool_use blocks (tool execution in progress)
    if (lastMsg.type === "user") {
      setIsGenerating(true);
      isGeneratingRef.current = true;
    } else if (lastMsg.type === "assistant") {
      const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : [];
      const hasToolUse = blocks.some((b: ContentBlock) => b.type === "tool_use");
      if (hasToolUse) {
        setIsGenerating(true);
        isGeneratingRef.current = true;
      }
    }

    // 3. Recover currentTodo: find last TodoWrite tool_use in messages
    for (let i = ownMessages.length - 1; i >= 0; i--) {
      const msg = ownMessages[i];
      if (msg.type !== "assistant") continue;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j];
        if (block.type === "tool_use" && block.name === "TodoWrite" && block.input) {
          const todos = (block.input as { todos?: Array<{ status: string; activeForm?: string; content: string }> }).todos;
          if (todos) {
            const inProgress = todos.find(t => t.status === "in_progress");
            setCurrentTodo(inProgress?.activeForm || inProgress?.content || null);
          }
          // Found the latest TodoWrite, stop searching
          i = -1; // break outer loop
          break;
        }
      }
    }
  }, [messages]);

  // Agent events
  useAgentEvents({
    sessionId, childSessions, childSessionsKey, session,
    mountedRef, isGeneratingRef, setIsGenerating, stopGenerating,
    abortedRef, generationStartRef, accumulatedUsageRef, queuedMessageRef,
    pendingPermissionRef,
    setMessages, setCurrentTodo, setPendingPermission, setPendingQuestion,
    pendingPromptConsumedRef, currentModelRef, titleGeneratedRef,
    streamAccumulator,
    currentStreamIdRef,
    onExitRef, onQuestionChangeRef, onClaudeSessionIdRef, onAvailableModelsRef,
    onUsageUpdateRef, onClearPendingPromptRef, onRenameRef, onMarkTitleGeneratedRef,
    queuedQuestionAnswerRef,
    sdkMessageToChatMessage,
    parseContentWithImages,
    looksLikeTaskPrompt,
    looksLikeBackgroundTaskNotification,
    normaliseWs,
  });

  // sendMessage
  const sendMessage = useCallback(async (
    overrideText?: string,
    overrideImages?: Array<{ id: string; data: string; mediaType: string; name: string }>,
    overrideFileRefs?: FileReference[],
    overridePastedFiles?: Array<{ id: string; name: string; content: string; mimeType: string }>,
  ) => {
    const activeImages = overrideImages ?? images;
    const activeFileRefs = overrideFileRefs ?? fileReferences;
    const activePastedFiles = overridePastedFiles ?? pastedFiles;
    const text = (overrideText ?? inputText).trim();
    if (!text && activeImages.length === 0 && activePastedFiles.length === 0) return;
    if (text) {
      inputHistoryRef.current.push(text);
      historyIndexRef.current = -1;
      savedInputRef.current = "";
    }

    // If plan is pending, route as plan feedback (deny + resend)
    if (pendingPermission?.toolName === "ExitPlanMode" && text && !editingMessageId) {
      setInputText("");
      sendPlanFeedbackRef.current?.(text);
      return;
    }

    // If a question is pending, treat this message as the answer
    if (pendingQuestion && text) {
      onQuestionChangeRef.current?.(false);
      setPendingQuestion(null);
      const answer: Record<string, string> = {};
      for (const q of pendingQuestion.questions) {
        answer[q.question] = text;
      }
      const msg = JSON.stringify({ type: "ask_user_answer", answer });
      invoke("send_agent_message", { sessionId: targetSessionId, message: msg })
        .catch(() => { setInputText(text); inputRef.current?.focus(); });
      setMessages((prev) => [...prev, { id: `user-${Date.now()}`, type: "user", content: [{ type: "text", text }], timestamp: Date.now() }]);
      setInputText("");
      return;
    }

    if (text && !titleGeneratedRef.current && messages.length === 0) {
      const title = text.slice(0, 50).trimEnd();
      onRenameRef.current?.(title);
      onMarkTitleGeneratedRef.current?.();
      titleGeneratedRef.current = true;
    }

    if (isGeneratingRef.current) {
      const queued = { text: overrideText ?? inputText, images: [...activeImages], fileReferences: [...activeFileRefs], pastedFiles: [...activePastedFiles] };
      if (!queued.text.trim() && queued.images.length === 0 && queued.pastedFiles.length === 0) return;
      queuedMessageRef.current = queued;
      setQueuedMessage(queued);
      setInputText(""); setImages([]); setFileReferences([]); setPastedFiles([]);
      return;
    }

    isAtBottomRef.current = true;
    requestAnimationFrame(() => scrollToBottom());

    // When editing, build a system prompt from the conversation context up to the edit point
    // so we can start a fresh LLM session without the old history.
    let editSystemPrompt: string | null = null;
    if (editingMessageId) {
      const editIdx = messages.findIndex((m) => m.id === editingMessageId);
      if (editIdx > 0) {
        const transcript = messages.slice(0, editIdx).filter((m) => !m.isParentMessage);
        const lines = transcript.map((m) => {
          const mText = Array.isArray(m.content)
            ? m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
            : "";
          if (m.type === "user") return `Human: ${mText}`;
          if (m.type === "assistant") return `Assistant: ${mText}`;
          return "";
        }).filter(Boolean);
        if (lines.length > 0) {
          editSystemPrompt = `This conversation was edited. Here is the conversation context before the edited message:\n\n<edit-context>\n${lines.join("\n\n")}\n</edit-context>\n\nContinue from this context. The user will now send their edited message.`;
        }
      }
      setMessages((prev) => { const idx = prev.findIndex((m) => m.id === editingMessageId); return idx >= 0 ? prev.slice(0, idx) : prev; });
      setEditingMessageId(null);
      if (pendingQuestion) { setPendingQuestion(null); onQuestionChangeRef.current?.(false); }
      if (pendingPermission) {
        setPendingPermission(null); onQuestionChangeRef.current?.(false);
        stopGenerating(); onUsageUpdateRef.current?.({ ...accumulatedUsageRef.current, isBusy: false });
        const deny = JSON.stringify({ type: "permission_response", allowed: false });
        invoke("send_agent_message", { sessionId: targetSessionId, message: deny }).catch(() => { });
      }
    }

    if (text === "/clear") { setMessages([]); setInputText(""); return; }
    if (text === "/compact") { setInputText(""); sendMessage("Please provide a brief summary of our conversation so far, then we can continue from that context."); return; }
    if (text === "/session-id") { const sid = sessionRef.current?.claudeSessionId; if (sid) navigator.clipboard.writeText(sid); setInputText(""); return; }
    if (text === "/editor" || text.startsWith("/editor ")) {
      const arg = text.slice("/editor".length).trim();
      if (arg) { localStorage.setItem("claude-orchestrator-editor-command", arg); setMessages((prev) => [...prev, { id: `editor-${Date.now()}`, type: "system", content: [{ type: "text", text: `Editor set to: ${arg}` }], timestamp: Date.now() }]); }
      else { const current = localStorage.getItem("claude-orchestrator-editor-command") || "code"; setMessages((prev) => [...prev, { id: `editor-${Date.now()}`, type: "system", content: [{ type: "text", text: `Current editor: ${current}\nUsage: /editor <command> (e.g. code, cursor, zed, subl)` }], timestamp: Date.now() }]); }
      setInputText(""); return;
    }

    const refs = activeFileRefs;
    let fileContext = "";
    if (refs.length > 0) {
      fileContext = refs.map((ref) => {
        const lineRange = ref.startLine === 1 && ref.endLine >= ref.content.split("\n").length ? "" : `:${ref.startLine}-${ref.endLine}`;
        return `<file path="${ref.filePath}${lineRange}">\n${ref.content}\n</file>`;
      }).join("\n\n") + "\n\n";
    }

    let pastedFileContext = "";
    if (activePastedFiles.length > 0) {
      pastedFileContext = activePastedFiles.map(f => `<file name="${f.name}">\n${f.content}\n</file>`).join("\n\n") + "\n\n";
    }

    const fullText = fileContext + pastedFileContext + text;
    let content: unknown;
    if (activeImages.length > 0) {
      const blocks: unknown[] = [];
      for (const img of activeImages) blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
      if (fullText) blocks.push({ type: "text", text: fullText });
      content = blocks;
    } else {
      content = fullText;
    }

    const displayParts: ContentBlock[] = [];
    if (refs.length > 0) {
      const refSummary = refs.map((ref) => { const lineRange = ref.startLine === 1 && ref.endLine >= ref.content.split("\n").length ? "" : `:${ref.startLine}-${ref.endLine}`; return `📎 ${ref.filePath}${lineRange}`; }).join("\n");
      displayParts.push({ type: "text", text: refSummary });
    }
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`, type: "user",
      content: [...activeImages.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })), ...displayParts, ...(text ? [{ type: "text", text }] : [])],
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInputText(""); setImages([]); setFileReferences([]); setPastedFiles([]);
    abortedRef.current = false;
    generationStartRef.current = Date.now();
    generationCountRef.current += 1;
    isGeneratingRef.current = true;
    setIsGenerating(true);
    onActivityRef.current();

    if (sessionRef.current?.status === "pending" && onStartPendingSessionRef.current) {
      try { await onStartPendingSessionRef.current(sessionRef.current.provider, currentModel); }
      catch (err) {
        stopGenerating();
        setMessages((prev) => [...prev, { id: `error-${Date.now()}`, type: "error", content: [{ type: "text", text: `Failed to start session: ${err}` }], timestamp: Date.now() }]);
        return;
      }
    }

    if (isReadOnly && onResumeRef.current) {
      try { await onResumeRef.current(); }
      catch (err) {
        stopGenerating();
        setMessages((prev) => [...prev, { id: `error-${Date.now()}`, type: "error", content: [{ type: "text", text: `Failed to resume session: ${err}` }], timestamp: Date.now() }]);
        return;
      }
    }

    if (sessionRef.current?.permissionMode === "plan") {
      try {
        const classification = await invoke<string>("classify_prompt", { message: typeof content === "string" ? content : text });
        const targetMode = classification === "simple" ? "bypassPermissions" : "plan";
        const modeMsg = JSON.stringify({ type: "set_permission_mode", permissionMode: targetMode });
        await invoke("send_agent_message", { sessionId: targetSessionId, message: modeMsg });
      } catch { }
    }

    const jsonLine = JSON.stringify({ type: "user", message: { role: "user", content } });

    // Edit flow: destroy old session and start fresh with conversation context as system prompt
    if (editSystemPrompt !== null) {
      try {
        await invoke("destroy_agent_session", { sessionId: targetSessionId }).catch(() => {});
        const dir = sessionRef.current?.directory || "";
        await invoke("create_agent_session", {
          sessionId: targetSessionId,
          directory: dir,
          claudeSessionId: null,
          resume: false,
          systemPrompt: editSystemPrompt,
          provider: sessionRef.current?.provider || "claude-code",
          model: currentModelRef.current || null,
          permissionMode: sessionRef.current?.permissionMode || null,
        });
        await invoke("send_agent_message", { sessionId: targetSessionId, message: jsonLine });
      } catch (err) {
        stopGenerating();
        setMessages((prev) => [...prev, { id: `error-${Date.now()}`, type: "error", content: [{ type: "text", text: `Failed to send edited message: ${err}` }], timestamp: Date.now() }]);
      }
      return;
    }

    const trySend = async (attempt: number) => {
      try {
        await invoke("send_agent_message", { sessionId: targetSessionId, message: jsonLine });
        if (sessionRef.current?.provider !== "claude-code" && !titleGeneratedRef.current && text) {
          titleGeneratedRef.current = true;
          invoke<string | null>("generate_title_from_text", { message: text })
            .then((title) => { if (title) { onRenameRef.current?.(title); onMarkTitleGeneratedRef.current?.(); } })
            .catch(() => { });
        }
      } catch (err) {
        const errStr = String(err);
        const MAX_RETRIES = 10;
        if (attempt < MAX_RETRIES && errStr.includes("query is already in progress")) { setTimeout(() => trySend(attempt + 1), 500); return; }
        if (attempt === 0 && errStr.includes("session not found") && onResumeRef.current) {
          try { await onResumeRef.current(); await new Promise((r) => setTimeout(r, 300)); trySend(1); return; }
          catch (resumeErr) { stopGenerating(); setMessages((prev) => [...prev, { id: `error-${Date.now()}`, type: "error", content: [{ type: "text", text: `Failed to resume session: ${resumeErr}` }], timestamp: Date.now() }]); return; }
        }
        stopGenerating();
        setMessages((prev) => [...prev, { id: `error-${Date.now()}`, type: "error", content: [{ type: "text", text: `Failed to send: ${err}` }], timestamp: Date.now() }]);
      }
    };
    trySend(0);
  }, [inputText, images, pastedFiles, targetSessionId, isReadOnly, editingMessageId, fileReferences, scrollToBottom, pendingQuestion, pendingPermission]);
  sendMessageRef.current = sendMessage;

  const handleAbort = useCallback(() => {
    queuedMessageRef.current = null; setQueuedMessage(null);
    invoke("abort_agent", { sessionId: targetSessionId }).catch(() => { });
    abortedRef.current = true; isGeneratingTimeoutRef.current = null;
    isGeneratingRef.current = false; setIsGenerating(false); setCurrentTodo(null);
    accumulatedBlocksRef.current.clear();
  }, [targetSessionId]);

  const answerQuestion = useCallback(async (answer: Record<string, string>) => {
    onQuestionChangeRef.current?.(false); setPendingQuestion(null);
    const displayText = Object.values(answer).join("\n");
    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, type: "user", content: [{ type: "text", text: displayText }], timestamp: Date.now(), questionAnswer: answer }]);

    // If the bridge is alive, send immediately
    if (sessionRef.current?.status === "running" || sessionRef.current?.status === "starting") {
      const msg = JSON.stringify({ type: "ask_user_answer", answer });
      invoke("send_agent_message", { sessionId: targetSessionId, message: msg }).catch(() => {
        setInputText(displayText); inputRef.current?.focus();
      });
      return;
    }

    // Bridge is dead (e.g. question recovered after restart).
    // Queue the answer — it will be sent when the bridge re-emits ask_user_question
    // after resuming and replaying the conversation.
    queuedQuestionAnswerRef.current = answer;
    isGeneratingRef.current = true; setIsGenerating(true);
    if (onResumeRef.current) {
      try { await onResumeRef.current(); }
      catch (err) {
        queuedQuestionAnswerRef.current = null;
        stopGenerating();
        setMessages((prev) => [...prev, { id: `error-${Date.now()}`, type: "error", content: [{ type: "text", text: `Failed to resume session: ${err}` }], timestamp: Date.now() }]);
      }
    }
  }, [targetSessionId, stopGenerating]);

  const respondPermission = useCallback((allowed: boolean) => {
    const isPlanDenial = !allowed && pendingPermissionRef.current?.toolName === "ExitPlanMode";
    setPendingPermission(null); onQuestionChangeRef.current?.(false);
    if (!allowed) { stopGenerating(); onUsageUpdateRef.current?.({ ...accumulatedUsageRef.current, isBusy: false }); }
    const msg = JSON.stringify({ type: "permission_response", allowed });
    invoke("send_agent_message", { sessionId: targetSessionId, message: msg }).catch(() => { });
    if (isPlanDenial) {
      planDeniedRef.current = true;
      abortedRef.current = true;
      invoke("abort_agent", { sessionId: targetSessionId }).catch(() => {});
    }
  }, [targetSessionId, stopGenerating]);

  const sendPlanFeedback = useCallback((text: string) => {
    respondPermission(false);
    setTimeout(() => sendMessage(text), 100);
  }, [respondPermission, sendMessage]);
  sendPlanFeedbackRef.current = sendPlanFeedback;

  const allowInNewConversation = useCallback(async () => {
    if (!onForkWithPromptRef.current) return;
    const planFileContent = messages.filter((m) => m.type === "assistant").flatMap((m) => Array.isArray(m.content) ? m.content : [])
      .filter((b: ContentBlock) => b.type === "tool_use" && (b.name === "Write" || b.name === "write" || b.name === "Edit" || b.name === "edit"))
      .map((b: ContentBlock) => b.input)
      .find((input) => (input?.file_path as string)?.includes(".claude/plans/"));
    const planMarkdown = (planFileContent?.content as string) || "";
    const assistantTexts = messages.filter((m) => m.type === "assistant")
      .map((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "")
      .filter(Boolean);
    const planText = planMarkdown || assistantTexts[assistantTexts.length - 1] || "";
    const lines = messages.map((m) => {
      const text = Array.isArray(m.content) ? m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
      if (m.type === "user") return `Human: ${text}`;
      if (m.type === "assistant") return `Assistant: ${text}`;
      return "";
    }).filter(Boolean);
    const systemPrompt = `This conversation was forked from a plan-mode session. Here is the conversation context:\n\n<fork-context>\n${lines.join("\n\n")}\n</fork-context>\n\nExecute the plan. Do not ask for confirmation — proceed directly.`;
    onQuestionChangeRef.current?.(false);
    respondPermission(false);
    onBusyChangeRef.current?.(false);
    invoke("abort_agent", { sessionId }).catch(() => { });
    abortedRef.current = true;
    const execName = `Execute: ${session?.name || "plan"}`;
    const newSessionId = await onForkWithPromptRef.current(systemPrompt, planText, planMarkdown || undefined);
    setMessages((prev) => [...prev, { id: `fork-link-${Date.now()}`, type: "system", content: [{ type: "text", text: `Plan executing in → ${execName}` }], timestamp: Date.now(), forkSessionId: newSessionId, forkSessionName: execName }]);
  }, [messages, respondPermission, session?.name, sessionId]);

  // Autocomplete
  const { fileSuggestions, setFileSuggestions, fileMenuIndex, setFileMenuIndex, fileMenuRef, showFileMenu, selectFile, slashCommands, slashMenuIndex, setSlashMenuIndex, slashMenuRef, showSlashMenu, filteredSlashCommands, selectSlashCommand } = useInputAutocomplete(inputText, setInputText, sessionDir, inputRef);

  // Message actions
  const { editMessage, forkFromMessage, retryMessage, copyMessage } = useMessageActions(
    messages, setMessages, setInputText, setImages, setEditingMessageId, inputRef,
    (text?: string) => sendMessage(text), onForkRef
  );

  // Toggle tool
  const toggleTool = useCallback((blockId: string, isCurrentlyExpanded: boolean) => {
    suppressNextScrollRef.current = true;
    setToolStates((prev) => ({ ...prev, [blockId]: isCurrentlyExpanded ? "collapsed" : "expanded" }));
    requestAnimationFrame(() => { suppressNextScrollRef.current = false; });
  }, []);

  // Orchestrator commit shortcut
  useEffect(() => {
    if (!isActive) return;
    const handler = () => {
      const hasCommitCommand = slashCommands.some((cmd) => cmd.name === "commit");
      if (hasCommitCommand) sendMessage("/commit");
      else sendMessage("Look at the current git diff and create a commit with an appropriate message. Stage relevant files if needed.");
    };
    window.addEventListener("orchestrator-commit", handler);
    return () => window.removeEventListener("orchestrator-commit", handler);
  }, [isActive, slashCommands, sendMessage]);

  // Key handling
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showFileMenu) {
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); setFileMenuIndex((i) => Math.min(i + 1, fileSuggestions.length - 1)); return; }
      if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); setFileMenuIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); selectFile(fileSuggestions[fileMenuIndex]); return; }
      if (e.key === "Escape") { e.preventDefault(); setFileSuggestions([]); return; }
    }
    if (showSlashMenu && filteredSlashCommands.length > 0) {
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); setSlashMenuIndex((i) => Math.min(i + 1, filteredSlashCommands.length - 1)); return; }
      if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); setSlashMenuIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const cmd = filteredSlashCommands[slashMenuIndex];
        if (e.key === "Enter" && filteredSlashCommands.length === 1) { setInputText(""); sendMessage("/" + cmd.name); }
        else selectSlashCommand(cmd);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setInputText(""); return; }
    }
    if (e.key === "Tab") { e.preventDefault(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    if (e.key === "Escape" && isGenerating) { e.preventDefault(); handleAbort(); }
    if (e.key === "ArrowUp") {
      const textarea = inputRef.current;
      if (textarea) {
        const beforeCursor = textarea.value.substring(0, textarea.selectionStart);
        if (!beforeCursor.includes("\n")) {
          const history = inputHistoryRef.current;
          if (history.length === 0) return;
          e.preventDefault();
          if (historyIndexRef.current === -1) savedInputRef.current = inputText;
          const newIndex = historyIndexRef.current === -1 ? history.length - 1 : Math.max(0, historyIndexRef.current - 1);
          historyIndexRef.current = newIndex;
          setInputText(history[newIndex]);
          return;
        }
      }
    }
    if (e.key === "ArrowDown" && historyIndexRef.current !== -1) {
      e.preventDefault();
      const history = inputHistoryRef.current;
      const newIndex = historyIndexRef.current + 1;
      if (newIndex >= history.length) {
        historyIndexRef.current = -1;
        setInputText(savedInputRef.current);
      } else {
        historyIndexRef.current = newIndex;
        setInputText(history[newIndex]);
      }
      return;
    }
  }, [sendMessage, isGenerating, handleAbort, showSlashMenu, filteredSlashCommands, slashMenuIndex, selectSlashCommand, showFileMenu, fileSuggestions, fileMenuIndex, selectFile, setFileSuggestions, setFileMenuIndex, setSlashMenuIndex, setInputText, inputText]);

  // Auto-scroll
  useEffect(() => {
    if (isAtBottomRef.current && isActive && !suppressNextScrollRef.current) requestAnimationFrame(() => scrollToBottom());
  }, [deferredMessages, trailingMessages, virtualizerTotalSize, isActive, scrollToBottom]);

  return (
    <div className="chat-shell flex flex-col h-full relative">
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="absolute inset-0 bg-[var(--accent)]/10 border-2 border-dashed border-[var(--accent)] rounded-xl" />
          <div className="relative flex flex-col items-center gap-2 text-[var(--accent)]">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            <span className="text-sm font-medium">Drop files to attach</span>
          </div>
        </div>
      )}
      {!isAtBottom && (
        <button onClick={scrollToBottom} className="absolute bottom-20 right-4 z-10 rounded-full bg-neutral-700 hover:bg-neutral-600 text-white p-2 shadow-lg transition-colors" title="Scroll to bottom">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
        </button>
      )}

      {/* Messages area */}
      <div ref={scrollRef} onScroll={handleScroll} className="chat-scroll flex-1 overflow-y-auto py-8 flex flex-col">
        {isActive && messages.length === 0 && !isGenerating && !session?.planContent && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-xs text-[var(--text-tertiary)] opacity-50">
              {session?.status === "pending" ? "Choose a provider below, then send your first message." : "Send a message to start the conversation."}
            </p>
          </div>
        )}
        <div className="w-full px-6 flex justify-center">
          <div className="chat-column w-full max-w-[900px] flex flex-col gap-6">
            {isActive ? (
              <>
                <div style={{ visibility: !isLayoutReady && messages.length > 0 ? "hidden" : "visible", pointerEvents: !isLayoutReady && messages.length > 0 ? "none" : "auto" }}>
                  {hasMore && <div ref={sentinelRef} className="h-1" />}
                  {useVirtualRendering ? (
                    <div style={{ height: `${virtualizerTotalSize}px`, position: "relative" }}>
                      {virtualItems.map((virtualItem) => {
                        const msg = allMessages[virtualItem.index];
                        const isLast = isGenerating && virtualItem.index === allMessages.length - 1;
                        return (
                          <div key={msg.id} data-index={virtualItem.index} ref={rowVirtualizer.measureElement} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualItem.start}px)`, paddingBottom: "20px" }}>
                            <MessageBubble
                              message={msg} prevMessage={allMessages[virtualItem.index - 1]} toolStates={toolStates} onToggleTool={toggleTool} isLastMessage={isLast}
                              planContent={session?.planContent}
                              onEdit={msg.isParentMessage || msg.id.startsWith("child-") ? undefined : editMessage}
                              onFork={msg.isParentMessage || msg.id.startsWith("child-") ? undefined : forkFromMessage}
                              onRetry={msg.isParentMessage || msg.id.startsWith("child-") ? undefined : retryMessage}
                              onCopy={copyMessage} onNavigateToSession={onNavigateToSession}
                              modifiedFiles={modifiedFilesByResult.get(msg.id)} onOpenFile={onOpenFile}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex flex-col">
                      {allMessages.map((msg, index) => {
                        const isLast = isGenerating && index === allMessages.length - 1;
                        return (
                          <div key={msg.id} style={{ paddingBottom: "20px" }}>
                            <MessageBubble
                              message={msg} prevMessage={allMessages[index - 1]} toolStates={toolStates} onToggleTool={toggleTool} isLastMessage={isLast}
                              planContent={session?.planContent}
                              onEdit={msg.isParentMessage || msg.id.startsWith("child-") ? undefined : editMessage}
                              onFork={msg.isParentMessage || msg.id.startsWith("child-") ? undefined : forkFromMessage}
                              onRetry={msg.isParentMessage || msg.id.startsWith("child-") ? undefined : retryMessage}
                              onCopy={copyMessage} onNavigateToSession={onNavigateToSession}
                              modifiedFiles={modifiedFilesByResult.get(msg.id)} onOpenFile={onOpenFile}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {isGenerating && !pendingPermission && !pendingQuestion && (
                  <div className="flex items-center gap-2 px-1 py-2">
                    <div className="flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-thinking-pulse" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-thinking-pulse [animation-delay:200ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-thinking-pulse [animation-delay:400ms]" />
                    </div>
                    <span className="text-xs text-[var(--text-tertiary)]">{currentTodo || "Thinking…"}</span>
                  </div>
                )}
                {queuedMessage && (
                  <div className="flex items-center gap-2 px-3 py-1.5 mx-1 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-xs">
                    <svg className="w-3 h-3 text-[var(--accent)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <span className="text-[var(--text-secondary)] truncate flex-1">Queued: {queuedMessage.text || "(attachment)"}</span>
                    <button onClick={() => { queuedMessageRef.current = null; setQueuedMessage(null); }} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors shrink-0">✕</button>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      </div>

      {hasPendingTodos && latestTodos && (
        <PendingTodosPanel
          todos={latestTodos}
          collapsed={todosPanelCollapsed}
          onToggle={() => setTodosPanelCollapsed((c) => !c)}
        />
      )}

      {/* Input area */}
      <ChatInput
        inputText={inputText} setInputText={setInputText} inputRef={inputRef} inputAreaRef={inputAreaRef}
        images={images} pastedFiles={pastedFiles} fileReferences={fileReferences}
        onRemoveImage={removeImage} onRemovePastedFile={removePastedFile}
        onRemoveFileRef={removeFileReference} onViewFileRef={(ref) => setViewingFileRef(ref)}
        onPaste={handlePaste}
        isGenerating={isGenerating} onSend={() => sendMessage()} onAbort={handleAbort}
        pendingQuestion={pendingQuestion} pendingPermission={pendingPermission}
        onAnswerQuestion={answerQuestion} onAllowPermission={() => respondPermission(true)}
        onDenyPermission={() => respondPermission(false)} onAllowInNew={allowInNewConversation}
        onPlanFeedback={sendPlanFeedback}
        editingMessageId={editingMessageId} onCancelEdit={() => { setEditingMessageId(null); setInputText(""); }}
        sessionDir={sessionDir} sessionStatus={session?.status} sessionProvider={session?.provider}
        sessionPermissionMode={session?.permissionMode} currentModel={currentModel} activeModels={activeModels}
        currentBranch={currentBranch} openPill={openPill} setOpenPill={setOpenPill}
        modelSearchTerm={modelSearchTerm} setModelSearchTerm={setModelSearchTerm} filteredModels={filteredModels}
        reasoningEffort={reasoningEffort} setReasoningEffort={setReasoningEffort}
        onModelChange={onModelChange} onPermissionModeChange={onPermissionModeChange}
        onProviderChange={onProviderChange} providerAvailability={providerAvailability}
        targetSessionId={targetSessionId} pillRowRef={pillRowRef} modelSearchRef={modelSearchRef}
        showFileMenu={showFileMenu} fileSuggestions={fileSuggestions} fileMenuIndex={fileMenuIndex}
        setFileMenuIndex={setFileMenuIndex} fileMenuRef={fileMenuRef} onSelectFile={selectFile}
        showSlashMenu={showSlashMenu} filteredSlashCommands={filteredSlashCommands}
        slashMenuIndex={slashMenuIndex} setSlashMenuIndex={setSlashMenuIndex} slashMenuRef={slashMenuRef}
        onSelectSlashCommand={selectSlashCommand}
        onShowFilePicker={() => setShowFilePicker(true)}
        handleKeyDown={handleKeyDown} onInputHeightChange={onInputHeightChange}
      />

      {/* File picker modal */}
      {showFilePicker && sessionDir && (
        <FilePickerModal directory={sessionDir} onSelect={addFileReference} onClose={() => setShowFilePicker(false)} />
      )}
      {viewingFileRef && sessionDir && (
        <FilePickerModal directory={sessionDir} initialFile={viewingFileRef} onSelect={addFileReference} onClose={() => setViewingFileRef(null)} />
      )}
    </div>
  );
}, (prev, next) => {
  return (
    prev.sessionId === next.sessionId &&
    prev.isActive === next.isActive &&
    prev.session === next.session &&
    prev.currentModel === next.currentModel
  );
});

export default AgentChat;
