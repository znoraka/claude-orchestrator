import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

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

const transport = new StdioServerTransport();
await server.connect(transport);
