# Claude Orchestrator

A native macOS app for managing multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions in parallel. Built with [Tauri](https://tauri.app/), React, and Rust.

## Features

- **Multiple concurrent sessions** — run several Claude Code (or OpenCode) instances side by side
- **Workspace-centric UI** — sessions are grouped by project directory, with shared shell and PR panels per workspace
- **Git worktree support** — create and switch between worktrees without leaving the app
- **Integrated shell** — multiple shell tabs per workspace with full PTY support
- **Pull request panel** — view and review GitHub PRs inline
- **Built-in file editor** — CodeMirror-based editor with vim keybindings
- **Auto-updates** — new versions are detected and installed automatically
- **MCP server** — exposes workspace management to Claude sessions via Model Context Protocol

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (v18+) and [pnpm](https://pnpm.io/)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`)

## Getting Started

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev
```

## Building

```bash
# Build the app (unsigned, local install)
./build.sh

# Build and publish a signed release to GitHub
RELEASE=1 ./build.sh
```

See the [build script](./build.sh) for signing and notarization setup.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+N` | New session |
| `Cmd+J` | Switch to Claude chat |
| `Cmd+P` | Toggle PR panel |
| `Cmd+T` | Toggle shell |
| `Cmd+E` | Open in external editor |
| `Cmd+K` | Command palette |
| `Cmd+Shift+C` | Commit |

## License

[MIT](./LICENSE)
