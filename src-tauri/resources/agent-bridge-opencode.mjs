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
const { sessionId, cwd: initialCwd, permissionMode: configPermissionMode } = config;

let currentCwd = initialCwd;

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

// Mutable permission mode — can be toggled at runtime via set_permission_mode
let currentPermissionMode = configPermissionMode || "bypassPermissions";

// Permission prompt interception (for plan mode): when set, we're waiting
// for the user to approve/deny a tool use.
let permissionResolve = null;
let askUserResolve = null;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// ── Fallback pricing (USD per million tokens) ────────────────────────
// Used when OpenCode reports 0/0 cost for a model.
// Entries are matched as substrings against the model ID (case-insensitive).
const KNOWN_COSTS = [
  // OpenAI
  ["o1-mini",              1.10,   4.40],
  ["o1",                  15.00,  60.00],
  ["o3-mini",              1.10,   4.40],
  ["o3",                   2.00,   8.00],
  ["o4-mini",              1.10,   4.40],
  ["gpt-4o-mini",          0.15,   0.60],
  ["gpt-4o",               2.50,  10.00],
  ["gpt-4.1-nano",         0.10,   0.40],
  ["gpt-4.1-mini",         0.40,   1.60],
  ["gpt-4.1",              2.00,   8.00],
  // Anthropic
  ["claude-opus-4",       15.00,  75.00],
  ["claude-sonnet-4",      3.00,  15.00],
  ["claude-haiku-4",       1.00,   5.00],
  ["claude-opus-4.5",      5.00,  25.00],
  ["claude-sonnet-4.5",    3.00,  15.00],
  ["claude-opus-4.6",      5.00,  25.00],
  ["claude-sonnet-4.6",    3.00,  15.00],
  // Google
  ["gemini-2.5-pro",       1.25,  10.00],
  ["gemini-2.5-flash-lite",0.10,   0.40],
  ["gemini-2.5-flash",     0.30,   2.50],
  ["gemini-2.0-flash",     0.10,   0.40],
  ["gemini-3.1-pro",       2.00,  12.00],
  ["gemini-3-flash",       0.50,   3.00],
  // Mistral
  ["codestral",            0.30,   0.90],
  ["devstral",             0.40,   2.00],
  ["mistral-large",        0.50,   1.50],
  ["mistral-medium",       0.40,   2.00],
  ["mistral-small",        0.35,   0.56],
  // DeepSeek
  ["deepseek-chat",        0.28,   0.42],
  ["deepseek-reasoner",    0.28,   0.42],
  // xAI
  ["grok-4-fast",          0.20,   0.50],
  ["grok-4",               3.00,  15.00],
  ["grok-3-mini",          0.30,   0.50],
  ["grok-3",               3.00,  15.00],
  // Groq-hosted
  ["llama-4-maverick",     0.20,   0.60],
  ["llama-4-scout",        0.11,   0.34],
  ["llama-3.3-70b",        0.59,   0.79],
  ["llama-3.1-8b",         0.05,   0.08],
];

