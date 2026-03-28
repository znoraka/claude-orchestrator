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
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";

// Remove CLAUDECODE env to avoid "nested session" check in the Claude CLI
delete process.env.CLAUDECODE;

const config = JSON.parse(process.argv[2] || "{}");
const claudeCliPath = config.claudeCliPath || "claude";
const opencodeCliPath = config.opencodeCliPath || "opencode";

if (opencodeCliPath && opencodeCliPath !== "opencode") {
  const opencodeDir = opencodeCliPath.substring(0, opencodeCliPath.lastIndexOf("/"));
  if (opencodeDir) {
    process.env.PATH = opencodeDir + ":" + process.env.PATH;
  }
}

const logFile = "/tmp/title-server-debug.log";
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try { appendFileSync(logFile, line); } catch {}
};

const MODEL = "claude-sonnet-4-6";

let freeModel = null;

async function getFreeModel() {
  if (freeModel) return freeModel;
  try {
    const port = await new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
      srv.on("error", reject);
    });
    const server = await createOpencodeServer({ port, timeout: 30_000 });
    const client = createOpencodeClient({ baseUrl: server.url, directory: process.cwd() });
    const result = await client.provider.list();
    const providers = result.data?.all || [];
    for (const provider of providers) {
      for (const model of Object.values(provider.models || {})) {
        if (model.providerID !== "opencode") continue;
        if (model.capabilities?.toolcall && model.cost?.input === 0 && model.cost?.output === 0) {
          freeModel = model.id;
          log(`Found free model: ${freeModel}`);
          return freeModel;
        }
      }
    }
    log("No free model found, using default");
    return MODEL;
  } catch (err) {
    log(`Failed to get free model: ${err.message}`);
    return MODEL;
  }
}

const TITLE_SYSTEM_PROMPT = "You are a title generator. Given a user message, respond with ONLY a 4-5 word title summarizing the request. No quotes, no punctuation, no explanation.";

const COMMIT_MSG_SYSTEM_PROMPT = `You generate git commit messages in conventional commits format.
Given a git diff, write a concise commit message: one subject line (max 72 chars, imperative mood, e.g. "feat: add login button"), optionally followed by a blank line and a short body.
Reply with ONLY the commit message, no explanations.`;

async function generateCommitMessage(diff, model, provider, commitFormat, recentCommits) {
  const truncated = diff.slice(0, 8000);

  let systemPrompt;
  if (commitFormat) {
    systemPrompt = `You generate git commit messages following the project's specific commit conventions described below.
Given a git diff, write a commit message that strictly follows these conventions.
Reply with ONLY the commit message, no explanations.

--- PROJECT COMMIT CONVENTIONS ---
${commitFormat}
--- END CONVENTIONS ---`;
  } else {
    systemPrompt = COMMIT_MSG_SYSTEM_PROMPT;
  }

  if (recentCommits) {
    systemPrompt += `\n\nHere are recent commit messages from this repo — match their style, casing, prefix format, and tone:\n${recentCommits}`;
  }

  const userMessage = `Generate a commit message for this diff:\n\n${truncated}`;
  if (provider === "opencode") {
    return runOpencodeQuery(systemPrompt, userMessage, model);
  }
  return runSdkQuery(systemPrompt, userMessage, model);
}

const PR_DESCRIPTION_SYSTEM_PROMPT = `You generate pull request titles and descriptions.

Given a branch name, commit log, and diff, generate a PR title and description.

TITLE RULES:
- Max 60 characters — short and descriptive
- Derive from branch name: remove prefix (feature/, fix/, hotfix/, chore/, etc.), replace dashes with spaces, capitalize first letter
- If the branch name is not descriptive enough, use the commit messages to infer a better title
- Examples: "feature/watch-list-exclusion" → "Watch list exclusion", "fix/signals-tracking-bug" → "Signals tracking bug"

DESCRIPTION FORMAT:
## Summary
[1-2 sentences: WHAT was done and WHY]

## How it works
[Functional explanation — no code, just how the changes address the feature or bug]

## Changes
- **[Category]** in \`file.ts\` ([N] lines): [Brief description]
- **Total changes**: [N] lines across [N] files

## Impact / Risks
**Impact:** [User-facing impact]
**Risks:** [Risk level]: [Description]

## How to test
- [ ] [Setup step]
- [ ] [Action to perform]
- [ ] [Expected result]

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Reply with ONLY valid JSON: {"title": "...", "description": "..."}`;

async function generatePRDescription(branchName, commits, diff, model, provider) {
  const truncatedDiff = diff.slice(0, 12000);
  const userMessage = `Generate a PR title and description.

Branch: ${branchName}

Commits:
${commits}

Diff (truncated):
${truncatedDiff}`;

  if (provider === "opencode") {
    const raw = await runOpencodeQuery(PR_DESCRIPTION_SYSTEM_PROMPT, userMessage, model);
    return parsePRResponse(raw, branchName);
  }
  const raw = await runSdkQuery(PR_DESCRIPTION_SYSTEM_PROMPT, userMessage, model);
  return parsePRResponse(raw, branchName);
}

