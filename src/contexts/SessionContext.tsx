import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { v4 as uuidv4 } from "uuid";
import { useConversationTitles } from "../hooks/useConversationTitles";
import { useSessionUsage } from "../hooks/useSessionUsage";
import { useBackgroundNotifications } from "../hooks/useBackgroundNotifications";
import { useToast } from "../components/Toast";
import { jsonlDirectory, type AgentProvider, type Session, type SessionUsage, type Workspace } from "../types";
import { deriveWorkspaces, workspaceForSession, normalizeDir, repoRootDir } from "../utils/workspaces";
import { getYoungestDescendant, getRootSession } from "../utils/sessionLineage";

const MAX_RUNNING_SESSIONS = 8;

// ── Reducer ──────────────────────────────────────────────────────────

type SessionAction =
  | { type: "SET_ALL"; sessions: Session[] }
  | { type: "ADD"; session: Session }
  | { type: "REMOVE"; id: string }
  | { type: "UPDATE"; id: string; patch: Partial<Session> }
  | { type: "MARK_STOPPED"; ids: string[] }
  | { type: "TICK_ACTIVE_TIMES"; updates: Array<{ id: string; activeTime: number }> };

function sessionReducer(state: Session[], action: SessionAction): Session[] {
  switch (action.type) {
    case "SET_ALL":
      return action.sessions;
    case "ADD":
      return [...state, action.session];
    case "REMOVE":
      return state.filter((s) => s.id !== action.id);
    case "UPDATE":
      return state.map((s) =>
        s.id === action.id ? { ...s, ...action.patch } : s
      );
    case "MARK_STOPPED":
      return state.map((s) =>
        action.ids.includes(s.id) ? { ...s, status: "stopped" as const, exitCode: 0 } : s
      );
    case "TICK_ACTIVE_TIMES": {
      const map = new Map(action.updates.map((u) => [u.id, u.activeTime]));
      return state.map((s) => {
        const at = map.get(s.id);
        return at !== undefined ? { ...s, activeTime: at } : s;
      });
    }
    default:
      return state;
  }
}

// ── Context shape ────────────────────────────────────────────────────

interface SessionContextValue {
  sessions: Session[];
  sortedSessions: Session[];
  workspaces: Workspace[];
  activeSessionId: string | null;
  effectiveSessionId: string | null;
  activeWorkspaceId: string | null;
  activeWorktreePath: string | null;
  youngestDescendantMap: Map<string, Session>;
  sessionUsage: Map<string, SessionUsage>;
  todayCost: number;
  todayTokens: number;

  selectSession: (id: string) => void;
  selectWorkspace: (workspaceId: string) => void;
  selectWorktree: (worktreePath: string) => void;
  createSession: (
    name: string | undefined,
    directory: string,
    dangerouslySkipPermissions?: boolean,
    extraSystemPrompt?: string,
    pendingPrompt?: string,
    provider?: AgentProvider,
    model?: string,
    permissionMode?: "bypassPermissions" | "plan",
    planContent?: string,
    parentSessionId?: string
  ) => Promise<string>;
  createWorktree: (repoDir: string, branchName: string, worktreeName?: string) => Promise<string>;
  removeWorktree: (path: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => void;
  markTitleGenerated: (id: string) => void;
  clearPendingPrompt: (id: string) => void;
  markStopped: (id: string, exitCode?: number) => void;
  restartSession: (id: string) => Promise<void>;
  touchSession: (id: string) => void;
  updateClaudeSessionId: (id: string, claudeSessionId: string) => void;
  setAgentBusy: (sessionId: string, isBusy: boolean) => void;
  setAgentUsage: (sessionId: string, usage: SessionUsage) => void;
  setSessionDraft: (sessionId: string, hasDraft: boolean) => void;
  setSessionQuestion: (sessionId: string, hasQuestion: boolean) => void;
  updatePermissionMode: (sessionId: string, mode: "bypassPermissions" | "plan") => void;
  unreadSessions: Set<string>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSessionContext(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSessionContext must be used within SessionProvider");
  return ctx;
}

// ── Provider ─────────────────────────────────────────────────────────

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessions, dispatch] = useReducer(sessionReducer, []);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Remembers last-focused session per workspace (directory)
  const activeSessionInWorkspace = useRef<Map<string, string>>(new Map());
  const loadedRef = useRef(false);
  const { showError, showInfo } = useToast();

