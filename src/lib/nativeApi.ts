/**
 * nativeApi.ts - t3code-compatible API adapter for Claude Orchestrator
 *
 * Exposes a NativeApi-shaped object backed by our Tauri bridge (invoke/listen).
 * Components imported from t3code can call `ensureNativeApi().orchestration.*`
 * etc. and they will be wired to our Rust backend.
 */

import { invoke, listen } from "./bridge";
import type { Session } from "../types";

// ── Types ───────────────────────────────────────────────────────────────

export interface NativeTerminalSession {
  id: string;
}

export interface NativeApi {
  terminal: {
    open: (sessionId: string, cwd: string) => Promise<NativeTerminalSession>;
    write: (id: string, data: string) => Promise<void>;
    resize: (id: string, cols: number, rows: number) => Promise<void>;
    close: (id: string) => Promise<void>;
    onData: (id: string, cb: (data: string) => void) => () => void;
  };
  git: {
    getBranches: (cwd: string) => Promise<string[]>;
    getCurrentBranch: (cwd: string) => Promise<string | null>;
    getWorktrees: (cwd: string) => Promise<Array<{ path: string; branch: string; isMain: boolean }>>;
    createWorktree: (cwd: string, branch: string, path: string) => Promise<void>;
    removeWorktree: (cwd: string, path: string) => Promise<void>;
    getStatus: (cwd: string) => Promise<unknown>;
  };
  projects: {
    searchFiles: (query: string, cwd: string) => Promise<string[]>;
    openFolder: () => Promise<string | null>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
  shell: {
    openInEditor: (path: string, editor?: string) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  orchestration: {
    getSessions: () => Promise<Session[]>;
    sendMessage: (sessionId: string, text: string, images?: unknown[]) => Promise<void>;
    createSession: (opts: {
      directory: string;
      provider: string;
      model?: string;
      prompt?: string;
    }) => Promise<{ sessionId: string }>;
    stopSession: (sessionId: string) => Promise<void>;
    onMessage: (cb: (event: { sessionId: string; data: unknown }) => void) => () => void;
  };
}

// ── Implementation ──────────────────────────────────────────────────────

let cachedApi: NativeApi | undefined;

function createNativeApi(): NativeApi {
  return {
    terminal: {
      open: async (sessionId, cwd) => {
        const id = await invoke<string>("start_pty", { sessionId, cwd });
        return { id };
      },
      write: (id, data) => invoke("write_to_pty", { id, data }),
      resize: (id, cols, rows) => invoke("resize_pty", { id, cols, rows }),
      close: (id) => invoke("close_pty", { id }),
      onData: (id, cb) => {
        let unlisten: (() => void) | undefined;
        listen(`pty:data:${id}`, (event: { payload: string }) => {
          cb(event.payload);
        }).then((fn) => {
          unlisten = fn;
        });
        return () => unlisten?.();
      },
    },

    git: {
      getBranches: (cwd) => invoke("get_branches", { directory: cwd }),
      getCurrentBranch: (cwd) => invoke("get_current_branch", { directory: cwd }),
      getWorktrees: (cwd) => invoke("get_worktrees", { directory: cwd }),
      createWorktree: (cwd, branch, path) =>
        invoke("create_worktree", { directory: cwd, branch, path }),
      removeWorktree: (cwd, path) => invoke("remove_worktree", { directory: cwd, path }),
      getStatus: (cwd) => invoke("git_status", { directory: cwd }),
    },

    projects: {
      searchFiles: (query, cwd) => invoke("search_files", { query, dir: cwd }),
      openFolder: async () => {
        try {
          return await invoke<string>("open_folder_dialog", {});
        } catch {
          return null;
        }
      },
      writeFile: (path, content) => invoke("write_file", { path, content }),
    },

    shell: {
      openInEditor: (path, editor) => invoke("open_in_editor", { filePath: path, editor }),
      openExternal: (url) => invoke("open_external", { url }),
    },

    orchestration: {
      getSessions: () => invoke("load_sessions", {}),
      sendMessage: (sessionId, text, images) =>
        invoke("send_message", { sessionId, text, images }),
      createSession: (opts) => invoke("create_session", opts),
      stopSession: (sessionId) => invoke("stop_session", { sessionId }),
      onMessage: (cb) => {
        let unlisten: (() => void) | undefined;
        listen("agent:message", (event: { payload: { sessionId: string; data: unknown } }) => {
          cb(event.payload);
        }).then((fn) => {
          unlisten = fn;
        });
        return () => unlisten?.();
      },
    },
  };
}

export function readNativeApi(): NativeApi {
  if (!cachedApi) cachedApi = createNativeApi();
  return cachedApi;
}

export function ensureNativeApi(): NativeApi {
  return readNativeApi();
}
