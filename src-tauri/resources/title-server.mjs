/**
 * Title Server — a persistent HTTP server that generates conversation titles
 * and classifies prompts using the Claude Agent SDK.
 *
 * Spawned once by the Rust backend on startup. Stays warm so title generation
 * is fast (no cold-start per request). Uses the SDK's query() function for
 * LLM calls in a separate process to avoid nested Claude Code issues.
 *
 * Protocol:
 *   - Prints `{"port": <number>}` to stdout once listening.
 *   - POST / with JSON body `{ "message": "..." }` → `{ "title": "..." }`
 *   - POST /classify with JSON body `{ "message": "..." }` → `{ "classification": "simple"|"complex" }`
 */
import { createServer } from "http";
import { appendFileSync } from "fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Remove CLAUDECODE env to avoid "nested session" check in the Claude CLI
delete process.env.CLAUDECODE;

const config = JSON.parse(process.argv[2] || "{}");
const claudeCliPath = config.claudeCliPath || "claude";

const logFile = "/tmp/title-server-debug.log";
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try { appendFileSync(logFile, line); } catch {}
};

const MODEL = "claude-haiku-4-5-20251001";

const TITLE_SYSTEM_PROMPT = "You are a title generator. Given a user message, respond with ONLY a 4-5 word title summarizing the request. No quotes, no punctuation, no explanation.";

const CLASSIFY_SYSTEM_PROMPT = `You classify coding requests as "simple" or "complex".

Simple: single well-defined action — commit, push, run tests, rename variable, fix typo, create/delete a file, install a package, format code, a quick one-liner change.
Complex: multi-step tasks, architectural decisions, refactoring, debugging, anything ambiguous or requiring research/planning.

When in doubt, respond "complex".

Reply with ONLY "simple" or "complex".`;

async function runSdkQuery(systemPrompt, userMessage) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30000);
  try {
    const options = {
      maxTurns: 1,
      model: MODEL,
      systemPrompt,
      permissionMode: "bypassPermissions",
      abortController,
    };
    if (claudeCliPath) {
      options.pathToClaudeCodeExecutable = claudeCliPath;
    }
    const result = query({ prompt: userMessage, options });
    let text = "";
    for await (const message of result) {
      if (message.type === "assistant" && message.message?.content) {
        const content = [].concat(message.message.content);
        for (const block of content) {
          if (block.type === "text") text += block.text;
        }
      }
    }
    return text.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function generateTitle(userMessage) {
  log(`Calling SDK query() for title generation`);
  return await runSdkQuery(TITLE_SYSTEM_PROMPT, userMessage);
}

async function classifyPrompt(userMessage) {
  log(`Calling SDK query() for classification`);
  const result = await runSdkQuery(CLASSIFY_SYSTEM_PROMPT, userMessage);
  const classification = result.toLowerCase().trim();
  return classification === "simple" ? "simple" : "complex";
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;

  try {
    const { message, images } = JSON.parse(body);
    if (!message && !(images && images.length)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "missing message" }));
      return;
    }

    const url = (req.url || "/").split("?")[0];

    if (url === "/classify") {
      log(`Classifying: ${(message || "").slice(0, 80)}...`);
      const t0 = Date.now();
      const classification = await classifyPrompt(message || "");
      log(`Classification: ${classification} (${Date.now() - t0}ms)`);
      const responseBody = JSON.stringify({ classification });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(responseBody) });
      res.end(responseBody);
      return;
    }

    // Default: title generation
    log(`Generating title for: ${(message || "").slice(0, 80)}...`);
    const t0 = Date.now();
    const title = await generateTitle(message || "");
    log(`Generated title: ${title} (${Date.now() - t0}ms)`);

    const responseBody = JSON.stringify({ title });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(responseBody) });
    res.end(responseBody);
  } catch (err) {
    log(`Error: ${err.message}`);
    const errorBody = JSON.stringify({ error: err.message });
    res.writeHead(500, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(errorBody) });
    res.end(errorBody);
  }
});

// Listen on a random port
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  log(`Title server listening on port ${port}`);
  // Signal the port to the parent process
  process.stdout.write(JSON.stringify({ port }) + "\n");
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log("Received SIGTERM, shutting down");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  log("Received SIGINT, shutting down");
  server.close(() => process.exit(0));
});