  // ── Load persisted sessions on mount ─────────────────────────────
  useEffect(() => {
    invoke<
      Array<{
        id: string;
        name: string;
        createdAt: number;
        lastActiveAt: number;
        directory: string;
        provider?: string;
        model?: string;
        homeDirectory?: string;
        claudeSessionId?: string;
        dangerouslySkipPermissions?: boolean;
        permissionMode?: string;
        activeTime?: number;
        hasTitleBeenGenerated?: boolean;
        planContent?: string;
        parentSessionId?: string;
      }>
    >("load_sessions")
      .then((saved) => {
        if (saved.length > 0) {
          const restored: Session[] = saved.map((s) => ({
            id: s.id,
            name: s.name,
            status: "stopped" as const,
            createdAt: s.createdAt,
            lastActiveAt: s.lastActiveAt,
            directory: normalizeDir(s.directory),
            provider: (s.provider as Session["provider"]) || "claude-code",
            model: s.model,
            homeDirectory: s.homeDirectory ? normalizeDir(s.homeDirectory) : undefined,
            claudeSessionId: s.claudeSessionId,
            dangerouslySkipPermissions: s.dangerouslySkipPermissions,
            permissionMode: s.permissionMode as Session["permissionMode"],
            activeTime: s.activeTime || 0,
            hasTitleBeenGenerated: s.hasTitleBeenGenerated,
            planContent: s.planContent,
            parentSessionId: s.parentSessionId,
          }));
          dispatch({ type: "SET_ALL", sessions: restored });
        }
        loadedRef.current = true;
      })
      .catch((err) => {
        console.error("Failed to load sessions:", err);
        showError(`Failed to load sessions: ${err}`);
        loadedRef.current = true;
      });
  }, []);

