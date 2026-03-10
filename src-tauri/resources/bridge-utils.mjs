/**
 * Shared utilities for agent bridge processes.
 *
 * All agent bridges (claude-code, opencode, future providers) share the same
 * stdin/stdout JSON-line protocol. This module extracts the common plumbing so
 * each bridge only needs to implement its SDK-specific runQuery / sendPrompt logic.
 */
import { appendFileSync } from "fs";

// ── Protocol ─────────────────────────────────────────────────────────

/** Write a JSON-line event to stdout (the Rust backend reads these). */
export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// ── Logging ───────────────────────────────────────────────────────────

/**
 * Create a logger for a named bridge.
 * - name=""       → /tmp/agent-bridge-debug.log  (backward-compat for claude bridge)
 * - name="opencode" → /tmp/agent-bridge-opencode-debug.log
 */
export function createLogger(name) {
  const suffix = name ? `-${name}` : "";
  const logFile = `/tmp/agent-bridge${suffix}-debug.log`;
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stderr.write(line);
    try { appendFileSync(logFile, line); } catch {}
  };
}

// ── Stdin reader ──────────────────────────────────────────────────────

/**
 * Set up the shared stdin JSON-line reader.
 * @param {(msg: object) => void} onMessage  Called for each valid JSON line.
 * @param {() => void}            onEnd      Called when stdin closes.
 */
export function startStdinReader(onMessage, onEnd) {
  let buf = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (err) {
        emit({ type: "error", error: `Invalid JSON on stdin: ${err.message}` });
      }
    }
  });
  process.stdin.on("end", onEnd);
}

// ── Bridge state ──────────────────────────────────────────────────────

/**
 * Create the shared mutable state bag.
 * Bridge-specific state (claudeSessionId, ocSessionId, etc.) stays in each bridge.
 */
export function createBridgeState(config) {
  return {
    currentCwd: config.cwd || null,
    currentModel: config.model || null,
    currentReasoningEffort: null,
    currentPermissionMode: config.permissionMode || "bypassPermissions",
  };
}

// ── Common message setters ────────────────────────────────────────────

/**
 * Handle set_cwd / set_model / set_reasoning_effort / set_permission_mode.
 * Returns true if the message was handled, false otherwise.
 */
export function handleCommonSetters(msg, state, log) {
  if (msg.type === "set_cwd") {
    state.currentCwd = msg.cwd;
    log(`cwd updated to: ${state.currentCwd}`);
    emit({ type: "cwd_updated", cwd: state.currentCwd });
    return true;
  }
  if (msg.type === "set_model") {
    state.currentModel = msg.model || null;
    log(`model updated to: ${state.currentModel}`);
    emit({ type: "model_updated", model: state.currentModel });
    return true;
  }
  if (msg.type === "set_reasoning_effort") {
    state.currentReasoningEffort = msg.effort || null;
    log(`reasoning effort updated to: ${state.currentReasoningEffort}`);
    emit({ type: "reasoning_effort_updated", effort: state.currentReasoningEffort });
    return true;
  }
  if (msg.type === "set_permission_mode") {
    state.currentPermissionMode = msg.permissionMode || "bypassPermissions";
    log(`permissionMode updated to: ${state.currentPermissionMode}`);
    emit({ type: "permission_mode_updated", permissionMode: state.currentPermissionMode });
    return true;
  }
  return false;
}

// ── Blocking interaction slots ────────────────────────────────────────

/**
 * Create a blocking slot for promise-based interaction with the frontend.
 * Used for permission prompts and AskUserQuestion intercepts.
 *
 * Usage:
 *   const slot = createBlockingSlot();
 *   // Inside a callback that needs to wait for frontend input:
 *   const answer = await new Promise(resolve => { slot.pending = resolve; });
 *   // From the stdin handler when the answer arrives:
 *   slot.resolve(answer);
 *   // On abort:
 *   slot.cancel(null);  // or cancel(false) for permission slots
 */
export function createBlockingSlot() {
  return {
    /** The resolve function of the currently-pending promise, or null. */
    pending: null,
    /** Resolve the pending promise with value (no-op if nothing pending). */
    resolve(value) {
      if (this.pending) {
        this.pending(value);
        this.pending = null;
      }
    },
    /** Resolve with a fallback value (convenience alias for abort/cancel). */
    cancel(fallback) {
      this.resolve(fallback);
    },
  };
}

// ── Interaction response handlers ─────────────────────────────────────

/**
 * Handle permission_response and ask_user_answer stdin messages.
 * Returns true if handled.
 */
export function handleInteractionResponse(msg, permissionSlot, askUserSlot, log) {
  if (msg.type === "ask_user_answer") {
    if (askUserSlot.pending) {
      log(`Resolving AskUserQuestion with: ${String(msg.answer).substring(0, 100)}`);
      askUserSlot.resolve(msg.answer);
    } else {
      log("ask_user_answer received but no pending askUserResolve — ignoring");
    }
    return true;
  }
  if (msg.type === "permission_response") {
    if (permissionSlot.pending) {
      log(`Resolving permission: ${msg.allowed ? "allow" : "deny"}`);
      permissionSlot.resolve(msg.allowed);
    } else {
      log("permission_response received but no pending permissionResolve — ignoring");
    }
    return true;
  }
  return false;
}

/**
 * Cancel any pending interaction slots (called on abort).
 * Permission slot resolves false (deny), askUser slot resolves null (cancelled).
 */
export function cancelPendingInteractions(permissionSlot, askUserSlot) {
  permissionSlot.cancel(false);
  askUserSlot.cancel(null);
}
