import { useEffect, useCallback, useRef } from "react";
import { invoke } from "../../../lib/bridge";
import { listen } from "../../../lib/bridge";
import { sendNotification } from "../../../lib/bridge";
import type { ChatMessage, ContentBlock, AskQuestion } from "../types";
import type { SessionUsage } from "../../../types";
import { normalizeContent } from "../constants";
import type { StreamAccumulator } from "./useStreamAccumulator";

interface AgentEventsProps {
  sessionId: string;
  childSessions?: Array<{ id: string; status: string }>;
  childSessionsKey: string;
  session?: { provider?: string; pendingPrompt?: string; planContent?: string; permissionMode?: string; name?: string; status?: string; pendingImages?: Array<{ id: string; data: string; mediaType: string; name: string }>; pendingFiles?: Array<{ id: string; name: string; content: string; mimeType: string }> };
  mountedRef: React.MutableRefObject<boolean>;
  isGeneratingRef: React.MutableRefObject<boolean>;
  setIsGenerating: (v: boolean) => void;
  stopGenerating: () => void;
  abortedRef: React.MutableRefObject<boolean>;
  generationStartRef: React.MutableRefObject<number>;
  accumulatedUsageRef: React.MutableRefObject<{
    inputTokens: number; outputTokens: number;
    cacheCreationInputTokens: number; cacheReadInputTokens: number;
    costUsd: number; contextTokens: number;
  }>;
  queuedMessageRef: React.MutableRefObject<unknown>;
  pendingPermissionRef: React.MutableRefObject<{ toolName: string; input: Record<string, unknown> } | null>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setCurrentTodo: (v: string | null) => void;
  setPendingPermission: (v: { toolName: string; input: Record<string, unknown> } | null) => void;
  setPendingQuestion: (v: { blockId: string; questions: AskQuestion[] } | null) => void;
  pendingPromptConsumedRef: React.MutableRefObject<boolean>;
  currentModelRef: React.MutableRefObject<string>;
  titleGeneratedRef: React.MutableRefObject<boolean>;
  streamAccumulator: StreamAccumulator;
  currentStreamIdRef: React.MutableRefObject<string | null>;
  onExitRef: React.MutableRefObject<(code?: number) => void>;
  onQuestionChangeRef: React.MutableRefObject<((v: boolean) => void) | undefined>;
  onClaudeSessionIdRef: React.MutableRefObject<((id: string) => void) | undefined>;
  onAvailableModelsRef: React.RefObject<((models: Array<{ id: string; providerID: string; name: string; free: boolean; costIn: number; costOut: number }>) => void) | undefined>;
  onUsageUpdateRef: React.RefObject<((usage: SessionUsage) => void) | undefined>;
  onClearPendingPromptRef: React.MutableRefObject<(() => void) | undefined>;
  onRenameRef: React.MutableRefObject<((name: string) => void) | undefined>;
  onMarkTitleGeneratedRef: React.MutableRefObject<(() => void) | undefined>;
  queuedQuestionAnswerRef: React.MutableRefObject<Record<string, string> | null>;
  sdkMessageToChatMessage: (msg: Record<string, unknown>, isHistoryReplay?: boolean) => ChatMessage | null;
  parseContentWithImages: (raw: string) => ContentBlock[];
  looksLikeTaskPrompt: (text: string) => boolean;
  looksLikeBackgroundTaskNotification: (text: string) => boolean;
  normaliseWs: (s: string) => string;
}

