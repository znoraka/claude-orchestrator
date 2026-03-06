/**
 * Title Server — a persistent HTTP server that generates conversation titles.
 *
 * Spawned once by the Rust backend on startup. Stays warm so title generation
 * is fast (no cold-start per request). Uses the Claude Agent SDK query() with
 * haiku for minimal cost/latency.
 *
 * Protocol:
 *   - Prints `{"port": <number>}` to stdout once listening.
 *   - POST / with JSON body `{ "message": "..." }` → `{ "title": "..." }`
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createServer } from "http";
import { appendFileSync } from "fs";

// Remove CLAUDECODE env to avoid "nested session" check in the Claude CLI
delete process.env.CLAUDECODE;

const config = JSON.parse(process.argv[2] || "{}");
const claudeCliPath = config.claudeCliPath || undefined;

const logFile = "/tmp/title-server-debug.log";
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try { appendFileSync(logFile, line); } catch {}
};

const PROMPT_TEMPLATE = (userMsg) =>
  `Summarize this request in 4-5 words as a short title. Reply with ONLY the title, nothing else.\n\nUser: ${userMsg}`;

async function generateTitle(userMessage) {
  const prompt = PROMPT_TEMPLATE(userMessage);
  const options = {
    model: "haiku",
    maxTurns: 1,
    maxThinkingTokens: 0,
    allowedTools: [],
    systemPrompt: "You generate short titles. Reply with ONLY the title.",
    cwd: process.cwd(),
    ...(claudeCliPath ? { pathToClaudeCodeExecutable: claudeCliPath } : {}),
  };

  log(`query() options: model=${options.model}, cwd=${options.cwd}, cli=${claudeCliPath || "(auto)"}`);
  let result = "";
  const q = query({ prompt, options });
  for await (const message of q) {
    if (message.type === "assistant" && message.message?.content) {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") result += block.text;
        }
      } else if (typeof content === "string") {
        result += content;
      }
    }
  }
  return result.trim();
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
    const { message } = JSON.parse(body);
    if (!message) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "missing message" }));
      return;
    }

    log(`Generating title for: ${message.slice(0, 80)}...`);
    const title = await generateTitle(message);
    log(`Generated title: ${title}`);

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
