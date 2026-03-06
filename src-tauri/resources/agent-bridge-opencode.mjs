/**
 * Agent Bridge — OpenCode provider.
 *
 * Speaks the same stdin/stdout JSON-line protocol as agent-bridge.mjs (claude-code)
 * but drives the OpenCode SDK (@opencode-ai/sdk) instead.
 *
 * Usage: node agent-bridge-opencode.bundle.mjs '{"sessionId":"...","cwd":"..."}'
 */
import { createOpencode } from "@opencode-ai/sdk";
import { appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Ensure ~/.opencode/bin is in PATH (macOS GUI apps don't inherit interactive shell PATH)
const opencodebin = join(homedir(), ".opencode", "bin");
if (!process.env.PATH?.includes(opencodebin)) {
  process.env.PATH = `${opencodebin}:${process.env.PATH || ""}`;
}

// ── Logging ──────────────────────────────────────────────────────────
const logFile = "/tmp/agent-bridge-opencode-debug.log";
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try { appendFileSync(logFile, line); } catch {}
};

// ── Config ───────────────────────────────────────────────────────────
const config = JSON.parse(process.argv[2] || "{}");
const { sessionId, cwd: initialCwd } = config;

let currentCwd = initialCwd;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// ── Boot the OpenCode server + client ────────────────────────────────
let client;
let server;
let ocSessionId = null; // OpenCode session ID
let currentMessageId = null; // assistant message being streamed

// Parts accumulator: partId → last known state
const partsById = new Map();

async function boot() {
  log(`Booting OpenCode server (cwd=${currentCwd})`);
  try {
    const result = await createOpencode({
      config: {
        directory: currentCwd,
      },
    });
    client = result.client;
    server = result.server;
    log(`OpenCode server started at ${server.url}`);
  } catch (err) {
    log(`Failed to start OpenCode server: ${err.message}`);
    emit({ type: "error", error: `Failed to start OpenCode: ${err.message}` });
    process.exit(1);
  }

  // Subscribe to SSE events
  try {
    const sse = await client.event.subscribe();
    readEvents(sse);
  } catch (err) {
    log(`Failed to subscribe to events: ${err.message}`);
    emit({ type: "error", error: `Failed to subscribe to OpenCode events: ${err.message}` });
  }

  emit({
    type: "system",
    subtype: "bridge_ready",
    sessionId,
    cwd: currentCwd || process.cwd(),
  });
}

// ── Event stream → JSON-line translation ────────────────────────────

async function readEvents(sse) {
  try {
    for await (const event of sse.stream) {
      try {
        handleEvent(event);
      } catch (err) {
        log(`Error handling event: ${err.message}`);
      }
    }
  } catch (err) {
    log(`SSE stream error: ${err.message}`);
  }
  log("SSE stream ended");
}

function handleEvent(event) {
  if (!event || !event.type) return;

  // Filter to our session only
  const props = event.properties || {};
  const eventSessionId = props.sessionID || props.info?.sessionID;
  if (eventSessionId && ocSessionId && eventSessionId !== ocSessionId) return;

  switch (event.type) {
    case "session.status": {
      const status = props.status;
      if (status?.type === "busy") {
        // Session became busy — nothing to emit, frontend already knows from prompt send
      } else if (status?.type === "idle") {
        // Session finished processing
        emitQueryComplete();
      }
      break;
    }

    case "message.updated": {
      const info = props.info;
      if (!info) break;
      if (info.role === "assistant") {
        currentMessageId = info.id;
        // Emit cost/usage info if the message has completed
        if (info.time?.completed) {
          emit({
            type: "result",
            subtype: "result",
            result: "",
            cost_usd: info.cost || 0,
            usage: {
              input_tokens: info.tokens?.input || 0,
              output_tokens: info.tokens?.output || 0,
              cache_read_input_tokens: info.tokens?.cache?.read || 0,
              cache_creation_input_tokens: info.tokens?.cache?.write || 0,
            },
            session_id: ocSessionId,
          });
        }
      }
      break;
    }

    case "message.part.updated": {
      const part = props.part;
      const delta = props.delta;
      if (!part) break;

      // Only handle parts for our current assistant message
      if (currentMessageId && part.messageID !== currentMessageId) {
        // Could be a new message — update tracking
        currentMessageId = part.messageID;
      }

      partsById.set(part.id, part);
      emitPartAsAssistantMessage(part, delta);
      break;
    }

    case "permission.updated": {
      // OpenCode is requesting permission — auto-approve or translate to AskUserQuestion
      const permission = props;
      log(`Permission requested: ${permission.type} — ${permission.title}`);
      // Auto-approve all permissions (matching claude-code's bypassPermissions behavior)
      client.postSessionIdPermissionsPermissionId({
        path: {
          id: permission.sessionID,
          permissionId: permission.id,
        },
        body: { allow: true },
      }).catch((err) => log(`Failed to approve permission: ${err.message}`));
      break;
    }

    case "session.error": {
      const error = props.error;
      const msg = error?.data?.message || error?.name || "Unknown OpenCode error";
      log(`Session error: ${msg}`);
      emit({ type: "error", error: msg });
      break;
    }

    default:
      // Ignore other events (file.edited, session.created, etc.)
      break;
  }
}

function emitPartAsAssistantMessage(part, delta) {
  // Translate OpenCode part types to claude-code content blocks
  const blocks = [];

  switch (part.type) {
    case "text": {
      blocks.push({ type: "text", text: part.text || "" });
      break;
    }
    case "reasoning": {
      blocks.push({ type: "thinking", thinking: part.text || "" });
      break;
    }
    case "tool": {
      const state = part.state;
      // Emit tool_use block
      blocks.push({
        type: "tool_use",
        id: part.callID || part.id,
        name: part.tool,
        input: state?.input || {},
      });
      // If completed or error, also emit tool_result
      if (state?.status === "completed") {
        blocks.push({
          type: "tool_result",
          tool_use_id: part.callID || part.id,
          content: state.output || "",
          is_error: false,
        });
      } else if (state?.status === "error") {
        blocks.push({
          type: "tool_result",
          tool_use_id: part.callID || part.id,
          content: state.error || "Tool error",
          is_error: true,
        });
      }
      break;
    }
    case "step-start":
    case "step-finish":
    case "snapshot":
    case "patch":
    case "compaction":
    case "retry":
      // Internal lifecycle events — skip for chat UI
      return;
    default:
      return;
  }

  if (blocks.length > 0) {
    emit({
      type: "assistant",
      message: {
        id: part.messageID || `msg-${Date.now()}`,
        role: "assistant",
        content: blocks,
        model: "",
        stop_reason: null,
      },
    });
  }
}

function emitQueryComplete() {
  currentMessageId = null;
  partsById.clear();
  emit({ type: "query_complete" });
}

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
  if (server) server.close();
  process.exit(0);
});

