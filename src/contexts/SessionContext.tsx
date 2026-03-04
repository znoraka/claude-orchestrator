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
import { v4 as uuidv4 } from "uuid";
import { useConversationTitles } from "../hooks/useConversationTitles";
import { useSessionUsage } from "../hooks/useSessionUsage";
import { useBackgroundNotifications } from "../hooks/useBackgroundNotifications";
import { useToast } from "../components/Toast";
import { jsonlDirectory, type Session, type SessionUsage, type Workspace } from "../types";
import { deriveWorkspaces, workspaceForSession, normalizeDir, repoRootDir } from "../utils/workspaces";

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
        action.ids.includes(s.id) ? { ...s, status: "stopped" as const } : s
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
  activeWorkspaceId: string | null;
  activeWorktreePath: string | null;
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
    extraSystemPrompt?: string
  ) => Promise<string>;
  createWorktree: (repoDir: string, branchName: string, worktreeName?: string) => Promise<string>;
  removeWorktree: (path: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => void;
  markStopped: (id: string) => void;
  restartSession: (id: string) => Promise<void>;
  touchSession: (id: string) => void;
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
        homeDirectory?: string;
        claudeSessionId?: string;
        dangerouslySkipPermissions?: boolean;
        activeTime?: number;
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
            homeDirectory: s.homeDirectory ? normalizeDir(s.homeDirectory) : undefined,
            claudeSessionId: s.claudeSessionId,
            dangerouslySkipPermissions: s.dangerouslySkipPermissions,
            activeTime: s.activeTime || 0,
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

  // ── Persist sessions on every change (debounced, after initial load) ─
  // Use a stable key that excludes volatile fields (activeTime) to avoid
  // re-saving every 60s when TICK_ACTIVE_TIMES fires.
  const saveKey = useMemo(
    () =>
      sessions
        .map((s) => `${s.id}:${s.name}:${s.directory}:${s.homeDirectory}:${s.claudeSessionId}:${s.status}:${s.lastActiveAt}:${s.dangerouslySkipPermissions}`)
        .join("|"),
    [sessions]
  );
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTimeSaveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!loadedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const metas = sessionsRef.current.map((s) => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        directory: s.directory,
        homeDirectory: s.homeDirectory,
        claudeSessionId: s.claudeSessionId,
        dangerouslySkipPermissions: s.dangerouslySkipPermissions,
        activeTime: s.activeTime || 0,
      }));
      invoke("save_sessions", { sessions: metas }).catch((err) => {
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
      const metas = sessionsRef.current.map((s) => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        directory: s.directory,
        homeDirectory: s.homeDirectory,
        claudeSessionId: s.claudeSessionId,
        dangerouslySkipPermissions: s.dangerouslySkipPermissions,
        activeTime: s.activeTime || 0,
      }));
      invoke("save_sessions", { sessions: metas }).catch(() => {});
    }, 300_000);
    return () => {
      if (activeTimeSaveRef.current) clearInterval(activeTimeSaveRef.current);
    };
  }, []);

  // ── Kill oldest running sessions when over the limit ─────────────
  // Uses the dispatch-based approach: no refs needed because we read
  // current state from the sessions array captured by the effect.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

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
        await invoke("destroy_pty_session", { sessionId: session.id });
      } catch (err) {
        console.error(`Failed to kill excess session ${session.id}:`, err);
      }
    }

    dispatch({ type: "MARK_STOPPED", ids: toKill.map((s) => s.id) });
  }, []);

  // ── Actions ──────────────────────────────────────────────────────

  const selectSession = useCallback((id: string) => {
    setActiveSessionId(id);
    const session = sessionsRef.current.find((s) => s.id === id);
    if (session) {
      // Key by worktree path (session directory) for finer-grained recall
      activeSessionInWorkspace.current.set(session.directory || "~", id);
      // Also key by workspace (repo root) so selectWorkspace can fall back
      const wsId = repoRootDir(session.directory || "~");
      activeSessionInWorkspace.current.set(wsId, id);
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
      extraSystemPrompt?: string
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
        claudeSessionId,
        dangerouslySkipPermissions,
      };

      dispatch({ type: "ADD", session });
      setActiveSessionId(id);

      try {
        await invoke("create_pty_session", {
          sessionId: id,
          directory: dir,
          claudeSessionId,
          resume: false,
          dangerouslySkipPermissions,
          extraSystemPrompt: extraSystemPrompt || null,
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
    [enforceMaxSessions, showError]
  );

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await invoke("destroy_pty_session", { sessionId: id });
      } catch (err) {
        console.error("Failed to destroy session:", err);
      }

      dispatch({ type: "REMOVE", id });

      setActiveSessionId((prev) => {
        if (prev !== id) return prev;
        const remaining = sessionsRef.current.filter((s) => s.id !== id);
        return remaining.length > 0 ? remaining[0].id : null;
      });
    },
    []
  );

  const renameSession = useCallback((id: string, name: string) => {
    dispatch({ type: "UPDATE", id, patch: { name } });
  }, []);

  const markStopped = useCallback((id: string) => {
    dispatch({ type: "UPDATE", id, patch: { status: "stopped" } });
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
          ...(!session.claudeSessionId ? { claudeSessionId } : {}),
        },
      });
      setActiveSessionId(id);

      // When resuming a worktree session, use the original (home) directory
      // so Claude CLI can find the JSONL in the correct project folder.
      const spawnDir = isResume ? jsonlDirectory(session) : session.directory;

      try {
        await invoke("create_pty_session", {
          sessionId: id,
          directory: spawnDir,
          claudeSessionId,
          resume: isResume,
          dangerouslySkipPermissions:
            session.dangerouslySkipPermissions ?? false,
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

  useConversationTitles(sessions, renameSession);
  const sessionUsage = useSessionUsage(sessions);
  useBackgroundNotifications(sessions, sessionUsage, activeSessionId);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    [sessions]
  );

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
      activeWorkspaceId,
      activeWorktreePath,
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
      markStopped,
      restartSession,
      touchSession,
    }),
    [
      sessions,
      sortedSessions,
      workspaces,
      activeSessionId,
      activeWorkspaceId,
      activeWorktreePath,
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
      markStopped,
      restartSession,
      touchSession,
    ]
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
