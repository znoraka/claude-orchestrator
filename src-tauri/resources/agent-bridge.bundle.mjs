// src-tauri/resources/agent-bridge.mjs
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
var logFile = "/tmp/agent-bridge-debug.log";
var log = (msg) => {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  process.stderr.write(line);
  try {
    appendFileSync(logFile, line);
  } catch {
  }
};
var config = JSON.parse(process.argv[2] || "{}");
var {
  sessionId,
  cwd,
  resume,
  mcpServers,
  systemPrompt,
  allowedTools
} = config;
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
log(`PATH: ${process.env.PATH}`);
log(`HOME: ${process.env.HOME}`);
log(`node: ${process.execPath}`);
log(`cwd config: ${cwd}`);
log(`cwd actual: ${process.cwd()}`);
log(`cwd exists: ${existsSync(cwd || process.cwd())}`);
var claudeSessionId = resume || null;
var abortController = null;
var queryInProgress = false;
var stdinBuf = "";
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
    cwd: cwd || process.cwd(),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    abortSignal: abortController.signal,
    executable: process.execPath,
    settingSources: ["project"]
  };
  if (claudeSessionId) {
    options.resume = claudeSessionId;
  }
  if (systemPrompt) {
    options.systemPrompt = { type: "preset", preset: "claude_code", append: systemPrompt };
  } else {
    options.systemPrompt = { type: "preset", preset: "claude_code" };
  }
  if (mcpServers && Object.keys(mcpServers).length > 0) options.mcpServers = mcpServers;
  if (allowedTools) options.allowedTools = allowedTools;
  try {
    log(`query() starting \u2014 cwd=${options.cwd}, resume=${claudeSessionId || "(new)"}`);
    for await (const message of query({ prompt, options })) {
      if (message.type === "system" && message.subtype === "init" && message.session_id) {
        claudeSessionId = message.session_id;
        log(`Session ID captured: ${claudeSessionId}`);
      }
      emit(message);
    }
    emit({ type: "query_complete" });
  } catch (err) {
    log(`query() error: ${err.message}
${err.stack}`);
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
emit({
  type: "system",
  subtype: "bridge_ready",
  sessionId,
  cwd: cwd || process.cwd()
});