function lookupCost(modelId) {
  const lower = modelId.toLowerCase();
  for (const [pattern, costIn, costOut] of KNOWN_COSTS) {
    if (lower.includes(pattern)) return { input: costIn, output: costOut };
  }
  return null;
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
      const connected = new Set(result.data?.connected || []);
      const models = [];
      for (const provider of providers) {
        if (!connected.has(provider.id)) continue;
        for (const model of Object.values(provider.models || {})) {
          if (!model.capabilities?.toolcall) continue;
          const fallback = lookupCost(model.id);
          models.push({
            id: model.id,
            providerID: model.providerID,
            name: model.name || model.id,
            free: false,
            costIn: model.cost?.input || fallback?.input || 0,
            costOut: model.cost?.output || fallback?.output || 0,
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
let idleTimer = null; // debounce timer for query_complete

// Track user message IDs so we don't emit their parts as assistant content
const userMessageIds = new Set();

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

  // If resuming an existing OpenCode session, load its history
  if (config.ocSessionId) {
    ocSessionId = config.ocSessionId;
    log(`Resuming OpenCode session: ${ocSessionId}`);
    emit({ type: "system", subtype: "init", session_id: ocSessionId });
    await loadSessionHistory(ocSessionId);
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
    const connected = new Set(result.data?.connected || []);
    const unique = [];
    for (const provider of providers) {
      if (!connected.has(provider.id)) continue;
      for (const model of Object.values(provider.models || {})) {
        if (!model.capabilities?.toolcall) continue;
        const fallback = lookupCost(model.id);
        unique.push({
          id: model.id,
          providerID: model.providerID,
          name: model.name || model.id,
          free: false,
          costIn: model.cost?.input || fallback?.input || 0,
          costOut: model.cost?.output || fallback?.output || 0,
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
        // Cancel any pending idle→complete debounce
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      } else if (status?.type === "idle") {
        // Debounce: OpenCode briefly goes idle between steps.
        // Wait before signaling "done" so the UI doesn't flicker.
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimer = null;
          emitQueryComplete();
        }, 500);
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
      if (info.role === "user") {
        userMessageIds.add(info.id);
        break;
      }
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

      // Skip parts belonging to user messages (already shown as user bubbles)
      if (part.messageID && userMessageIds.has(part.messageID)) break;

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
      const permission = props;
      log(`Permission requested: ${permission.type} — ${permission.title} (mode=${currentPermissionMode})`);

      // Check if this is a question permission
      const isQuestion = permission.type === "question" || permission.title === "question";
      
      if (isQuestion) {
        // Handle question tool — emit ask_user_question to frontend
        const questions = permission.metadata?.questions || [];
        emit({
          type: "ask_user_question",
          questions: questions,
        });
        // Wait for the user to answer, then respond to OpenCode
        const sid = permission.sessionID;
        const pid = permission.id;
        new Promise((resolve) => {
          askUserResolve = resolve;
        }).then((answer) => {
          log(`Question ${pid} answered: ${JSON.stringify(answer).substring(0, 100)}`);
          client.postSessionIdPermissionsPermissionId({
            path: { id: sid, permissionId: pid },
            body: { allow: true, answer: answer },
          }).catch((err) => log(`Failed to respond to question: ${err.message}`));
        });
        break;
      }

      // In both bypass and plan mode, auto-approve all permissions.
      // Plan mode constrains the agent via system prompt, not by blocking tool use.
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
      // Intercept "question" tool — convert to AskUserQuestion
      if (part.tool === "question") {
        const input = part.state?.input || {};
        const rawQuestions = input.questions || [input];
        const questions = (Array.isArray(rawQuestions) ? rawQuestions : [rawQuestions]).map((q) => ({
          question: q.question || q.label || "",
          header: q.header || undefined,
          options: Array.isArray(q.options) ? q.options : undefined,
        }));
        if (questions.length > 0 && questions[0].question) {
          const toolId = `ask-${part.id || Date.now()}`;
          blocks.push({
            type: "tool_use",
            id: toolId,
            name: "AskUserQuestion",
            input: { questions },
          });
          break;
        }
      }
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
        let output = state.output || "";
        // Normalize OpenCode's XML-wrapped read output to cat -n format
        if (part.tool === "read" && output.includes("<content>")) {
          const contentMatch = output.match(/<content>([\s\S]*?)<\/content>/);
          if (contentMatch) {
            output = contentMatch[1]
              .replace(/\(End of file[^\n]*\)\n?$/, "")
              .trimEnd()
              .split("\n")
              .map((line) => {
                const m = line.match(/^(\d+): (.*)$/);
                return m ? `     ${m[1]}\t${m[2]}` : line;
              })
              .join("\n");
          }
        }
        blocks.push({
          type: "tool_result",
          tool_use_id: part.callID || part.id,
          content: output,
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

// ── Load session history from OpenCode SDK ──────────────────────────
async function loadSessionHistory(sid) {
  try {
    const result = await client.session.messages({ path: { id: sid } });
    if (result.error || !result.data) {
      log(`Failed to load session history: ${JSON.stringify(result.error)}`);
      emit({ type: "history_loaded", success: false });
      return;
    }

    log(`Loading history: ${result.data.length} messages`);

    for (const { info, parts } of result.data) {
      if (info.role === "user") {
        // Extract text from user message parts
        const textParts = (parts || []).filter((p) => p.type === "text");
        const text = textParts.map((p) => p.text || "").join("\n");
        emit({
          type: "user_history",
          message: {
            id: info.id,
            role: "user",
            content: [{ type: "text", text }],
          },
        });
      } else if (info.role === "assistant") {
        // Emit each part using the same translation logic as streaming
        for (const part of parts || []) {
          emitPartAsAssistantMessage(part);
        }
        // Emit result with token/cost data from message metadata
        if (info.tokens || info.cost != null) {
          emit({
            type: "result",
            subtype: "result",
            result: "",
            cost_usd: info.cost || 0,
            session_id: sid,
            usage: {
              input_tokens: info.tokens?.input || 0,
              output_tokens: info.tokens?.output || 0,
              cache_read_input_tokens: info.tokens?.cache?.read || 0,
              cache_creation_input_tokens: info.tokens?.cache?.write || 0,
            },
          });
        }
      }
    }

    emit({ type: "history_loaded", success: true });
    log(`Session history loaded successfully`);
  } catch (err) {
    log(`Error loading session history: ${err.message}`);
    emit({ type: "history_loaded", success: false });
  }
}

function emitQueryComplete() {
  currentMessageId = null;
  partsById.clear();

  if (currentPermissionMode === "plan") {
    // Emit synthetic ExitPlanMode permission request — triggers the frontend's
    // "Plan ready — how do you want to proceed?" UI
    emit({
      type: "permission_request",
      toolName: "ExitPlanMode",
      input: {},
    });
    // Wait for user response
    new Promise((resolve) => {
      permissionResolve = resolve;
    }).then((allowed) => {
      if (allowed) {
        // User accepted the plan — switch to bypass mode so the next prompt executes
        currentPermissionMode = "bypassPermissions";
        emit({ type: "permission_mode_updated", permissionMode: currentPermissionMode });
      }
      emit({ type: "query_complete" });
    });
  } else {
    emit({ type: "query_complete" });
  }
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
    // Cancel any pending idle debounce so we don't emit query_complete after abort
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // Unblock any pending permission wait
    if (permissionResolve) {
      permissionResolve(false);
      permissionResolve = null;
    }
    if (askUserResolve) {
      askUserResolve(null);
      askUserResolve = null;
    }
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

  if (msg.type === "set_model") {
    // OpenCode model is set per-prompt, not globally — we'll store it
    config.model = msg.model || null;
    log(`model updated to: ${config.model}`);
    emit({ type: "model_updated", model: config.model });
    return;
  }

  if (msg.type === "get_usage") {
    // Query the OpenCode server for usage/session status info
    try {
      await bootPromise;
      const status = await client.session.status();
      emit({ type: "opencode_usage", data: status.data || status });
    } catch (err) {
      log(`Failed to get usage: ${err.message}`);
      emit({ type: "opencode_usage", data: null, error: err.message });
    }
    return;
  }

  if (msg.type === "ask_user_answer") {
    // User answered an AskUserQuestion — resolve the pending question promise
    if (askUserResolve) {
      log(`Resolving ask_user_question with: ${JSON.stringify(msg.answer).substring(0, 100)}`);
      askUserResolve(msg.answer);
      askUserResolve = null;
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

    // Inject system prompt: combine config.systemPrompt + plan mode instructions
    {
      const parts = [];
      if (config.systemPrompt) parts.push(config.systemPrompt);
      if (currentPermissionMode === "plan") parts.push(PLAN_MODE_SYSTEM_PROMPT);
      if (parts.length > 0) promptBody.system = parts.join("\n\n");
    }

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