function parsePRResponse(raw, branchName) {
  // Try to parse JSON response
  try {
    // Extract JSON from potential markdown code fences
    const jsonStr = raw.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(jsonStr);
    if (parsed.title && parsed.description) {
      // Enforce title length
      const title = parsed.title.length > 60 ? parsed.title.slice(0, 57) + "..." : parsed.title;
      return { title, description: parsed.description };
    }
  } catch {}
  // Fallback: derive title from branch name
  const title = branchName
    .replace(/^(feature|fix|hotfix|chore|refactor|docs|perf|ci|build|test)\//, "")
    .replace(/-/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
  return { title: title.slice(0, 60), description: raw || "" };
}

const CLASSIFY_SYSTEM_PROMPT = `You classify coding requests as "simple" or "complex".

Simple: single well-defined action — commit, push, run tests, rename variable, fix typo, create/delete a file, install a package, format code, a quick one-liner change.
Complex: multi-step tasks, architectural decisions, refactoring, debugging, anything ambiguous or requiring research/planning.

When in doubt, respond "complex".

Reply with ONLY "simple" or "complex".`;

async function runSdkQuery(systemPrompt, userMessage, model) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30000);
  try {
    const options = {
      maxTurns: 1,
      model: model || MODEL,
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

async function runOpencodeQuery(systemPrompt, userMessage, modelId) {
  try {
    const port = await new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
      srv.on("error", reject);
    });
    const server = await createOpencodeServer({ port, timeout: 60_000 });
    const client = createOpencodeClient({ baseUrl: server.url, directory: process.cwd() });

    // Parse model ID — opencode expects { providerID, modelID }
    // modelId format could be "providerID/modelID" or just "modelID"
    let providerID = "opencode";
    let parsedModelID = modelId || "";
    if (parsedModelID.includes("/")) {
      [providerID, parsedModelID] = parsedModelID.split("/", 2);
    }

    // Create a session first
    const sessionResult = await client.session.create({
      body: { system: systemPrompt },
    });
    const sessionId = sessionResult.data?.id || sessionResult.id;

    const response = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID, modelID: parsedModelID },
        parts: [{ type: "text", text: userMessage }],
        system: systemPrompt,
      },
    });

    const parts = response.data?.parts || response.parts || [];
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    return text.trim();
  } catch (err) {
    log(`OpenCode query failed: ${err.message}`);
    throw err;
  }
}

const BAD_TITLE_PHRASES = [
  "ready to generate",
  "provide a user message",
  "i'll read",
  "i will read",
  "cannot generate",
  "no user message",
  "please provide",
  "let me read",
];

async function generateTitle(userMessage) {
  log(`Calling SDK query() for title generation`);
  let raw = await runSdkQuery(TITLE_SYSTEM_PROMPT, userMessage);

  // If empty, retry with a more explicit prompt
  if (!raw.trim()) {
    log(`Empty title, retrying with explicit prompt`);
    raw = await runSdkQuery(
      TITLE_SYSTEM_PROMPT,
      `Generate a 4-5 word title for this request:\n\n${userMessage}`
    );
  }

  // Strip surrounding quotes and trailing punctuation the model sometimes adds
  raw = raw.replace(/^["']+|["']+$/g, "").replace(/[.!?]+$/, "").trim();

  const lower = raw.toLowerCase();
  if (BAD_TITLE_PHRASES.some((p) => lower.includes(p))) {
    log(`Discarding bad title: ${raw}`);
    return "";
  }
  if (raw.split(/\s+/).length > 12) {
    // Try to salvage: take the first sentence or first 6 words
    const firstSentence = raw.split(/[.!?\n]/)[0].trim();
    if (
      firstSentence &&
      firstSentence.split(/\s+/).length <= 8 &&
      !BAD_TITLE_PHRASES.some((p) => firstSentence.toLowerCase().includes(p))
    ) {
      log(`Truncated long title to: ${firstSentence}`);
      return firstSentence;
    }
    log(`Discarding too-long title: ${raw}`);
    return "";
  }
  return raw;
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
    const parsed = JSON.parse(body);
    const url = (req.url || "/").split("?")[0];

    if (url === "/commit-message") {
      const { diff, model, provider, commitFormat, recentCommits } = parsed;
      if (!diff) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "missing diff" }));
        return;
      }
      log(`Generating commit message for diff (${diff.length} chars)${model ? ` with model ${model}` : ''}${provider ? ` via ${provider}` : ''}${commitFormat ? ' (custom format)' : ''}${recentCommits ? ' (with history)' : ''}`);
      const t0 = Date.now();
      const commitMessage = await generateCommitMessage(diff, model, provider, commitFormat, recentCommits);
      log(`Generated commit message (${Date.now() - t0}ms)`);
      const responseBody = JSON.stringify({ message: commitMessage });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(responseBody) });
      res.end(responseBody);
      return;
    }

    if (url === "/pr-description") {
      const { branchName, commits, diff, model, provider } = parsed;
      if (!branchName) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "missing branchName" }));
        return;
      }
      log(`Generating PR description for branch ${branchName}${model ? ` with model ${model}` : ''}${provider ? ` via ${provider}` : ''}`);
      const t0 = Date.now();
      const result = await generatePRDescription(branchName, commits || "", diff || "", model, provider);
      log(`Generated PR description (${Date.now() - t0}ms): title="${result.title}"`);
      const responseBody = JSON.stringify(result);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(responseBody) });
      res.end(responseBody);
      return;
    }

    const { message, images } = parsed;
    if (!message && !(images && images.length)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "missing message" }));
      return;
    }

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
