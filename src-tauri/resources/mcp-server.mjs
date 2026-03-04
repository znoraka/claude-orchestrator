import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const SESSION_ID = process.env.ORCHESTRATOR_SESSION_ID;
const SIGNAL_DIR = process.env.ORCHESTRATOR_SIGNAL_DIR || "/tmp/orchestrator-signals";

if (!SESSION_ID) {
  console.error("ORCHESTRATOR_SESSION_ID env var is required");
  process.exit(1);
}

// Ensure signal directory exists
mkdirSync(SIGNAL_DIR, { recursive: true });

const server = new McpServer({
  name: "orchestrator",
  version: "1.0.0",
});

server.tool(
  "switch_workspace",
  "Signal the orchestrator app to create a new session in a different directory (e.g. after creating a git worktree). The orchestrator will open a new Claude session in that directory automatically.",
  {
    directory: z.string().describe("Absolute path to the directory to open a new session in"),
    session_name: z.string().optional().describe("Optional name for the new session"),
  },
  async ({ directory, session_name }) => {
    // Validate directory exists
    if (!existsSync(directory)) {
      return {
        content: [{ type: "text", text: `Error: directory does not exist: ${directory}` }],
        isError: true,
      };
    }
    const stat = statSync(directory);
    if (!stat.isDirectory()) {
      return {
        content: [{ type: "text", text: `Error: path is not a directory: ${directory}` }],
        isError: true,
      };
    }

    const signal = {
      action: "switch_workspace",
      directory,
      sessionName: session_name || undefined,
      sessionId: SESSION_ID,
      timestamp: Date.now(),
    };

    const signalPath = join(SIGNAL_DIR, `${SESSION_ID}.json`);
    writeFileSync(signalPath, JSON.stringify(signal), "utf-8");

    return {
      content: [{
        type: "text",
        text: `Signaled orchestrator to update workspace to ${directory}. IMPORTANT: You must now change your working directory by running: cd ${directory}`,
      }],
    };
  }
);

server.tool(
  "checkout_pr_worktree",
  "Create a git worktree for a PR branch and switch to it. Fetches the branch from origin, creates a worktree in .worktrees/pr-<number>, clones dependency directories (node_modules, .venv, etc.), and signals the orchestrator to switch workspace. Use this when you need to work on a PR's code in an isolated worktree.",
  {
    directory: z.string().describe("Absolute path to the git repository root"),
    pr_number: z.number().describe("The PR number"),
    branch: z.string().describe("The PR's head branch name (e.g. 'feature/foo')"),
  },
  async ({ directory, pr_number, branch }) => {
    if (!existsSync(directory)) {
      return {
        content: [{ type: "text", text: `Error: directory does not exist: ${directory}` }],
        isError: true,
      };
    }

    const worktreeName = `pr-${pr_number}`;
    const worktreePath = resolve(directory, ".worktrees", worktreeName);

    // If the worktree already exists, just switch to it
    if (existsSync(worktreePath)) {
      const signal = {
        action: "switch_workspace",
        directory: worktreePath,
        sessionId: SESSION_ID,
        timestamp: Date.now(),
      };
      writeFileSync(join(SIGNAL_DIR, `${SESSION_ID}.json`), JSON.stringify(signal), "utf-8");

      return {
        content: [{
          type: "text",
          text: `Worktree already exists at ${worktreePath}. Signaled orchestrator to switch. IMPORTANT: You must now run: cd ${worktreePath}`,
        }],
      };
    }

    try {
      // Ensure .worktrees directory exists
      mkdirSync(join(directory, ".worktrees"), { recursive: true });

      // Fetch the branch from origin
      execFileSync("git", ["fetch", "origin", branch], { cwd: directory, stdio: "pipe" });

      // Create the worktree tracking the remote branch
      execFileSync("git", ["worktree", "add", worktreePath, `origin/${branch}`], {
        cwd: directory,
        stdio: "pipe",
      });

      // Clone heavy dependency directories (node_modules, .venv, etc.) via APFS cp -Rc
      const depDirs = ["node_modules", ".venv", "venv", "vendor"];
      const cloneDeps = (srcBase, dstBase, rel) => {
        for (const name of depDirs) {
          const src = join(srcBase, rel, name);
          const dst = join(dstBase, rel, name);
          if (existsSync(src) && statSync(src).isDirectory() && !existsSync(dst)) {
            try {
              mkdirSync(join(dstBase, rel), { recursive: true });
              execFileSync("cp", ["-Rc", src, dst], { stdio: "pipe" });
            } catch {
              // Best-effort
            }
          }
        }
      };
      cloneDeps(directory, worktreePath, ".");

      // Signal the orchestrator to switch workspace
      const signal = {
        action: "switch_workspace",
        directory: worktreePath,
        sessionId: SESSION_ID,
        timestamp: Date.now(),
      };
      writeFileSync(join(SIGNAL_DIR, `${SESSION_ID}.json`), JSON.stringify(signal), "utf-8");

      return {
        content: [{
          type: "text",
          text: `Created worktree at ${worktreePath} on branch origin/${branch}. Signaled orchestrator to switch. IMPORTANT: You must now run: cd ${worktreePath}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error creating worktree: ${err.message}` }],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
