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
import { existsSync, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

// ── Logging ──────────────────────────────────────────────────────────
const logFile = "/tmp/agent-bridge-debug.log";
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try { appendFileSync(logFile, line); } catch {}
};

// ── Config ───────────────────────────────────────────────────────────
const config = JSON.parse(process.argv[2] || "{}");
const {
  sessionId,
  cwd: initialCwd,
  resume,
  mcpServers,
  systemPrompt,
  allowedTools,
  claudeCliPath,
  permissionMode: configPermissionMode,
} = config;

// Mutable working directory — updated by set_cwd messages (e.g. after switch_workspace)
let currentCwd = initialCwd;

// Mutable model — updated by set_model messages
let currentModel = config.model || null;

// Mutable reasoning effort — updated by set_reasoning_effort messages
let currentReasoningEffort = null; // "low" | "medium" | "high" | null

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

log(`PATH: ${process.env.PATH}`);
log(`HOME: ${process.env.HOME}`);
log(`node: ${process.execPath}`);
log(`cwd config: ${initialCwd}`);
log(`cwd actual: ${process.cwd()}`);
log(`cwd exists: ${existsSync(initialCwd || process.cwd())}`);

// ── Session state ───────────────────────────────────────────────────

// The Claude Code session ID — captured from the first query's init message.
// Used to resume conversation for follow-up messages.
let claudeSessionId = resume || null;
let abortController = null;
let queryInProgress = false;
let queryGeneration = 0;

// AskUserQuestion interception: when set, we're waiting for user input
// via the canUseTool callback (SDK permission prompt protocol).
let askUserResolve = null;

// Permission prompt interception (for plan mode): when set, we're waiting
// for the user to approve/deny a tool use via canUseTool.
let permissionResolve = null;

// Mutable permission mode — can be toggled at runtime via set_permission_mode
let currentPermissionMode = configPermissionMode || "bypassPermissions";

// ── Stdin handling ──────────────────────────────────────────────────

let stdinBuf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  let newlineIdx;
  while ((newlineIdx = stdinBuf.indexOf("\n")) !== -1) {
    const line = stdinBuf.slice(0, newlineIdx).trim();
    stdinBuf = stdinBuf.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      handleStdinMessage(msg);
    } catch (err) {
      emit({ type: "error", error: `Invalid JSON on stdin: ${err.message}` });
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

async function handleStdinMessage(msg) {
  if (msg.type === "abort") {
    queryGeneration++;  // invalidate the current query's finally block
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    queryInProgress = false;  // unblock new messages immediately
    // Also unblock any pending AskUserQuestion / permission wait
    if (askUserResolve) {
      askUserResolve(null);
      askUserResolve = null;
    }
    if (permissionResolve) {
      permissionResolve(false);
      permissionResolve = null;
    }
    emit({ type: "aborted" });
    return;
  }

  if (msg.type === "set_cwd") {
    currentCwd = msg.cwd;
    log(`cwd updated to: ${currentCwd}`);
    emit({ type: "cwd_updated", cwd: currentCwd });
    return;
  }

  if (msg.type === "set_model") {
    currentModel = msg.model || null;
    log(`model updated to: ${currentModel}`);
    emit({ type: "model_updated", model: currentModel });
    return;
  }

  if (msg.type === "set_reasoning_effort") {
    currentReasoningEffort = msg.effort || null;
    log(`reasoning effort updated to: ${currentReasoningEffort}`);
    emit({ type: "reasoning_effort_updated", effort: currentReasoningEffort });
    return;
  }

  // User answered an AskUserQuestion prompt
  if (msg.type === "ask_user_answer") {
    if (askUserResolve) {
      log(`Resolving AskUserQuestion with: ${String(msg.answer).substring(0, 100)}`);
      askUserResolve(msg.answer);
      askUserResolve = null;
    } else {
      log("ask_user_answer received but no pending askUserResolve — ignoring");
    }
    return;
  }

  // User approved or denied a permission prompt (plan mode)
  if (msg.type === "permission_response") {
    if (permissionResolve) {
      log(`Resolving permission: ${msg.allowed ? "allow" : "deny"}`);
      permissionResolve(msg.allowed);
      permissionResolve = null;
    } else {
      log("permission_response received but no pending permissionResolve — ignoring");
    }
    return;
  }

  // Toggle permission mode at runtime
  if (msg.type === "set_permission_mode") {
    currentPermissionMode = msg.permissionMode || "bypassPermissions";
    log(`permissionMode updated to: ${currentPermissionMode}`);
    emit({ type: "permission_mode_updated", permissionMode: currentPermissionMode });
    return;
  }

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

  const isBypass = currentPermissionMode === "bypassPermissions";
  const options = {
    cwd: currentCwd || process.cwd(),
    permissionMode: currentPermissionMode,
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
          askUserResolve = resolve;
          const onAbort = () => { resolve(null); };
          signal.addEventListener("abort", onAbort, { once: true });
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
        permissionResolve = resolve;
        const onAbort = () => { resolve(false); };
        signal.addEventListener("abort", onAbort, { once: true });
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
  if (currentModel) options.model = currentModel;
  if (currentReasoningEffort) {
    const effortMap = { low: 1024, medium: 10000, high: 50000 };
    options.maxThinkingTokens = effortMap[currentReasoningEffort];
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

      // AskUserQuestion is now handled via the canUseTool callback above,
      // which uses the SDK's permission protocol (--permission-prompt-tool stdio).
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
  cwd: currentCwd || process.cwd(),
});
