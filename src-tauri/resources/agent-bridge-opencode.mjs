/**
 * Agent Bridge — OpenCode provider.
 *
 * Speaks the same stdin/stdout JSON-line protocol as agent-bridge.mjs (claude-code)
 * but drives the OpenCode SDK (@opencode-ai/sdk) instead.
 *
 * Usage: node agent-bridge-opencode.bundle.mjs '{"sessionId":"...","cwd":"..."}'
 */
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk";
import { appendFileSync } from "fs";
import { createServer } from "net";
import { homedir } from "os";
import { join } from "path";

/** Find a free port by briefly binding to port 0. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

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

// ── List-models mode: boot, fetch models, print, exit ────────────────
if (config.mode === "list-models") {
  (async () => {
    try {
      const port = await getFreePort();
      const server = await createOpencodeServer({ port, timeout: 30_000 });
      const client = createOpencodeClient({ baseUrl: server.url, directory: process.cwd() });
      const result = await client.provider.list();
      const providers = result.data?.all || [];
      const models = [];
      for (const provider of providers) {
        for (const model of Object.values(provider.models || {})) {
          if (!model.capabilities?.toolcall) continue;
          if (model.providerID !== "opencode") continue;
          if (model.cost?.input !== 0 || model.cost?.output !== 0) continue;
          models.push({
            id: model.id,
            providerID: model.providerID,
            name: model.name || model.id,
            free: true,
            costIn: 0,
            costOut: 0,
          });
        }
      }
      process.stdout.write(JSON.stringify(models) + "\n");
      await server.kill();
    } catch (err) {
      log(`list-models failed: ${err.message}`);
    }
    process.exit(0);
  })();
  // Prevent the rest of the script from running synchronously
  // (the async IIFE above will call process.exit)
} else {
// ── Normal session mode ──────────────────────────────────────────────

// ── Boot the OpenCode server + client ────────────────────────────────
let client;
let server;
let bootPromise; // resolves when boot() completes successfully
let ocSessionId = null; // OpenCode session ID
let currentMessageId = null; // assistant message being streamed

// Parts accumulator: partId → last known state
const partsById = new Map();

async function boot() {
  log(`Booting OpenCode server (cwd=${currentCwd})`);
  try {
    const port = await getFreePort();
    log(`Using port ${port}`);
    // Pass model via config so OpenCode uses it (sets OPENCODE_CONFIG_CONTENT)
    const serverConfig = {};
    if (config.model) {
      serverConfig.model = config.model;
      log(`Setting OpenCode model: ${config.model}`);
    }
    server = await createOpencodeServer({
      port,
      timeout: 30_000,
      config: serverConfig,
    });
    client = createOpencodeClient({
      baseUrl: server.url,
      directory: currentCwd,
    });
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

  // Fetch available models and emit to frontend
  fetchAndEmitModels();
}

async function fetchAndEmitModels() {
  try {
    const result = await client.provider.list();
    const providers = result.data?.all || [];
    // Only include genuinely free models from the opencode provider
    const unique = [];
    for (const provider of providers) {
      for (const model of Object.values(provider.models || {})) {
        if (!model.capabilities?.toolcall) continue;
        if (model.providerID !== "opencode") continue;
        if (model.cost?.input !== 0 || model.cost?.output !== 0) continue;
        unique.push({
          id: model.id,
          providerID: model.providerID,
          name: model.name || model.id,
          free: true,
          costIn: 0,
          costOut: 0,
        });
      }
    }
    log(`Fetched ${unique.length} models (${unique.filter((m) => m.free).length} free)`);
    emit({ type: "available_models", models: unique });
  } catch (err) {
    log(`Failed to fetch models: ${err.message}`);
  }
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
      } else if (status?.type === "retry") {
        // OpenCode is retrying (rate limit, transient error, etc.)
        const attempt = status.attempt || 0;
        const retryMsg = status.message || `Retrying (attempt ${attempt})...`;
        log(`Session retry: ${retryMsg}`);
        emit({
          type: "assistant",
          message: {
            id: `retry-${Date.now()}`,
            role: "assistant",
            content: [{ type: "text", text: `⏳ ${retryMsg}` }],
            model: "",
            stop_reason: null,
          },
        });
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

    case "message.part.removed": {
      // A part was removed — emit an empty block to clear it in the UI.
      // The frontend's block accumulator will replace the existing block with empty content.
      const part = props.part;
      if (!part) break;
      const msgId = part.messageID || currentMessageId || `msg-${Date.now()}`;
      // Emit empty text to effectively clear the removed part
      emit({
        type: "assistant",
        message: {
          id: msgId,
          role: "assistant",
          content: [{ type: "text", text: "" }],
          model: "",
          stop_reason: null,
        },
      });
      partsById.delete(part.id);
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
      const text = part.text || "";
      // Detect QUESTIONS [...] pattern and convert to AskUserQuestion tool call.
      // Handles: "QUESTIONS [...]", "questions [...]", "Questions: [...]"
      const questionsMatch = text.match(/\bquestions\s*:?\s*(\[[\s\S]*\])/i);
      if (questionsMatch) {
        try {
          const parsed = JSON.parse(questionsMatch[1]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const toolId = `ask-${part.id || Date.now()}`;
            // Map to AskUserQuestion schema: { questions: AskQuestion[] }
            const questions = parsed.map((q) => ({
              question: q.question || q.label || "",
              header: q.header || undefined,
              options: Array.isArray(q.options) ? q.options : undefined,
            }));
            blocks.push({
              type: "tool_use",
              id: toolId,
              name: "AskUserQuestion",
              input: { questions },
            });
            // Emit any text before the QUESTIONS block
            const before = text.slice(0, text.indexOf(questionsMatch[0])).trim();
            if (before) {
              blocks.unshift({ type: "text", text: before });
            }
            break;
          }
        } catch {
          // JSON parse failed — fall through to plain text
        }
      }
      blocks.push({ type: "text", text });
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
    case "subtask": {
      // OpenCode's agent delegation — render as a tool call so the UI shows it
      const toolId = `subtask-${part.id || Date.now()}`;
      blocks.push({
        type: "tool_use",
        id: toolId,
        name: "Agent",
        input: {
          prompt: part.prompt || part.description || "Subtask",
          description: part.description || part.prompt || "Running subtask",
        },
      });
      // If the subtask has completed, emit a tool_result
      if (part.state?.status === "completed") {
        blocks.push({
          type: "tool_result",
          tool_use_id: toolId,
          content: part.state.output || "Subtask completed",
          is_error: false,
        });
      } else if (part.state?.status === "error") {
        blocks.push({
          type: "tool_result",
          tool_use_id: toolId,
          content: part.state.error || "Subtask failed",
          is_error: true,
        });
      }
      break;
    }
    case "file": {
      // File attachment — render as text with file info
      const filename = part.filename || part.url || "file";
      const mime = part.mime || "";
      blocks.push({
        type: "text",
        text: `📎 File: ${filename}${mime ? ` (${mime})` : ""}`,
      });
      break;
    }
    case "agent":
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

  if (msg.type === "ask_user_answer") {
    // User answered an AskUserQuestion — send the answer as a follow-up prompt
    const answer = msg.answer || {};
    const answerText = Object.entries(answer)
      .map(([q, a]) => `${q}: ${a}`)
      .join("\n");
    if (answerText) {
      await sendPrompt(answerText);
    }
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
    // Wait for boot to complete before using client
    await bootPromise;

    // Create session on first prompt
    if (!ocSessionId) {
      const session = await client.session.create({
        body: { title: text.substring(0, 100) },
      });
      if (session.error || !session.data) {
        const errMsg = session.error?.message || session.error || "Unknown error creating session";
        log(`Failed to create session: ${JSON.stringify(errMsg)}`);
        emit({ type: "error", error: `Failed to create OpenCode session: ${errMsg}` });
        return;
      }
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

    // Include model selection if set
    if (config.model) {
      // config.model is "providerID/modelID" or just "modelID"
      const slash = config.model.indexOf("/");
      if (slash > 0) {
        promptBody.model = {
          providerID: config.model.substring(0, slash),
          modelID: config.model.substring(slash + 1),
        };
      } else {
        promptBody.model = {
          providerID: config.model,
          modelID: config.model,
        };
      }
      log(`Using model: ${JSON.stringify(promptBody.model)}`);
    }

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
bootPromise = boot();

} // end of normal session mode (else branch)
