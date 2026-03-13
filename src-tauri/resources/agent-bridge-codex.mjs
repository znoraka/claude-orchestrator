/**
 * Agent Bridge — Codex provider.
 *
 * Speaks the same stdin/stdout JSON-line protocol as agent-bridge.mjs (claude-code)
 * but drives the OpenAI Codex SDK (@openai/codex-sdk) instead.
 *
 * Usage: node agent-bridge-codex.bundle.mjs '{"sessionId":"...","cwd":"..."}'
 */
import { Codex } from "@openai/codex-sdk";
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
const log = createLogger("codex"); // → /tmp/agent-bridge-codex-debug.log

process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
  emit({ type: "error", error: `Bridge crashed: ${err.message}` });
  setTimeout(() => process.exit(1), 100);
});
process.on("unhandledRejection", (err) => {
  log(`UNHANDLED REJECTION: ${err?.message || err}\n${err?.stack || ""}`);
  emit({ type: "error", error: `Bridge error: ${err?.message || err}` });
});

// ── Config ───────────────────────────────────────────────────────────
const config = JSON.parse(process.argv[2] || "{}");
const { sessionId } = config;

// ── list-models mode (early exit) ────────────────────────────────────
if (config.mode === "list-models") {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const codexDir = `${os.homedir()}/.codex`;

  // Fast path: read codex's own models cache (already filtered & curated)
  try {
    const cache = JSON.parse(fs.readFileSync(`${codexDir}/models_cache.json`, "utf8"));
    if (cache.models && cache.models.length > 0) {
      const models = cache.models.map((m) => ({
        id: m.slug,
        name: m.display_name || m.slug,
        desc: m.description || "",
      }));
      process.stdout.write(JSON.stringify(models) + "\n");
      process.exit(0);
    }
  } catch {}

  // Slow path: fetch from OpenAI API
  let apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Try auth.json (where codex CLI stores credentials)
    try {
      const auth = JSON.parse(fs.readFileSync(`${codexDir}/auth.json`, "utf8"));
      if (auth.OPENAI_API_KEY) apiKey = auth.OPENAI_API_KEY;
    } catch {}
  }
  if (!apiKey) {
    // Try config.toml as last resort
    try {
      const toml = fs.readFileSync(`${codexDir}/config.toml`, "utf8");
      const m = toml.match(/api_key\s*=\s*"([^"]+)"/);
      if (m) apiKey = m[1];
    } catch {}
  }

  if (!apiKey) {
    process.stdout.write("[]\n");
    process.exit(0);
  }

  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json();
    const CODEX_PATTERN = /^(o\d|gpt-4|gpt-5|codex)/i;
    const EXCLUDE = /embed|tts|dall|whisper|realtime|audio|instruct|davinci|babbage|preview/i;
    const models = (data.data || [])
      .filter((m) => CODEX_PATTERN.test(m.id) && !EXCLUDE.test(m.id))
      .sort((a, b) => b.created - a.created)
      .map((m) => ({ id: m.id, name: m.id, desc: "" }));
    process.stdout.write(JSON.stringify(models) + "\n");
  } catch {
    process.stdout.write("[]\n");
  }
  process.exit(0);
}

const state = createBridgeState(config);

const PLAN_MODE_SYSTEM_PROMPT = `You are in PLAN MODE. Your job is to analyze the user's request and produce a detailed implementation plan — do NOT execute the plan.

RULES:
- You MAY read files, search code, explore the codebase, and use any read-only tools to gather context.
- You MUST NOT make any modifications: no writing files, no editing files, no running destructive commands, no creating/deleting anything.
- After gathering enough context, output a structured plan with:
  1. A summary of the approach
  2. The specific files to create or modify
  3. Step-by-step implementation details
  4. Any risks or considerations

Think carefully, explore thoroughly, and be specific in your plan.`;

// Interaction slots for plan mode and AskUserQuestion
const permissionSlot = createBlockingSlot();
const askUserSlot = createBlockingSlot();

// ── Fallback pricing (USD per million tokens) ────────────────────────
const KNOWN_COSTS = [
  ["o1-mini",        1.10,   4.40],
  ["o1",            15.00,  60.00],
  ["o3-mini",        1.10,   4.40],
  ["o3",             2.00,   8.00],
  ["o4-mini",        1.10,   4.40],
  ["gpt-4o-mini",    0.15,   0.60],
  ["gpt-4o",         2.50,  10.00],
  ["gpt-4.1-nano",   0.10,   0.40],
  ["gpt-4.1-mini",   0.40,   1.60],
  ["gpt-4.1",        2.00,   8.00],
];