  // ── Session refs (needed early for save functions) ─────────────────
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // ── Helper to build session metadata for saving ───────────────────
  const buildSessionMetas = useCallback(() => {
    return sessionsRef.current.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      directory: s.directory,
      provider: s.provider || "claude-code",
      model: s.model,
      homeDirectory: s.homeDirectory,
      claudeSessionId: s.claudeSessionId,
      dangerouslySkipPermissions: s.dangerouslySkipPermissions,
      permissionMode: s.permissionMode,
      activeTime: s.activeTime || 0,
      hasTitleBeenGenerated: s.hasTitleBeenGenerated,
      planContent: s.planContent,
      parentSessionId: s.parentSessionId,
    }));
  }, []);

  // ── Immediate save for critical operations (create, delete) ───────
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTimeSaveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const saveSessionsImmediately = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    try {
      await invoke("save_sessions", { sessions: buildSessionMetas() });
    } catch (err) {
      console.error("Failed to save sessions:", err);
    }
  }, [buildSessionMetas]);

  // ── Persist sessions on every change (debounced, after initial load) ─
  // Use a stable key that excludes volatile fields (activeTime) to avoid
  // re-saving every 60s when TICK_ACTIVE_TIMES fires.
  const saveKey = useMemo(
    () =>
      sessions
        .map((s) => `${s.id}:${s.name}:${s.directory}:${s.provider}:${s.model}:${s.homeDirectory}:${s.claudeSessionId}:${s.status}:${s.lastActiveAt}:${s.dangerouslySkipPermissions}:${s.hasTitleBeenGenerated}:${s.permissionMode}:${s.parentSessionId}`)
        .join("|"),
    [sessions]
  );
  useEffect(() => {
    if (!loadedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      invoke("save_sessions", { sessions: buildSessionMetas() }).catch((err) => {
        console.error("Failed to save sessions:", err);
        showError(`Failed to save sessions: ${err}`);
      });
    }, 2000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveKey]);

  // Save activeTime periodically (every 5 min) to avoid losing it,
  // but not on every tick
  useEffect(() => {
    if (activeTimeSaveRef.current) clearInterval(activeTimeSaveRef.current);
    activeTimeSaveRef.current = setInterval(() => {
      if (!loadedRef.current) return;
      invoke("save_sessions", { sessions: buildSessionMetas() }).catch(() => {});
    }, 300_000);
    return () => {
      if (activeTimeSaveRef.current) clearInterval(activeTimeSaveRef.current);
    };
  }, [buildSessionMetas]);

  // ── Flush pending saves before app close ──────────────────────────
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async () => {
      await saveSessionsImmediately();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [saveSessionsImmediately]);

  const enforceMaxSessions = useCallback(async (excludeId?: string) => {
    const current = sessionsRef.current;
    const running = current
      .filter((s) => s.status === "running" && s.id !== excludeId)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);

    const totalRunning = running.length + (excludeId ? 1 : 0);
    if (totalRunning <= MAX_RUNNING_SESSIONS) return;

    const toKill = running.slice(0, totalRunning - MAX_RUNNING_SESSIONS);
    for (const session of toKill) {
      try {
        await invoke("destroy_agent_session", { sessionId: session.id });
      } catch (err) {
        console.error(`Failed to kill excess session ${session.id}:`, err);
      }
    }

    dispatch({ type: "MARK_STOPPED", ids: toKill.map((s) => s.id) });
  }, []);

  // ── Actions ──────────────────────────────────────────────────────

  const selectSession = useCallback((id: string) => {
    // Always resolve to the root ancestor so sidebar highlighting stays consistent
    const root = getRootSession(id, sessionsRef.current);
    const rootId = root.id;
    setActiveSessionId(rootId);
    const target = sessionsRef.current.find((s) => s.id === rootId);
    if (target) {
      activeSessionInWorkspace.current.set(target.directory || "~", rootId);
      const wsId = repoRootDir(target.directory || "~");
      activeSessionInWorkspace.current.set(wsId, rootId);
    }
  }, []);

  const selectWorkspace = useCallback((workspaceId: string) => {
    const lastSession = activeSessionInWorkspace.current.get(workspaceId);
    const current = sessionsRef.current;
    // Restore last session in workspace, or pick the most recent one
    if (lastSession && current.some((s) => s.id === lastSession)) {
      setActiveSessionId(lastSession);
    } else {
      const wsSessions = current
        .filter((s) => repoRootDir(s.directory || "~") === workspaceId)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      if (wsSessions.length > 0) {
        setActiveSessionId(wsSessions[0].id);
        activeSessionInWorkspace.current.set(workspaceId, wsSessions[0].id);
      }
    }
  }, []);

  const selectWorktree = useCallback((worktreePath: string) => {
    const lastSession = activeSessionInWorkspace.current.get(worktreePath);
    const current = sessionsRef.current;
    if (lastSession && current.some((s) => s.id === lastSession)) {
      setActiveSessionId(lastSession);
    } else {
      const wtSessions = current
        .filter((s) => (s.directory || "~") === worktreePath)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      if (wtSessions.length > 0) {
        setActiveSessionId(wtSessions[0].id);
        activeSessionInWorkspace.current.set(worktreePath, wtSessions[0].id);
      }
    }
  }, []);

  const createSession = useCallback(
    async (
      name: string | undefined,
      directory: string,
      dangerouslySkipPermissions = false,
      extraSystemPrompt?: string,
      pendingPrompt?: string,
      provider: AgentProvider = "claude-code",
      model?: string,
      permissionMode?: "bypassPermissions" | "plan",
      planContent?: string,
      parentSessionId?: string
    ) => {
      const dir = normalizeDir(directory);
      const id = uuidv4();
      const claudeSessionId = uuidv4();
      const now = Date.now();
      const sessionCount = sessionsRef.current.length;
      const session: Session = {
        id,
        name: name || `Session ${sessionCount + 1}`,
        status: "starting",
        createdAt: now,
        lastActiveAt: now,
        directory: dir,
        provider,
        model: model || undefined,
        claudeSessionId,
        dangerouslySkipPermissions,
        permissionMode,
        pendingPrompt,
        planContent,
        parentSessionId,
      };

      dispatch({ type: "ADD", session });
      // If this is a child session, keep activeSessionId pointing to the root parent
      // so sidebar highlighting stays consistent. effectiveSessionId will resolve to the child.
      if (parentSessionId) {
        const root = getRootSession(parentSessionId, sessionsRef.current);
        setActiveSessionId(root.id);
      } else {
        setActiveSessionId(id);
      }

      // Save immediately after adding to ensure session is persisted
      // Use setTimeout(0) to ensure dispatch has updated sessionsRef
      setTimeout(() => saveSessionsImmediately(), 0);

      try {
        await invoke("create_agent_session", {
          sessionId: id,
          directory: dir,
          claudeSessionId,
          resume: false,
          systemPrompt: extraSystemPrompt || null,
          provider,
          model: model || null,
          permissionMode: permissionMode || null,
        });
        dispatch({ type: "UPDATE", id, patch: { status: "running" } });
        await enforceMaxSessions(id);
      } catch (err) {
        console.error("Failed to create session:", err);
        showError(`Failed to create session: ${err}`);
        dispatch({ type: "UPDATE", id, patch: { status: "stopped" } });
      }

      return id;
    },
    [enforceMaxSessions, showError, saveSessionsImmediately]
  );

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await invoke("destroy_agent_session", { sessionId: id });
      } catch (err) {
        console.error("Failed to destroy session:", err);
      }

      dispatch({ type: "REMOVE", id });

      setActiveSessionId((prev) => {
        if (prev !== id) return prev;
        const remaining = sessionsRef.current
          .filter((s) => s.id !== id)
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
        return remaining.length > 0 ? remaining[0].id : null;
      });

      // Save immediately after removal to ensure deletion is persisted
      // Use setTimeout(0) to ensure dispatch has updated sessionsRef
      setTimeout(() => saveSessionsImmediately(), 0);
    },
    [saveSessionsImmediately]
  );

  const renameSession = useCallback((id: string, name: string) => {
    dispatch({ type: "UPDATE", id, patch: { name } });
  }, []);

  const markTitleGenerated = useCallback((id: string) => {
    dispatch({ type: "UPDATE", id, patch: { hasTitleBeenGenerated: true } });
  }, []);

  const clearPendingPrompt = useCallback((id: string) => {
    dispatch({ type: "UPDATE", id, patch: { pendingPrompt: undefined } });
  }, []);

  const markStopped = useCallback((id: string, exitCode?: number) => {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (session?.status === "stopped") return; // already stopped (e.g. by enforceMaxSessions)
    dispatch({ type: "UPDATE", id, patch: { status: "stopped", exitCode } });
  }, []);

  const restartSession = useCallback(
    async (id: string) => {
      const session = sessionsRef.current.find((s) => s.id === id);
      if (!session) {
        console.error(`[SessionContext] Session ${id} not found`);
        return;
      }

      // If no claudeSessionId exists (e.g. cleared after worktree deletion),
      // generate a fresh one so this new session can be resumed later.
      const claudeSessionId = session.claudeSessionId ?? uuidv4();
      const isResume = !!session.claudeSessionId;

      dispatch({
        type: "UPDATE",
        id,
        patch: {
          status: "starting",
          lastActiveAt: Date.now(),
          exitCode: undefined,
          ...(!session.claudeSessionId ? { claudeSessionId } : {}),
        },
      });
      setActiveSessionId(id);

      // When resuming a worktree session, use the original (home) directory
      // so Claude CLI can find the JSONL in the correct project folder.
      const spawnDir = isResume ? jsonlDirectory(session) : session.directory;

      try {
        await invoke("create_agent_session", {
          sessionId: id,
          directory: spawnDir,
          claudeSessionId,
          resume: isResume,
          systemPrompt: null,
          provider: session.provider || "claude-code",
          model: session.model || null,
          permissionMode: session.permissionMode || null,
        });
        dispatch({ type: "UPDATE", id, patch: { status: "running" } });
        await enforceMaxSessions(id);
      } catch (err) {
        console.error("Failed to restart session:", err);
        showError(`Failed to restart session: ${err}`);
        dispatch({ type: "UPDATE", id, patch: { status: "stopped" } });
      }
    },
    [enforceMaxSessions, showError]
  );

  const touchSession = useCallback((id: string) => {
    dispatch({ type: "UPDATE", id, patch: { lastActiveAt: Date.now() } });
  }, []);

  const updateClaudeSessionId = useCallback((id: string, claudeSessionId: string) => {
    dispatch({ type: "UPDATE", id, patch: { claudeSessionId } });
  }, []);

  const createWorktree = useCallback(
    async (repoDir: string, branchName: string, wtName?: string) => {
      const path = await invoke<string>("create_worktree", {
        directory: repoDir,
        branchName,
        worktreeName: wtName,
      });
      return path;
    },
    []
  );

  const removeWorktree = useCallback(
    async (path: string) => {
      await invoke("remove_worktree", { path });
    },
    []
  );

  // ── Duration tracking ──────────────────────────────────────────
  const runningSinceRef = useRef<Map<string, number>>(new Map());

  // Track running status changes (only re-run when the running set changes)
  const runningStatusKey = useMemo(
    () => sessions.map((s) => `${s.id}:${s.status}`).join(","),
    [sessions]
  );
  useEffect(() => {
    for (const s of sessionsRef.current) {
      if (s.status === "running" && !runningSinceRef.current.has(s.id)) {
        runningSinceRef.current.set(s.id, Date.now());
      } else if (s.status !== "running") {
        runningSinceRef.current.delete(s.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningStatusKey]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const running = sessionsRef.current.filter((s) => s.status === "running");
      if (running.length === 0) return;

      const updates: Array<{ id: string; activeTime: number }> = [];
      for (const s of running) {
        const since = runningSinceRef.current.get(s.id);
        if (!since) continue;
        const elapsed = now - since;
        runningSinceRef.current.set(s.id, now);
        updates.push({ id: s.id, activeTime: (s.activeTime || 0) + elapsed });
      }
      if (updates.length > 0) {
        dispatch({ type: "TICK_ACTIVE_TIMES", updates });
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // ── Orchestrator signal handler (MCP → new workspace) ───────────

  useEffect(() => {
    const unlistenPromise = listen<{
      action: string;
      directory: string;
      sessionName?: string;
      sessionId: string;
    }>("orchestrator-signal", async (event) => {
      const { action, directory: rawDir, sessionName, sessionId: fromSessionId } = event.payload;
      if (action !== "switch_workspace") return;
      const directory = normalizeDir(rawDir);

      const allIds = sessionsRef.current.map((s) => s.id);
      console.log(
        `[orchestrator-signal] switch_workspace to ${directory} (from session ${fromSessionId})`,
        `\n  known sessions: [${allIds.join(", ")}]`
      );

      // Update the existing session's directory (moves it to the new workspace)
      const session = sessionsRef.current.find((s) => s.id === fromSessionId);
      if (!session) {
        console.warn(
          `[orchestrator-signal] session ${fromSessionId} not found in`,
          allIds
        );
        showError(`switch_workspace: session ${fromSessionId.slice(0, 8)} not found`);
        return;
      }

      console.log(
        `[orchestrator-signal] updating session "${session.name}" directory: ${session.directory} → ${directory}`
      );
      showInfo(`Switched "${session.name}" → ${directory.split("/").pop()}`);

      // Update the agent bridge's working directory so future queries use the new cwd
      invoke("set_agent_cwd", { sessionId: fromSessionId, cwd: directory }).catch((err: unknown) =>
        console.warn(`[orchestrator-signal] set_agent_cwd failed:`, err)
      );

      // When switching into a worktree, remember the original directory so we
      // can restore it if the worktree is later deleted.
      const isWorktree = directory.includes("/.worktrees/");
      const homeDirectory = isWorktree
        ? session.homeDirectory ?? session.directory
        : undefined;

      dispatch({
        type: "UPDATE",
        id: fromSessionId,
        patch: {
          directory,
          homeDirectory,
          ...(sessionName ? { name: sessionName } : {}),
        },
      });

      // Update the workspace→session mapping with the NEW directory
      activeSessionInWorkspace.current.set(directory, fromSessionId);
      // Clean up old workspace mapping if this was the last session there
      const oldWsId = session.directory || "~";
      if (oldWsId !== directory) {
        const otherInOldWs = sessionsRef.current.some(
          (s) => s.id !== fromSessionId && (s.directory || "~") === oldWsId
        );
        if (!otherInOldWs) activeSessionInWorkspace.current.delete(oldWsId);
      }

      setActiveSessionId(fromSessionId);
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  // ── Auto-revert sessions whose worktree directory was removed ────
  useEffect(() => {
    const check = async () => {
      const current = sessionsRef.current;
      const worktreeSessions = current.filter((s) => s.directory?.includes("/.worktrees/"));
      if (worktreeSessions.length === 0) return;
      await Promise.all(
        worktreeSessions.map(async (s) => {
          try {
            const exists = await invoke<boolean>("directory_exists", { path: s.directory });
            if (!exists) {
              const root = s.homeDirectory ?? repoRootDir(s.directory);
              console.log(
                `[worktree-cleanup] "${s.name}" worktree removed, reverting directory: ${s.directory} → ${root}`
              );
              dispatch({ type: "UPDATE", id: s.id, patch: { directory: root, homeDirectory: undefined } });
            }
          } catch (err) {
            console.error("[worktree-cleanup] Failed to check directory:", err);
          }
        })
      );
    };
    check();
    const interval = setInterval(check, 15_000);
    return () => clearInterval(interval);
  }, []); // stable — reads from sessionsRef

  // ── Derived state / side-effect hooks ────────────────────────────

  useConversationTitles(sessions, renameSession, markTitleGenerated);
  const jsonlUsage = useSessionUsage(sessions);

  // ── Agent busy state (for SDK-based sessions) ─────────────────────
  const [agentBusyMap, setAgentBusyMap] = useState<Map<string, boolean>>(new Map());
  const setAgentBusy = useCallback((sessionId: string, isBusy: boolean) => {
    setAgentBusyMap((prev) => {
      if (isBusy) {
        if (prev.get(sessionId) === true) return prev; // no change
        const next = new Map(prev);
        next.set(sessionId, true);
        return next;
      } else {
        if (!prev.has(sessionId)) return prev; // no change
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      }
    });
  }, []);

  // ── Agent usage state (for bridge-based sessions without JSONL) ───
  const [agentUsageMap, setAgentUsageMap] = useState<Map<string, SessionUsage>>(new Map());
  const setAgentUsage = useCallback((sessionId: string, usage: SessionUsage) => {
    setAgentUsageMap((prev) => {
      const next = new Map(prev);
      next.set(sessionId, usage);
      return next;
    });
  }, []);

  // ── Draft state (user has typed but not sent) ───────────────────
  const setSessionDraft = useCallback((sessionId: string, hasDraft: boolean) => {
    dispatch({ type: "UPDATE", id: sessionId, patch: { hasDraft } });
  }, []);

  const setSessionQuestion = useCallback((sessionId: string, hasQuestion: boolean) => {
    dispatch({ type: "UPDATE", id: sessionId, patch: { hasQuestion } });
  }, []);

  const updatePermissionMode = useCallback((sessionId: string, mode: "bypassPermissions" | "plan") => {
    dispatch({ type: "UPDATE", id: sessionId, patch: { permissionMode: mode } });
  }, []);

  // Merge JSONL usage with agent busy state and agent-reported usage
  const sessionUsage = useMemo(() => {
    const merged = new Map<string, SessionUsage>();
    // Copy all JSONL usage entries
    for (const [id, usage] of jsonlUsage) {
      merged.set(id, usage);
    }
    // Apply agent-reported usage (for bridge-based sessions without JSONL)
    for (const [id, usage] of agentUsageMap) {
      const existing = merged.get(id);
      if (!existing || existing.inputTokens === 0) {
        merged.set(id, usage);
      }
    }
    // Override isBusy for agent-based sessions
    for (const [id, isBusy] of agentBusyMap) {
      const existing = merged.get(id);
      if (existing) {
        merged.set(id, { ...existing, isBusy });
      } else {
        merged.set(id, {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          costUsd: 0,
          contextTokens: 0,
          isBusy,
        });
      }
    }
    // Propagate child busy state to parent: if any child is busy, parent appears busy too
    for (const s of sessions) {
      if (!s.parentSessionId) continue;
      const childUsage = merged.get(s.id);
      if (childUsage?.isBusy || s.status === "running" || s.status === "starting") {
        const parentUsage = merged.get(s.parentSessionId);
        if (parentUsage && !parentUsage.isBusy) {
          merged.set(s.parentSessionId, { ...parentUsage, isBusy: true });
        } else if (!parentUsage) {
          merged.set(s.parentSessionId, {
            inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0, costUsd: 0, contextTokens: 0, isBusy: true,
          });
        }
      }
    }
    return merged;
  }, [jsonlUsage, agentBusyMap, agentUsageMap]);

  useBackgroundNotifications(sessions, sessionUsage, activeSessionId);

  // ── Unread badge: tracks sessions that finished computing while not active ──
  const [unreadSessions, setUnreadSessions] = useState<Set<string>>(new Set());
  const prevBusyForUnreadRef = useRef<Map<string, boolean>>(new Map());
  const prevActiveSessionIdRef = useRef<string | null>(null);
  // Tracks sessions the user has viewed while awaiting input, so they don't re-badge
  const dismissedAwaitingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const session of sessions) {
      const usage = sessionUsage.get(session.id);
      const wasBusy = prevBusyForUnreadRef.current.get(session.id) ?? false;
      const isBusy = usage?.isBusy ?? false;
      const wasActive = prevActiveSessionIdRef.current === session.id;

      // busy → idle on a non-active session → mark unread
      // For child sessions, mark the parent as unread instead
      if (wasBusy && !isBusy && !wasActive) {
        const targetId = session.parentSessionId && sessionsRef.current.some(s => s.id === session.parentSessionId)
          ? session.parentSessionId
          : session.id;
        const isTargetActive = prevActiveSessionIdRef.current === targetId;
        if (!isTargetActive) {
          setUnreadSessions((prev) => {
            if (prev.has(targetId)) return prev;
            const next = new Set(prev);
            next.add(targetId);
            return next;
          });
        }
      }

      // When a session becomes busy again, reset its dismissed state
      // so it can re-badge when it finishes the new work
      if (isBusy && !wasBusy) {
        dismissedAwaitingRef.current.delete(session.id);
      }

      prevBusyForUnreadRef.current.set(session.id, isBusy);
    }
    prevActiveSessionIdRef.current = activeSessionId;
  }, [sessions, sessionUsage, activeSessionId]);

  // Clear unread when session becomes active, and dismiss awaiting-input badge
  useEffect(() => {
    if (activeSessionId) {
      setUnreadSessions((prev) => {
        if (!prev.has(activeSessionId)) return prev;
        const next = new Set(prev);
        next.delete(activeSessionId);
        return next;
      });
      // Mark as dismissed so it won't re-badge as "awaiting input"
      dismissedAwaitingRef.current.add(activeSessionId);
    }
  }, [activeSessionId]);

  // Prune unread set: remove IDs for sessions that no longer exist
  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.id));
    setUnreadSessions((prev) => {
      let changed = false;
      for (const id of prev) {
        if (!currentIds.has(id)) { changed = true; break; }
      }
      if (!changed) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        if (currentIds.has(id)) next.add(id);
      }
      return next;
    });
  }, [sessions]);

  // ── Dock badge: show count of sessions needing attention ─────────
  useEffect(() => {
    let count = unreadSessions.size;
    // Also count running sessions with a pending AskUserQuestion
    for (const session of sessions) {
      if (session.id === activeSessionId) continue;
      if (!session.hasQuestion) continue;
      if (session.status !== "running" && session.status !== "starting") continue;
      if (unreadSessions.has(session.id)) continue; // already counted
      if (dismissedAwaitingRef.current.has(session.id)) continue;
      count++;
    }
    invoke("set_dock_badge", { label: count > 0 ? String(count) : null }).catch(() => {});
  }, [sessions, sessionUsage, unreadSessions, activeSessionId]);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    [sessions]
  );

  // Map each root session to its youngest descendant
  const youngestDescendantMap = useMemo(() => {
    const map = new Map<string, Session>();
    const roots = sessions.filter((s) => !s.parentSessionId);
    for (const root of roots) {
      const youngest = getYoungestDescendant(root.id, sessions);
      if (youngest.id !== root.id) {
        map.set(root.id, youngest);
      }
    }
    return map;
  }, [sessions]);

  // The effective session to display: youngest descendant of activeSessionId
  const effectiveSessionId = useMemo(() => {
    if (!activeSessionId) return null;
    const youngest = getYoungestDescendant(activeSessionId, sessions);
    return youngest.id;
  }, [activeSessionId, sessions]);

  const workspaces = useMemo(() => deriveWorkspaces(sessions), [sessions]);

  const activeWorkspaceId = useMemo(
    () => activeSessionId ? workspaceForSession(activeSessionId, sessions) : null,
    [activeSessionId, sessions]
  );

  const activeWorktreePath = useMemo(() => {
    if (!activeSessionId) return null;
    const session = sessions.find((s) => s.id === activeSessionId);
    return session?.directory ?? null;
  }, [activeSessionId, sessions]);

  // Today's usage — refreshed on JSONL file changes + a slow fallback interval
  const [todayCost, setTodayCost] = useState(0);
  const [todayTokens, setTodayTokens] = useState(0);
  useEffect(() => {
    const fetchUsage = () => {
      invoke<{ costUsd: number; totalTokens: number }>("get_total_usage_today")
        .then((u) => { setTodayCost(u.costUsd); setTodayTokens(u.totalTokens); })
        .catch(() => {});
    };
    fetchUsage();
    // Refresh on any JSONL change event
    const unlistenPromise = listen<string>("jsonl-changed", () => {
      fetchUsage();
    });
    // Slow fallback for sessions managed outside this app
    const interval = setInterval(fetchUsage, 120_000);
    return () => {
      unlistenPromise.then((fn) => fn());
      clearInterval(interval);
    };
  }, []);

  // ── Context value (stable reference via useMemo) ─────────────────

  const value = useMemo<SessionContextValue>(
    () => ({
      sessions,
      sortedSessions,
      workspaces,
      activeSessionId,
      effectiveSessionId,
      activeWorkspaceId,
      activeWorktreePath,
      youngestDescendantMap,
      sessionUsage,
      todayCost,
      todayTokens,
      selectSession,
      selectWorkspace,
      selectWorktree,
      createSession,
      createWorktree,
      removeWorktree,
      deleteSession,
      renameSession,
      markTitleGenerated,
      clearPendingPrompt,
      markStopped,
      restartSession,
      touchSession,
      updateClaudeSessionId,
      setAgentBusy,
      setAgentUsage,
      setSessionDraft,
      setSessionQuestion,
      updatePermissionMode,
      unreadSessions,
    }),
    [
      sessions,
      sortedSessions,
      workspaces,
      activeSessionId,
      effectiveSessionId,
      activeWorkspaceId,
      activeWorktreePath,
      youngestDescendantMap,
      sessionUsage,
      todayCost,
      todayTokens,
      selectSession,
      selectWorkspace,
      selectWorktree,
      createSession,
      createWorktree,
      removeWorktree,
      deleteSession,
      renameSession,
      markTitleGenerated,
      clearPendingPrompt,
      markStopped,
      restartSession,
      touchSession,
      updateClaudeSessionId,
      setAgentBusy,
      setAgentUsage,
      setSessionDraft,
      setSessionQuestion,
      updatePermissionMode,
      unreadSessions,
    ]
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