export function useAgentEvents(props: AgentEventsProps) {
  const {
    sessionId, childSessions, childSessionsKey, session,
    mountedRef, isGeneratingRef, setIsGenerating, stopGenerating,
    abortedRef, generationStartRef, accumulatedUsageRef, queuedMessageRef,
    pendingPermissionRef,
    setMessages, setCurrentTodo, setPendingPermission, setPendingQuestion,
    pendingPromptConsumedRef, currentModelRef, titleGeneratedRef,
    streamAccumulator,
    onExitRef, onQuestionChangeRef, onClaudeSessionIdRef, onAvailableModelsRef,
    onUsageUpdateRef, onClearPendingPromptRef, onRenameRef, onMarkTitleGeneratedRef,
    queuedQuestionAnswerRef,
    sdkMessageToChatMessage,
  } = props;

  const { pendingStreamRef, accumulatedBlocksRef, currentStreamIdRef, scheduleFlush, flushPendingStream } = streamAccumulator;

  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Track whether bridge_ready has been received for the current bridge lifecycle.
  // When the session is destroyed and a new bridge boots, some providers (e.g. OpenCode)
  // replay historical assistant/result events BEFORE bridge_ready. We must skip those
  // to avoid corrupting the live message state (duplicates, spurious stopGenerating, etc.).
  const bridgeReadyRef = useRef(true);

  const handleAgentMessage = useCallback((msg: Record<string, unknown>) => {
    const msgType = msg.type as string;

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
      bridgeReadyRef.current = true;
      if (sessionRef.current?.provider === "claude-code" && currentModelRef.current !== "claude-opus-4-6") {
        const setModelMsg = JSON.stringify({ type: "set_model", model: currentModelRef.current });
        invoke("send_agent_message", { sessionId, message: setModelMsg }).catch(() => { });
      }
      const _sess = sessionRef.current;
      const hasPendingContent = (_sess?.pendingPrompt != null || (_sess?.pendingImages?.length ?? 0) > 0 || (_sess?.pendingFiles?.length ?? 0) > 0);
      if (hasPendingContent && !pendingPromptConsumedRef.current && _sess) {
        pendingPromptConsumedRef.current = true;
        onClearPendingPromptRef.current?.();
        const prompt = _sess.pendingPrompt ?? "";

        // Build content with images/files if present
        let pastedFileContext = "";
        if (_sess.pendingFiles && _sess.pendingFiles.length > 0) {
          pastedFileContext = _sess.pendingFiles.map((f: { name: string; content: string }) => `<file name="${f.name}">\n${f.content}\n</file>`).join("\n\n") + "\n\n";
        }
        const fullText = pastedFileContext + prompt;
        let sendContent: unknown;
        if (_sess.pendingImages && _sess.pendingImages.length > 0) {
          const blocks: unknown[] = [];
          for (const img of _sess.pendingImages)
            blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
          if (fullText) blocks.push({ type: "text", text: fullText });
          sendContent = blocks;
        } else {
          sendContent = fullText;
        }

        const displayText = _sess.planContent ? "Execute the plan." : prompt;
        const filePills = _sess.pendingFiles && _sess.pendingFiles.length > 0
          ? [{ type: "text", text: _sess.pendingFiles.map((f: { name: string }) => `<file name="${f.name}"></file>`).join("\n") }]
          : [];
        const displayContent = _sess.pendingImages && _sess.pendingImages.length > 0
          ? [
              ..._sess.pendingImages.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
              ...filePills,
              ...(prompt ? [{ type: "text", text: displayText }] : []),
            ]
          : [...filePills, { type: "text", text: displayText }];
        setMessages((prev) => [
          ...prev,
          { id: `user-${Date.now()}`, type: "user", content: displayContent, timestamp: Date.now() },
        ]);
        abortedRef.current = false;
        generationStartRef.current = Date.now();
        isGeneratingRef.current = true;
        setIsGenerating(true);
        const jsonLine = JSON.stringify({ type: "user", message: { role: "user", content: sendContent } });
        const trySendAuto = (attempt: number) => {
          invoke("send_agent_message", { sessionId, message: jsonLine }).then(() => {
            if (sessionRef.current?.provider !== "claude-code" && !titleGeneratedRef.current) {
              titleGeneratedRef.current = true;
              invoke<string | null>("generate_title_from_text", { message: prompt.substring(0, 500) })
                .then((title) => { if (title) { onRenameRef.current?.(title); onMarkTitleGeneratedRef.current?.(); } })
                .catch(() => { });
            }
          }).catch((err) => {
            const errStr = String(err);
            const MAX_RETRIES = 10;
            if (attempt < MAX_RETRIES && errStr.includes("query is already in progress")) {
              setTimeout(() => trySendAuto(attempt + 1), 500);
              return;
            }
            stopGenerating();
            setMessages((prev) => [...prev, { id: `error-${Date.now()}`, type: "error", content: [{ type: "text", text: `Failed to send: ${err}` }], timestamp: Date.now() }]);
          });
        };
        trySendAuto(0);
      }
      return;
    }

    if (msgType === "assistant") {
      if (!bridgeReadyRef.current) return; // Skip historical events during bridge history replay
      if (abortedRef.current) return;
      if (!isGeneratingRef.current) { isGeneratingRef.current = true; setIsGenerating(true); }
      const messageObj = msg.message as Record<string, unknown> | undefined;
      const content = normalizeContent(messageObj?.content);
      const apiMsgId = messageObj?.id as string | undefined;
      if (content) {
        const streamId = apiMsgId || currentStreamIdRef.current || `stream-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        currentStreamIdRef.current = streamId;
        const existing = accumulatedBlocksRef.current.get(streamId) || [];
        const merged = [...existing];
        for (const block of content) {
          const matchIdx = block.type === "tool_use" && block.id
            ? merged.findIndex((b) => b.type === "tool_use" && b.id === block.id)
            : block.type === "text"
              ? (() => {
                let lastTextIdx = -1;
                let lastToolUseIdx = -1;
                for (let i = merged.length - 1; i >= 0; i--) {
                  if (lastTextIdx === -1 && merged[i].type === "text") lastTextIdx = i;
                  if (lastToolUseIdx === -1 && merged[i].type === "tool_use") lastToolUseIdx = i;
                  if (lastTextIdx !== -1 && lastToolUseIdx !== -1) break;
                }
                return lastTextIdx > lastToolUseIdx ? lastTextIdx : -1;
              })()
              : -1;
          if (matchIdx !== -1) merged[matchIdx] = block;
          else merged.push(block);
        }
        accumulatedBlocksRef.current.set(streamId, merged);
        pendingStreamRef.current = { id: streamId, content: merged };

        for (const block of content) {
          if (block.type === "tool_use" && block.name === "AskUserQuestion") {
            onQuestionChangeRef.current?.(true);
            const input = (block as { input?: { questions?: AskQuestion[] } }).input;
            const questions = Array.isArray(input?.questions) ? input.questions : [];
            if (questions.length > 0) setPendingQuestion({ blockId: (block as { id: string }).id, questions });
          }
        }

        for (const block of content) {
          if (block.type === "tool_use" && block.name === "TodoWrite" && block.input) {
            const todos = (block.input as { todos?: Array<{ content: string; status: string; activeForm?: string }> }).todos;
            if (todos) {
              const inProgress = todos.find(t => t.status === "in_progress");
              setCurrentTodo(inProgress?.activeForm || inProgress?.content || null);
            }
          }
        }

        scheduleFlush();
      }
      return;
    }

    if (msgType === "usage") {
      const result = msg as Record<string, unknown>;
      const resultUsage = result.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
      if (resultUsage) {
        const inp = resultUsage.input_tokens || 0;
        const out = resultUsage.output_tokens || 0;
        const cr = resultUsage.cache_read_input_tokens || 0;
        const cc = resultUsage.cache_creation_input_tokens || 0;
        const acc = accumulatedUsageRef.current;
        acc.inputTokens += inp; acc.outputTokens += out;
        acc.cacheReadInputTokens += cr; acc.cacheCreationInputTokens += cc;
        acc.contextTokens = inp + cr + cc;
        acc.costUsd += (result.cost_usd as number) || 0;
        onUsageUpdateRef.current?.({ ...acc, isBusy: true });
      }
      return;
    }

    if (msgType === "result") {
      if (!bridgeReadyRef.current) return; // Skip historical result events during bridge history replay
      stopGenerating();
      setCurrentTodo(null);
      setPendingQuestion(null);
      flushPendingStream();
      accumulatedBlocksRef.current.clear();
      currentStreamIdRef.current = null;
      const result = msg as Record<string, unknown>;
      const durationMs = generationStartRef.current ? Date.now() - generationStartRef.current : undefined;
      const resultUsage = result.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
      if (resultUsage) {
        const inp = resultUsage.input_tokens || 0;
        const out = resultUsage.output_tokens || 0;
        const cr = resultUsage.cache_read_input_tokens || 0;
        const cc = resultUsage.cache_creation_input_tokens || 0;
        const acc = accumulatedUsageRef.current;
        acc.inputTokens += inp; acc.outputTokens += out;
        acc.cacheReadInputTokens += cr; acc.cacheCreationInputTokens += cc;
        acc.contextTokens = inp + cr + cc;
        acc.costUsd += (result.cost_usd as number) || 0;
        onUsageUpdateRef.current?.({ ...acc, isBusy: !!queuedMessageRef.current });
      }
      setMessages((prev) => {
        const filtered = prev.filter((m) => !m.isStreaming);
        return [...filtered, {
          id: `result-${Date.now()}`, type: "result",
          content: [{ type: "text", text: (result.result as string) || "" }],
          timestamp: Date.now(), costUsd: result.cost_usd as number | undefined,
          usage: resultUsage as { input_tokens?: number; output_tokens?: number } | undefined,
          durationMs,
        }];
      });
      if (!queuedMessageRef.current && !pendingPermissionRef.current) {
        invoke("destroy_agent_session", { sessionId }).catch(() => {});
        bridgeReadyRef.current = false;
      }
      return;
    }

    if (msgType === "query_complete") {
      if (!bridgeReadyRef.current) return; // Skip historical query_complete during bridge history replay
      stopGenerating(); setCurrentTodo(null); setPendingQuestion(null);
      flushPendingStream();
      accumulatedBlocksRef.current.clear();
      currentStreamIdRef.current = null;
      onUsageUpdateRef.current?.({ ...accumulatedUsageRef.current, isBusy: !!queuedMessageRef.current });
      if (sessionRef.current?.permissionMode === "plan") {
        const restoreMsg = JSON.stringify({ type: "set_permission_mode", permissionMode: "plan" });
        invoke("send_agent_message", { sessionId, message: restoreMsg }).catch(() => { });
      }
      if (!queuedMessageRef.current && !pendingPermissionRef.current) {
        invoke("destroy_agent_session", { sessionId }).catch(() => {});
        bridgeReadyRef.current = false;
      }
      return;
    }

    if (msgType === "aborted") {
      if (abortedRef.current) stopGenerating();
      flushPendingStream();
      setCurrentTodo(null); setPendingQuestion(null); accumulatedBlocksRef.current.clear();
      currentStreamIdRef.current = null;
      return;
    }

    if (msgType === "error") {
      const errorText = (msg.error as string) || "";
      if (errorText.includes("aborted by user")) {
        if (abortedRef.current) { stopGenerating(); flushPendingStream(); setCurrentTodo(null); setPendingQuestion(null); accumulatedBlocksRef.current.clear(); currentStreamIdRef.current = null; }
        return;
      }
      stopGenerating(); flushPendingStream(); setCurrentTodo(null); setPendingQuestion(null); accumulatedBlocksRef.current.clear(); currentStreamIdRef.current = null;
      setMessages((prev) => [...prev.filter((m) => !m.isStreaming), {
        id: `error-${Date.now()}`, type: "error",
        content: [{ type: "text", text: errorText || "Unknown error" }], timestamp: Date.now(),
      }]);
      return;
    }

    if (msgType === "permission_request") {
      setPendingPermission({ toolName: msg.toolName as string, input: msg.input as Record<string, unknown> });
      onQuestionChangeRef.current?.(true);
      if (msg.toolName === "ExitPlanMode") {
        sendNotification({ title: "Plan ready", body: sessionRef.current?.name || "A session needs your approval" });
      }
      return;
    }

    if (msgType === "ask_user_question") {
      const questions = (msg.questions as AskQuestion[]) || [];
      if (questions.length > 0) {
        // If there's a queued answer (from a recovered question answered before bridge booted),
        // send it immediately instead of showing the question again.
        const queued = queuedQuestionAnswerRef.current;
        if (queued) {
          queuedQuestionAnswerRef.current = null;
          const answerMsg = JSON.stringify({ type: "ask_user_answer", answer: queued });
          invoke("send_agent_message", { sessionId, message: answerMsg }).catch(() => {});
          return;
        }
        setPendingQuestion({ blockId: `ask-${Date.now()}`, questions }); onQuestionChangeRef.current?.(true);
      }
      return;
    }

    if (msgType === "user_history") {
      const messageObj = msg.message as Record<string, unknown> | undefined;
      const content = normalizeContent(messageObj?.content);
      if (content) {
        const histText = content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        const histImageCount = content.filter((b) => b.type === "image").length;
        setMessages((prev) => {
          // Skip if a user message with matching text and image count already exists (dedup)
          if (prev.some((m) => m.type === "user" &&
            m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() === histText &&
            m.content.filter((b) => b.type === "image").length === histImageCount
          )) {
            return prev;
          }
          return [...prev, {
            id: (messageObj?.id as string) || `user-history-${Date.now()}`,
            type: "user", content, timestamp: Date.now(),
          }];
        });
      }
      return;
    }

    if (msgType === "history_loaded") return;

    const chatMsg = sdkMessageToChatMessage(msg);
    if (chatMsg) setMessages((prev) => [...prev, chatMsg]);
  }, []);

  // Register listeners
  useEffect(() => {
    let cancelled = false;
    const unlistenFns: (() => void)[] = [];

    const registerListener = (promise: Promise<() => void>, onRegistered?: () => void) => {
      promise.then((fn) => {
        if (cancelled) fn();
        else {
          unlistenFns.push(fn);
          onRegistered?.();
        }
      });
    };

    registerListener(listen<string>(`agent-message-${sessionId}`, (event) => {
      if (cancelled || !mountedRef.current) return;
      try { const msg = JSON.parse(event.payload); handleAgentMessage(msg); } catch { }
    }), () => {
      // Recovery: scan agent history to restore any state missed before our listener
      // registered — bridge_ready for pending prompts, and is-generating for sessions
      // that were already mid-generation when this frontend connected.
      const _recSess = sessionRef.current;
      const needsBridgeReady = !!(_recSess?.pendingPrompt != null || (_recSess?.pendingImages?.length ?? 0) > 0 || (_recSess?.pendingFiles?.length ?? 0) > 0) && !pendingPromptConsumedRef.current;
      const needsBusyCheck = !isGeneratingRef.current && sessionRef.current?.status !== "stopped";
      if (!needsBridgeReady && !needsBusyCheck) return;

      invoke<string[]>("get_agent_history", { sessionId })
        .then((lines) => {
          if (cancelled) return;

          // Restore bridge_ready if we have a pending prompt that hasn't fired yet.
          if (needsBridgeReady && !pendingPromptConsumedRef.current) {
            for (const line of lines) {
              try {
                const msg = JSON.parse(line) as Record<string, unknown>;
                if (msg.type === "system" && msg.subtype === "bridge_ready") {
                  handleAgentMessage(msg);
                  break;
                }
              } catch { /* ignore */ }
            }
          }

          // Restore is-generating: scan history backward — if we find an `assistant`
          // message before any terminal event, generation is still in progress.
          if (needsBusyCheck && !isGeneratingRef.current) {
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const msg = JSON.parse(lines[i]) as Record<string, unknown>;
                const t = msg.type as string;
                if (t === "result" || t === "query_complete" || t === "error" || t === "aborted") {
                  break; // session already finished
                }
                if (t === "assistant") {
                  isGeneratingRef.current = true;
                  setIsGenerating(true);
                  break;
                }
              } catch { /* ignore */ }
            }
          }
        })
        .catch(() => { /* ignore */ });
    });

    registerListener(listen<string>(`agent-exit-${sessionId}`, (event) => {
      if (cancelled || !mountedRef.current) return;
      stopGenerating();
      const code = parseInt(event.payload, 10);
      onExitRef.current(isNaN(code) ? undefined : code);
    }));

    if (childSessions && childSessions.length > 0) {
      for (const child of childSessions) {
        registerListener(listen<string>(`agent-message-${child.id}`, (event) => {
          if (cancelled || !mountedRef.current) return;
          try {
            const msg = JSON.parse(event.payload);
            if (msg.type === "system" && msg.subtype === "init") return;
            if (msg.message && typeof msg.message === "object") {
              const apiId = msg.message.id;
              if (apiId) msg.message.id = `child-${child.id}-${apiId}`;
            }
            handleAgentMessage(msg);
          } catch { }
        }));

        registerListener(listen<string>(`agent-exit-${child.id}`, () => {
          if (cancelled || !mountedRef.current) return;
          const otherRunning = childSessions.some(
            (c) => c.id !== child.id && (c.status === "running" || c.status === "starting")
          );
          if (!otherRunning) stopGenerating();
        }));
      }
    }

    return () => { cancelled = true; for (const fn of unlistenFns) fn(); };
  }, [sessionId, handleAgentMessage, childSessionsKey]);

  // Poll OpenCode usage
  useEffect(() => {
    if (session?.provider === "claude-code" || session?.provider === "codex") return;
    if (!session || (session as { status?: string }).status !== "running" && (session as { status?: string }).status !== "starting") return;
    const fetchUsage = () => {
      invoke("send_agent_message", { sessionId, message: JSON.stringify({ type: "get_usage" }) }).catch(() => { });
    };
    fetchUsage();
    const interval = setInterval(fetchUsage, 30_000);
    return () => clearInterval(interval);
  }, [sessionId, session?.provider, (session as { status?: string } | undefined)?.status]);

  return { handleAgentMessage };
}