function lookupCost(modelId) {
  const lower = modelId.toLowerCase();
  for (const [pattern, costIn, costOut] of KNOWN_COSTS) {
    if (lower.includes(pattern)) return { input: costIn, output: costOut };
  }
  return null;
}

// ── Session state ────────────────────────────────────────────────────
let codex = null;
let thread = null;
let threadId = null; // persisted for resume
let abortController = null;

function getThreadOptions() {
  const opts = {
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    workingDirectory: state.currentCwd || process.cwd(),
  };
  if (state.currentModel) {
    opts.model = state.currentModel;
  }
  if (state.currentReasoningEffort) {
    opts.modelReasoningEffort = state.currentReasoningEffort;
  }
  return opts;
}

function boot() {
  log(`Booting Codex SDK (cwd=${state.currentCwd})`);
  try {
    codex = new Codex();
    log("Codex SDK initialized successfully");
  } catch (err) {
    log(`Failed to initialize Codex SDK: ${err.message}\n${err.stack}`);
    emit({ type: "error", error: `Failed to initialize Codex SDK: ${err.message}` });
    return;
  }

  // Resume existing thread if provided
  if (config.codexThreadId) {
    threadId = config.codexThreadId;
    thread = codex.resumeThread(threadId, getThreadOptions());
    log(`Resumed Codex thread: ${threadId}`);
    emit({ type: "system", subtype: "init", session_id: threadId });
  }

  emit({
    type: "system",
    subtype: "bridge_ready",
    sessionId,
    cwd: state.currentCwd || process.cwd(),
  });
}

// ── Event stream → JSON-line translation ─────────────────────────────

function emitItemAsContent(item, isCompleted = false) {
  const blocks = [];

  switch (item.type) {
    case "agent_message": {
      blocks.push({ type: "text", text: item.text || "" });
      break;
    }
    case "reasoning": {
      blocks.push({ type: "thinking", thinking: item.text || "" });
      break;
    }
    case "command_execution": {
      blocks.push({
        type: "tool_use",
        id: item.id,
        name: "Bash",
        input: { command: item.command || "" },
      });
      if (isCompleted || item.status === "completed" || item.status === "failed") {
        blocks.push({
          type: "tool_result",
          tool_use_id: item.id,
          content: item.aggregated_output || "",
          is_error: item.status === "failed" || (item.exit_code != null && item.exit_code !== 0),
        });
      }
      break;
    }
    case "file_change": {
      const desc = (item.changes || [])
        .map((c) => `${c.kind}: ${c.path}`)
        .join("\n");
      blocks.push({
        type: "tool_use",
        id: item.id,
        name: "FileChange",
        input: { changes: item.changes || [] },
      });
      if (isCompleted || item.status === "completed" || item.status === "failed") {
        blocks.push({
          type: "tool_result",
          tool_use_id: item.id,
          content: desc || "File changes applied",
          is_error: item.status === "failed",
        });
      }
      break;
    }
    case "mcp_tool_call": {
      blocks.push({
        type: "tool_use",
        id: item.id,
        name: `${item.server}:${item.tool}`,
        input: item.arguments || {},
      });
      if (isCompleted || item.status === "completed" || item.status === "failed") {
        let output = "";
        if (item.error) {
          output = item.error.message || "MCP tool error";
        } else if (item.result) {
          const textParts = (item.result.content || [])
            .filter((c) => c.type === "text")
            .map((c) => c.text);
          output = textParts.join("\n") || JSON.stringify(item.result.structured_content || "");
        }
        blocks.push({
          type: "tool_result",
          tool_use_id: item.id,
          content: output,
          is_error: item.status === "failed" || !!item.error,
        });
      }
      break;
    }
    case "todo_list": {
      blocks.push({
        type: "tool_use",
        id: item.id,
        name: "TodoWrite",
        input: { items: item.items || [] },
      });
      if (isCompleted) {
        const summary = (item.items || [])
          .map((t) => `[${t.completed ? "x" : " "}] ${t.text}`)
          .join("\n");
        blocks.push({
          type: "tool_result",
          tool_use_id: item.id,
          content: summary,
          is_error: false,
        });
      }
      break;
    }
    case "web_search": {
      blocks.push({
        type: "tool_use",
        id: item.id,
        name: "WebSearch",
        input: { query: item.query || "" },
      });
      if (isCompleted) {
        blocks.push({
          type: "tool_result",
          tool_use_id: item.id,
          content: "Search completed",
          is_error: false,
        });
      }
      break;
    }
    case "error": {
      blocks.push({ type: "text", text: `Error: ${item.message || "Unknown error"}` });
      break;
    }
    default:
      return;
  }

  if (blocks.length > 0) {
    emit({
      type: "assistant",
      message: {
        id: `msg-${item.id || Date.now()}`,
        role: "assistant",
        content: blocks,
        model: "",
        stop_reason: null,
      },
    });
  }
}

