/**
 * Agent Bridge — Node.js process that wraps the Claude Agent SDK.
 *
 * Spawned by the Rust backend as a child process per session.
 * Communicates via stdin (JSON lines in) and stdout (JSON lines out).
 *
 * Uses query() for each turn. Follow-up messages resume the session
 * by passing the session ID from the first query's init message.
 *
 * Usage: node agent-bridge.bundle.mjs '{"sessionId":"...","cwd":"...","resume":"...","mcpServers":{...},"systemPrompt":"..."}'
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  emit,
  createLogger,
  startStdinReader,
  createBridgeState,
  handleCommonSetters,
  createBlockingSlot,
  handleInteractionResponse,
  cancelPendingInteractions,
} from "./bridge-utils.mjs";

// ── Logging ──────────────────────────────────────────────────────────
const log = createLogger("");  // → /tmp/agent-bridge-debug.log

// ── Config ───────────────────────────────────────────────────────────
const config = JSON.parse(process.argv[2] || "{}");
const {
  sessionId,
  resume,
  mcpServers,
  systemPrompt,
  allowedTools,
  claudeCliPath,
} = config;

const state = createBridgeState(config);

log(`PATH: ${process.env.PATH}`);
log(`HOME: ${process.env.HOME}`);
log(`node: ${process.execPath}`);
log(`cwd config: ${config.cwd}`);
log(`cwd actual: ${process.cwd()}`);
log(`cwd exists: ${existsSync(config.cwd || process.cwd())}`);

// ── Session state ────────────────────────────────────────────────────

// The Claude Code session ID — captured from the first query's init message.
let claudeSessionId = resume || null;
let abortController = null;
let queryInProgress = false;
let queryGeneration = 0;

// Interaction slots for AskUserQuestion and permission prompts
const askUserSlot = createBlockingSlot();
const permissionSlot = createBlockingSlot();

// ── Stdin handling ───────────────────────────────────────────────────

startStdinReader(handleStdinMessage, () => process.exit(0));

async function handleStdinMessage(msg) {
  if (msg.type === "abort") {
    queryGeneration++;  // invalidate the current query's finally block
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    queryInProgress = false;  // unblock new messages immediately
    cancelPendingInteractions(permissionSlot, askUserSlot);
    emit({ type: "aborted" });
    return;
  }

  if (handleInteractionResponse(msg, permissionSlot, askUserSlot, log)) return;
  if (handleCommonSetters(msg, state, log)) return;

  if (msg.type === "user") {
    await runQuery(msg.message);
    return;
  }

  emit({ type: "error", error: `Unknown stdin message type: ${msg.type}` });
}

async function runQuery(userMessage) {
  if (queryInProgress) {
    emit({ type: "error", error: "A query is already in progress" });
    return;
  }

  const myGeneration = ++queryGeneration;
  abortController = new AbortController();
  queryInProgress = true;

  // Build prompt content — must always be a string for the SDK.
  // If the message contains image blocks, save them as temp files and
  // include the file paths in the text so Claude Code can read them.
  let prompt;
  if (typeof userMessage === "string") {
    prompt = userMessage;
  } else if (Array.isArray(userMessage.content)) {
    const textParts = [];
    for (const block of userMessage.content) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "image" && block.source?.data) {
        try {
          const imgDir = join(tmpdir(), "claude-orchestrator-images");
          mkdirSync(imgDir, { recursive: true });
          const ext = (block.source.media_type || "image/png").split("/")[1] || "png";
          const filePath = join(imgDir, `${randomUUID()}.${ext}`);
          writeFileSync(filePath, Buffer.from(block.source.data, "base64"));
          textParts.push(filePath);
          log(`Saved image to ${filePath}`);
        } catch (imgErr) {
          log(`Failed to save image: ${imgErr.message}`);
        }
      }
    }
    prompt = textParts.join("\n") || "";
  } else if (typeof userMessage.content === "string") {
    prompt = userMessage.content;
  } else {
    prompt = String(userMessage);
  }

  const isBypass = state.currentPermissionMode === "bypassPermissions";
  const options = {
    cwd: state.currentCwd || process.cwd(),
    permissionMode: state.currentPermissionMode,
    allowDangerouslySkipPermissions: isBypass,
    abortController,
    settingSources: ["project"],
    // Handle AskUserQuestion and permission prompts via the SDK's canUseTool protocol.
    // In bypassPermissions mode, only AskUserQuestion triggers this callback.
    // In plan mode, write/execute tools also trigger it — we forward to the frontend.
    canUseTool: async (toolName, input, { signal }) => {
      // AskUserQuestion — always ask the user regardless of permission mode
      if (toolName === "AskUserQuestion") {
        log(`canUseTool: AskUserQuestion — waiting for user answer`);
        emit({ type: "ask_user_question", questions: input.questions });
        const answer = await new Promise((resolve) => {
          askUserSlot.pending = resolve;
          signal.addEventListener("abort", () => {
            askUserSlot.pending = null;
            resolve(null);
          }, { once: true });
        });
        if (answer === null) {
          log("canUseTool: AskUserQuestion cancelled");
          return { behavior: "deny", message: "User cancelled." };
        }
        log(`canUseTool: AskUserQuestion answered: ${JSON.stringify(answer).substring(0, 200)}`);
        return { behavior: "allow", updatedInput: { ...input, answers: answer } };
      }

      // In bypass mode, auto-allow everything else
      if (isBypass) {
        return { behavior: "allow", updatedInput: input };
      }

      // Plan mode — auto-allow everything except ExitPlanMode (accept plan).
      // ExitPlanMode is the "plan ready" signal — let the user choose to
      // continue here or fork into a new conversation.
      if (toolName !== "ExitPlanMode") {
        log(`canUseTool: auto-allowing ${toolName} in plan mode`);
        return { behavior: "allow", updatedInput: input };
      }

      // ExitPlanMode — ask user for permission (accept plan UI)
      log(`canUseTool: permission request for ${toolName}`);
      emit({ type: "permission_request", toolName, input });
      const allowed = await new Promise((resolve) => {
        permissionSlot.pending = resolve;
        signal.addEventListener("abort", () => {
          permissionSlot.pending = null;
          resolve(false);
        }, { once: true });
      });
      if (!allowed) {
        log(`canUseTool: ${toolName} denied`);
        return { behavior: "deny", message: "User denied permission." };
      }
      log(`canUseTool: ${toolName} allowed`);
      return { behavior: "allow", updatedInput: input };
    },
  };

  // Point the SDK to the real `claude` CLI binary (required in production builds
  // where import.meta.url resolves inside the app bundle, not node_modules)
  if (claudeCliPath) {
    options.pathToClaudeCodeExecutable = claudeCliPath;
  }

  // Resume from previous turn if we have a session ID
  if (claudeSessionId) {
    options.resume = claudeSessionId;
  }

  // Use Claude Code's default system prompt unless a custom one is provided
  if (systemPrompt) {
    options.systemPrompt = { type: "preset", preset: "claude_code", append: systemPrompt };
  } else {
    options.systemPrompt = { type: "preset", preset: "claude_code" };
  }
  if (mcpServers && Object.keys(mcpServers).length > 0) options.mcpServers = mcpServers;
  if (allowedTools) options.allowedTools = allowedTools;
  if (state.currentModel) options.model = state.currentModel;
  if (state.currentReasoningEffort) {
    const effortMap = { low: 1024, medium: 10000, high: 50000 };
    options.maxThinkingTokens = effortMap[state.currentReasoningEffort];
  }

  try {
    log(`query() starting — cwd=${options.cwd}, resume=${claudeSessionId || "(new)"}`);
    const q = query({ prompt, options });
    for await (const message of q) {
      // Capture session ID from init message for future resume
      if (message.type === "system" && message.subtype === "init" && message.session_id) {
        claudeSessionId = message.session_id;
        log(`Session ID captured: ${claudeSessionId}`);
      }
      emit(message);

      // Debug: log assistant messages that contain tool_use blocks
      if (message.type === "assistant") {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          const toolUses = content.filter((b) => b.type === "tool_use");
          if (toolUses.length > 0) {
            log(`assistant event: tools=[${toolUses.map((t) => t.name).join(",")}] stop_reason=${message.message?.stop_reason}`);
          }
        } else {
          log(`assistant event: content type=${typeof content}, stop_reason=${message.message?.stop_reason}, keys=${Object.keys(message).join(",")}`);
        }
      }
    }
    emit({ type: "query_complete" });
  } catch (err) {
    log(`query() error: ${err.message}\n${err.stack}`);
    if (err.name === "AbortError") {
      emit({ type: "aborted" });
    } else {
      emit({ type: "error", error: err.message, stack: err.stack });
    }
  } finally {
    // Only reset if this query is still the current one (not superseded by abort + new query)
    if (queryGeneration === myGeneration) {
      abortController = null;
      queryInProgress = false;
    }
  }
}

// Signal readiness
emit({
  type: "system",
  subtype: "bridge_ready",
  sessionId,
  cwd: state.currentCwd || process.cwd(),
});
