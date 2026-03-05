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
} = config;

// Mutable working directory — updated by set_cwd messages (e.g. after switch_workspace)
let currentCwd = initialCwd;

// Mutable model — updated by set_model messages
let currentModel = config.model || null;

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

// AskUserQuestion interception: when set, we're waiting for user input
let askUserResolve = null;

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
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    // Also unblock any pending AskUserQuestion wait
    if (askUserResolve) {
      askUserResolve(null);
      askUserResolve = null;
    }
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

  // User answered an AskUserQuestion prompt
  if (msg.type === "ask_user_answer") {
    if (askUserResolve) {
      askUserResolve(msg.answer);
      askUserResolve = null;
    }
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

  const options = {
    cwd: currentCwd || process.cwd(),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    abortController,
    settingSources: ["project"],
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

      // Intercept AskUserQuestion: interrupt the query and wait for user input
      if (
        message.type === "assistant" &&
        message.message?.content?.some(
          (b) => b.type === "tool_use" && b.name === "AskUserQuestion"
        ) &&
        message.message?.stop_reason === "tool_use"
      ) {
        log("AskUserQuestion detected — interrupting query to wait for user input");
        try { await q.interrupt(); } catch (e) { log(`interrupt error: ${e.message}`); }

        // Signal that the query paused (so frontend hides "Thinking..." indicator)
        emit({ type: "query_complete" });

        // Wait for the user's answer via stdin (ask_user_answer message)
        const answer = await new Promise((resolve) => {
          askUserResolve = resolve;
        });

        if (answer !== null) {
          log(`User answered AskUserQuestion: ${answer.substring(0, 100)}`);
          // Resume the conversation with the user's answer
          abortController = null;
          queryInProgress = false;
          await runQuery(answer);
        } else {
          log("AskUserQuestion cancelled (abort)");
          emit({ type: "aborted" });
        }
        return; // Don't emit query_complete — runQuery handles it
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
    abortController = null;
    queryInProgress = false;
  }
}

// Signal readiness
emit({
  type: "system",
  subtype: "bridge_ready",
  sessionId,
  cwd: currentCwd || process.cwd(),
});