async function runTurn(input) {
  abortController = new AbortController();

  // Create thread on first turn
  if (!thread) {
    thread = codex.startThread(getThreadOptions());
    log("Started new Codex thread");
  }

  try {
    const { events } = await thread.runStreamed(input, {
      signal: abortController.signal,
    });

    for await (const event of events) {
      try {
        handleEvent(event);
      } catch (err) {
        log(`Error handling event: ${err.message}`);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      log("Turn aborted by user");
      emit({ type: "aborted" });
      return;
    }
    log(`Turn error: ${err.message}\n${err.stack}`);
    emit({ type: "error", error: `Codex error: ${err.message}` });
  }
}

function handleEvent(event) {
  switch (event.type) {
    case "thread.started": {
      threadId = event.thread_id;
      log(`Thread started: ${threadId}`);
      emit({ type: "system", subtype: "init", session_id: threadId });
      break;
    }
    case "turn.started": {
      // Turn is beginning — nothing to emit
      break;
    }
    case "item.started": {
      emitItemAsContent(event.item, false);
      break;
    }
    case "item.updated": {
      emitItemAsContent(event.item, false);
      break;
    }
    case "item.completed": {
      emitItemAsContent(event.item, true);
      break;
    }
    case "turn.completed": {
      const usage = event.usage;
      if (usage) {
        // Estimate cost from model
        const model = state.currentModel || "o4-mini";
        const costs = lookupCost(model);
        let costUsd = 0;
        if (costs) {
          costUsd =
            (usage.input_tokens / 1_000_000) * costs.input +
            (usage.output_tokens / 1_000_000) * costs.output;
        }
        emit({
          type: "usage",
          cost_usd: costUsd,
          usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_read_input_tokens: usage.cached_input_tokens || 0,
            cache_creation_input_tokens: 0,
          },
          session_id: threadId,
        });
      }
      emitQueryComplete();
      break;
    }
    case "turn.failed": {
      const msg = event.error?.message || "Turn failed";
      log(`Turn failed: ${msg}`);
      emit({ type: "error", error: msg });
      emitQueryComplete();
      break;
    }
    case "error": {
      log(`Stream error: ${event.message}`);
      emit({ type: "error", error: event.message || "Stream error" });
      break;
    }
  }
}

function emitQueryComplete() {
  if (state.currentPermissionMode === "plan") {
    emit({
      type: "permission_request",
      toolName: "ExitPlanMode",
      input: {},
    });
    new Promise((resolve) => {
      permissionSlot.pending = resolve;
    }).then((allowed) => {
      if (allowed) {
        state.currentPermissionMode = "bypassPermissions";
        emit({ type: "permission_mode_updated", permissionMode: state.currentPermissionMode });
      }
      emit({ type: "query_complete" });
    });
  } else {
    emit({ type: "query_complete" });
  }
}

// ── Stdin handling ───────────────────────────────────────────────────

startStdinReader(handleStdinMessage, () => {
  process.exit(0);
});

async function handleStdinMessage(msg) {
  if (msg.type === "abort") {
    cancelPendingInteractions(permissionSlot, askUserSlot);
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    emit({ type: "aborted" });
    return;
  }

  if (handleInteractionResponse(msg, permissionSlot, askUserSlot, log)) return;
  if (handleCommonSetters(msg, state, log)) return;

  if (msg.type === "user") {
    await sendPrompt(msg.message);
    return;
  }

  emit({ type: "error", error: `Unknown stdin message type: ${msg.type}` });
}

async function sendPrompt(userMessage) {
  let text;
  if (typeof userMessage === "string") {
    text = userMessage;
  } else if (Array.isArray(userMessage.content)) {
    text = userMessage.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else if (typeof userMessage.content === "string") {
    text = userMessage.content;
  } else {
    text = String(userMessage);
  }

  if (!text) {
    emit({ type: "error", error: "Empty message" });
    return;
  }

  // Prepend plan mode system prompt if active
  if (state.currentPermissionMode === "plan") {
    text = `${PLAN_MODE_SYSTEM_PROMPT}\n\n${text}`;
  }

  try {
    await runTurn(text);
  } catch (err) {
    log(`Failed to send prompt: ${err.message}\n${err.stack}`);
    emit({ type: "error", error: `Failed to send prompt: ${err.message}` });
  }
}

// ── Start ────────────────────────────────────────────────────────────
boot();