async function handleStdinMessage(msg) {
  if (msg.type === "abort") {
    if (ocSessionId) {
      try {
        await client.session.abort({ path: { id: ocSessionId } });
      } catch (err) {
        log(`Failed to abort session: ${err.message}`);
      }
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
    // OpenCode model is set per-prompt, not globally — we'll store it
    config.model = msg.model || null;
    log(`model updated to: ${config.model}`);
    emit({ type: "model_updated", model: config.model });
    return;
  }

  if (msg.type === "user") {
    await sendPrompt(msg.message);
    return;
  }

  emit({ type: "error", error: `Unknown stdin message type: ${msg.type}` });
}

async function sendPrompt(userMessage) {
  // Extract text from message
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

  try {
    // Create session on first prompt
    if (!ocSessionId) {
      const session = await client.session.create({
        body: { title: text.substring(0, 100) },
      });
      ocSessionId = session.data.id;
      log(`OpenCode session created: ${ocSessionId}`);
      emit({
        type: "system",
        subtype: "init",
        session_id: ocSessionId,
      });
    }

    // Build prompt options
    const promptBody = {
      parts: [{ type: "text", text }],
    };

    // Send prompt (async — results come via SSE events)
    await client.session.promptAsync({
      path: { id: ocSessionId },
      body: promptBody,
    });

    log(`Prompt sent to OpenCode session ${ocSessionId}`);
  } catch (err) {
    log(`Failed to send prompt: ${err.message}\n${err.stack}`);
    emit({ type: "error", error: `Failed to send prompt: ${err.message}` });
  }
}

// ── Start ───────────────────────────────────────────────────────────
boot();
