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
import { invoke } from "../lib/bridge";
import { listen } from "../lib/bridge";
import { getCurrentWindow } from "../lib/bridge";
import { v4 as uuidv4 } from "uuid";
import { useConversationTitles } from "../hooks/useConversationTitles";
import { useSessionUsage } from "../hooks/useSessionUsage";
import { useBackgroundNotifications } from "../hooks/useBackgroundNotifications";
import { useToast } from "../components/Toast";
import { jsonlDirectory, type AgentProvider, type Session, type SessionUsage, type Workspace } from "../types";
import { deriveWorkspaces, workspaceForSession, normalizeDir, repoRootDir } from "../utils/workspaces";
import { getYoungestDescendant, getRootSession } from "../utils/sessionLineage";

// ── Reducer ──────────────────────────────────────────────────────────

type SessionAction =
  | { type: "SET_ALL"; sessions: Session[] }
  | { type: "APPEND_MANY"; sessions: Session[] }
  | { type: "ADD"; session: Session }
  | { type: "REMOVE"; id: string }
  | { type: "UPDATE"; id: string; patch: Partial<Session> }
  | { type: "MARK_STOPPED"; ids: string[] };

function sessionReducer(state: Session[], action: SessionAction): Session[] {
  switch (action.type) {
    case "SET_ALL":
      return action.sessions;
    case "APPEND_MANY": {
      const existingIds = new Set(state.map((s) => s.id));
      const newSessions = action.sessions.filter((s) => !existingIds.has(s.id));
      return newSessions.length > 0 ? [...state, ...newSessions] : state;
    }
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
    parentSessionId?: string,
    pendingImages?: Array<{ id: string; data: string; mediaType: string; name: string }>,
    pendingFiles?: Array<{ id: string; name: string; content: string; mimeType: string }>
  ) => Promise<string>;
  createPendingSession: (
    name: string | undefined,
    directory: string,
    dangerouslySkipPermissions?: boolean,
    permissionMode?: "bypassPermissions" | "plan"
  ) => Promise<string>;
  startPendingSession: (id: string, provider: AgentProvider, model?: string) => Promise<void>;
  updateSessionModel: (id: string, model: string) => void;
  updateSessionProvider: (id: string, provider: AgentProvider) => void;
  createWorktree: (repoDir: string, branchName: string, worktreeName?: string) => Promise<string>;
  removeWorktree: (path: string) => Promise<void>;
  archiveSession: (id: string) => void;
  unarchiveSession: (id: string) => void;
  archiveWorktree: (path: string) => Promise<void>;
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
}

// ── Live context: frequently-updated data separated so cold consumers don't re-render ──

interface SessionLiveContextValue {
  sessionUsage: Map<string, SessionUsage>;
  todayCost: number;
  todayTokens: number;
  unreadSessions: Set<string>;
}

const SessionContext = createContext<SessionContextValue | null>(null);
const SessionLiveContext = createContext<SessionLiveContextValue | null>(null);

export function useSessionContext(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSessionContext must be used within SessionProvider");
  return ctx;
}

export function useSessionLive(): SessionLiveContextValue {
  const ctx = useContext(SessionLiveContext);
  if (!ctx) throw new Error("useSessionLive must be used within SessionProvider");
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
    type RawSession = {
      id: string;
      name: string;
      createdAt: number;
      lastActiveAt: number;
      lastMessageAt?: number;
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
      archived?: boolean;
      archivedAt?: number;
    };

    const toSession = (s: RawSession): Session => ({
      id: s.id,
      name: s.name,
      status: "stopped" as const,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      lastMessageAt: s.lastMessageAt || s.lastActiveAt,
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
      archived: s.archived,
      archivedAt: s.archivedAt,
    });

    const INITIAL_LIMIT = 10;
    const PAGE_SIZE = 50;

    // Load first page immediately to unblock the UI
    invoke<Array<RawSession>>("load_sessions_paged", { limit: INITIAL_LIMIT, offset: 0 })
      .then((saved) => {
        if (saved.length > 0) {
          dispatch({ type: "SET_ALL", sessions: saved.map(toSession) });
        }
        loadedRef.current = true;
        // Restore busy state from backend (shared across frontends, persists through reconnect)
        invoke<string[]>("get_busy_sessions").then((ids) => {
          for (const id of ids) setAgentBusyMap((prev) => { const n = new Map(prev); n.set(id, true); return n; });
        }).catch(() => {});

        // If first page was full, there may be more — load the rest in the background
        if (saved.length === INITIAL_LIMIT) {
          const loadRest = async (offset: number) => {
            try {
              const page = await invoke<Array<RawSession>>("load_sessions_paged", {
                limit: PAGE_SIZE,
                offset,
              });
              if (page.length > 0) {
                dispatch({ type: "APPEND_MANY", sessions: page.map(toSession) });
              }
              if (page.length === PAGE_SIZE) {
                loadRest(offset + PAGE_SIZE);
              }
            } catch (err) {
              console.error("Failed to load sessions page:", err);
            }
          };
          loadRest(INITIAL_LIMIT);
        }
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

  // Track lastActiveAt in a ref to avoid triggering re-renders on every session switch.
  // Values are merged into session metas on save.
  const lastActiveAtRef = useRef<Map<string, number>>(new Map());

  // Live activeTime accumulator — avoids dispatching TICK_ACTIVE_TIMES to the reducer
  // every 60s (which cascades all workspace/session memos). Instead we accumulate here
  // and read it back in buildSessionMetas so saves stay accurate.
  const liveActiveTimeRef = useRef<Map<string, number>>(new Map());

  // ── Helper to build session metadata for saving ───────────────────
  const buildSessionMetas = useCallback(() => {
    return sessionsRef.current.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      lastActiveAt: lastActiveAtRef.current.get(s.id) ?? s.lastActiveAt,
      lastMessageAt: s.lastMessageAt,
      directory: s.directory,
      provider: s.provider || "claude-code",
      model: s.model,
      homeDirectory: s.homeDirectory,
      claudeSessionId: s.claudeSessionId,
      dangerouslySkipPermissions: s.dangerouslySkipPermissions,
      permissionMode: s.permissionMode,
      activeTime: liveActiveTimeRef.current.get(s.id) ?? s.activeTime ?? 0,
      hasTitleBeenGenerated: s.hasTitleBeenGenerated,
      planContent: s.planContent,
      parentSessionId: s.parentSessionId,
      archived: s.archived,
      archivedAt: s.archivedAt,
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
      lastSaveTs.current = Date.now();
      await invoke("save_sessions", { sessions: buildSessionMetas() });
    } catch (err) {
      console.error("Failed to save sessions:", err);
    }
  }, [buildSessionMetas]);

  // ── Persist sessions on every change (debounced, after initial load) ─
  // Use a stable key that excludes volatile fields (activeTime) to avoid
  // re-saving on every session status change.
  const saveKey = useMemo(
    () =>
      sessions
        .map((s) => `${s.id}:${s.name}:${s.directory}:${s.provider}:${s.model}:${s.homeDirectory}:${s.claudeSessionId}:${s.status}:${s.lastActiveAt}:${s.lastMessageAt}:${s.dangerouslySkipPermissions}:${s.hasTitleBeenGenerated}:${s.permissionMode}:${s.parentSessionId}:${s.archived}`)
        .join("|"),
    [sessions]
  );
  useEffect(() => {
    if (!loadedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      lastSaveTs.current = Date.now();
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
      lastSaveTs.current = Date.now();
      invoke("save_sessions", { sessions: buildSessionMetas() }).catch(() => {});
    }, 300_000);
    return () => {
      if (activeTimeSaveRef.current) clearInterval(activeTimeSaveRef.current);
    };
  }, [buildSessionMetas]);

  // ── Sync sessions from other clients ────────────────────────────
  // When another frontend saves sessions, reload from the DB.
  // Use a timestamp guard to avoid reloading right after we saved.
  const lastSaveTs = useRef(0);

  // ── Sync session busy state from backend ─────────────────────────
  // Shared across all frontends; backend tracks busy sessions from bridge stdout.
  useEffect(() => {
    const unlisten = listen<{ sessionId: string; isBusy: boolean }>("session-busy-changed", (event) => {
      const { sessionId, isBusy } = event.payload;
      setAgentBusyMap((prev) => {
        if (prev.get(sessionId) === isBusy) return prev;
        const next = new Map(prev);
        if (isBusy) next.set(sessionId, true);
        else next.delete(sessionId);
        return next;
      });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const unlisten = listen("sessions-changed", () => {
      // Ignore if we just saved (within 3s) — it's our own echo
      if (Date.now() - lastSaveTs.current < 3000) return;
      if (!loadedRef.current) return;

      invoke<
        Array<{
          id: string;
          name: string;
          createdAt: number;
          lastActiveAt: number;
          lastMessageAt?: number;
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
          archived?: boolean;
          archivedAt?: number;
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
              lastMessageAt: s.lastMessageAt || s.lastActiveAt,
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
              archived: s.archived,
              archivedAt: s.archivedAt,
            }));
            dispatch({ type: "SET_ALL", sessions: restored });
          }
        })
        .catch((err) => {
          console.error("Failed to reload sessions from remote:", err);
        });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // After a WebSocket reconnect, re-sync all state that may have been
  // missed while disconnected (sessions + busy map).
  useEffect(() => {
    const unlisten = listen("bridge-reconnected", () => {
      console.log("[session] Bridge reconnected, re-syncing state...");
      // Re-fetch sessions
      invoke<
        Array<{
          id: string;
          name: string;
          createdAt: number;
          lastActiveAt: number;
          lastMessageAt?: number;
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
          archived?: boolean;
          archivedAt?: number;
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
              lastMessageAt: s.lastMessageAt || s.lastActiveAt,
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
              archived: s.archived,
              archivedAt: s.archivedAt,
            }));
            dispatch({ type: "SET_ALL", sessions: restored });
          }
        })
        .catch((err) => console.error("Failed to re-sync sessions after reconnect:", err));

      // Re-fetch busy sessions
      invoke<string[]>("get_busy_sessions")
        .then((ids) => {
          setAgentBusyMap(new Map(ids.map((id) => [id, true])));
        })
        .catch((err) => console.error("Failed to re-sync busy sessions:", err));
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // ── Flush pending saves before app close ──────────────────────────
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async () => {
      await saveSessionsImmediately();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [saveSessionsImmediately]);

  // ── Actions ──────────────────────────────────────────────────────

  const selectSession = useCallback((id: string) => {
    // Always resolve to the root ancestor so sidebar highlighting stays consistent
    const root = getRootSession(id, sessionsRef.current);
    const rootId = root.id;
    setActiveSessionId(rootId);
    // Record access time in a ref — avoids mutating the sessions array (and the
    // re-render cascade that would cause) on every session switch.
    lastActiveAtRef.current.set(rootId, Date.now());
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
        .filter((s) => repoRootDir(s.directory || "~") === workspaceId && !s.parentSessionId)
        .sort((a, b) => (lastActiveAtRef.current.get(b.id) ?? b.lastActiveAt) - (lastActiveAtRef.current.get(a.id) ?? a.lastActiveAt));
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
        .filter((s) => (s.directory || "~") === worktreePath && !s.parentSessionId)
        .sort((a, b) => (lastActiveAtRef.current.get(b.id) ?? b.lastActiveAt) - (lastActiveAtRef.current.get(a.id) ?? a.lastActiveAt));
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
      parentSessionId?: string,
      pendingImages?: Array<{ id: string; data: string; mediaType: string; name: string }>,
      pendingFiles?: Array<{ id: string; name: string; content: string; mimeType: string }>
    ) => {
      const dir = normalizeDir(directory);
      const id = uuidv4();
      const now = Date.now();
      const sessionCount = sessionsRef.current.length;
      const session: Session = {
        id,
        name: name || (pendingPrompt ? pendingPrompt.slice(0, 50).trimEnd() : `Session ${sessionCount + 1}`),
        hasTitleBeenGenerated: !!(name || pendingPrompt),
        status: "starting",
        createdAt: now,
        lastActiveAt: now,
        lastMessageAt: now,
        directory: dir,
        provider,
        model: model || undefined,
        dangerouslySkipPermissions,
        permissionMode,
        pendingPrompt,
        pendingImages,
        pendingFiles,
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
          claudeSessionId: null,
          resume: false,
          systemPrompt: extraSystemPrompt || null,
          provider,
          model: model || null,
          permissionMode: permissionMode || null,
        });
        dispatch({ type: "UPDATE", id, patch: { status: "running" } });
      } catch (err) {
        console.error("Failed to create session:", err);
        showError(`Failed to create session: ${err}`);
        dispatch({ type: "UPDATE", id, patch: { status: "stopped" } });
      }

      return id;
    },
    [showError, saveSessionsImmediately]
  );

  const createPendingSession = useCallback(
    async (
      name: string | undefined,
      directory: string,
      dangerouslySkipPermissions = false,
      permissionMode?: "bypassPermissions" | "plan"
    ) => {
      const dir = normalizeDir(directory);
      const id = uuidv4();
      const now = Date.now();
      const sessionCount = sessionsRef.current.length;
      const session: Session = {
        id,
        name: name || `Session ${sessionCount + 1}`,
        hasTitleBeenGenerated: !!name,
        status: "pending",
        createdAt: now,
        lastActiveAt: now,
        lastMessageAt: now,
        directory: dir,
        provider: "claude-code",
        dangerouslySkipPermissions,
        permissionMode,
      };
      dispatch({ type: "ADD", session });
      setActiveSessionId(id);
      setTimeout(() => saveSessionsImmediately(), 0);
      return id;
    },
    [saveSessionsImmediately]
  );

  const startPendingSession = useCallback(
    async (id: string, provider: AgentProvider, model?: string) => {
      const session = sessionsRef.current.find((s) => s.id === id);
      if (!session) throw new Error(`Session ${id} not found`);
      try {
        await invoke("create_agent_session", {
          sessionId: id,
          directory: session.directory,
          claudeSessionId: null,
          resume: false,
          systemPrompt: null,
          provider,
          model: model || null,
          permissionMode: session.permissionMode || null,
        });
        dispatch({ type: "UPDATE", id, patch: { status: "running", provider, model: model || undefined } });
      } catch (err) {
        dispatch({ type: "UPDATE", id, patch: { status: "stopped" } });
        throw err;
      }
    },
    []
  );

  const updateSessionProvider = useCallback((id: string, provider: AgentProvider) => {
    dispatch({ type: "UPDATE", id, patch: { provider } });
  }, []);

  const updateSessionModel = useCallback((id: string, model: string) => {
    dispatch({ type: "UPDATE", id, patch: { model } });
  }, []);

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
          .filter((s) => s.id !== id && !s.parentSessionId)
          .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
        return remaining.length > 0 ? remaining[0].id : null;
      });

      // Save immediately after removal to ensure deletion is persisted
      // Use setTimeout(0) to ensure dispatch has updated sessionsRef
      setTimeout(() => saveSessionsImmediately(), 0);
    },
    [saveSessionsImmediately]
  );

  const archiveSession = useCallback((id: string) => {
    dispatch({ type: "UPDATE", id, patch: { archived: true, archivedAt: Date.now() } });
  }, []);

  const unarchiveSession = useCallback((id: string) => {
    dispatch({ type: "UPDATE", id, patch: { archived: false, archivedAt: undefined } });
  }, []);

  const archiveWorktree = useCallback(
    async (path: string) => {
      // Archive all sessions in this worktree
      const now = Date.now();
      for (const s of sessionsRef.current) {
        if (s.directory === path) {
          dispatch({ type: "UPDATE", id: s.id, patch: { archived: true, archivedAt: now } });
        }
      }
      // Remove the git worktree
      try {
        await invoke("remove_worktree", { path });
      } catch (err) {
        console.error("Failed to remove worktree:", err);
      }
    },
    []
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
    if (session?.status === "stopped") return;
    dispatch({ type: "UPDATE", id, patch: { status: "stopped", exitCode } });
  }, []);

  const restartSession = useCallback(
    async (id: string) => {
      const session = sessionsRef.current.find((s) => s.id === id);
      if (!session) {
        console.error(`[SessionContext] Session ${id} not found`);
        return;
      }

      const isResume = !!session.claudeSessionId;

      dispatch({
        type: "UPDATE",
        id,
        patch: {
          status: "starting",
          lastActiveAt: Date.now(),
          lastMessageAt: Date.now(),
          exitCode: undefined,
        },
      });
      // Always resolve to root so sidebar never shows a child as top-level
      const root = getRootSession(id, sessionsRef.current);
      setActiveSessionId(root.id);

      // When resuming a worktree session, use the original (home) directory
      // so Claude CLI can find the JSONL in the correct project folder.
      const spawnDir = isResume ? jsonlDirectory(session) : session.directory;

      try {
        await invoke("create_agent_session", {
          sessionId: id,
          directory: spawnDir,
          claudeSessionId: session.claudeSessionId || null,
          resume: isResume,
          systemPrompt: null,
          provider: session.provider || "claude-code",
          model: session.model || null,
          permissionMode: session.permissionMode || null,
        });
        dispatch({ type: "UPDATE", id, patch: { status: "running" } });
      } catch (err) {
        console.error("Failed to restart session:", err);
        showError(`Failed to restart session: ${err}`);
        dispatch({ type: "UPDATE", id, patch: { status: "stopped" } });
      }
    },
    [showError]
  );

  const touchSession = useCallback((id: string) => {
    const now = Date.now();
    dispatch({ type: "UPDATE", id, patch: { lastActiveAt: now, lastMessageAt: now } });
  }, []);

  const updateClaudeSessionId = useCallback((id: string, claudeSessionId: string) => {
    dispatch({ type: "UPDATE", id, patch: { claudeSessionId } });
    // Save immediately so the real Claude session ID persists even if the app
    // restarts within the normal 2-second debounce window.
    setTimeout(() => saveSessionsImmediately(), 0);
  }, [saveSessionsImmediately]);

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

  // Seed liveActiveTimeRef for any session not yet tracked (runs on every session change,
  // but only initializes new entries — no state mutation, no re-render cascade).
  useEffect(() => {
    for (const s of sessions) {
      if (!liveActiveTimeRef.current.has(s.id)) {
        liveActiveTimeRef.current.set(s.id, s.activeTime || 0);
      }
    }
  }, [sessions]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const running = sessionsRef.current.filter((s) => s.status === "running");
      if (running.length === 0) return;

      for (const s of running) {
        const since = runningSinceRef.current.get(s.id);
        if (!since) continue;
        const elapsed = now - since;
        runningSinceRef.current.set(s.id, now);
        const prev = liveActiveTimeRef.current.get(s.id) ?? s.activeTime ?? 0;
        liveActiveTimeRef.current.set(s.id, prev + elapsed);
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

      // Always resolve to root so sidebar never shows a child as top-level
      const rootSession = getRootSession(fromSessionId, sessionsRef.current);
      setActiveSessionId(rootSession.id);
    });

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  const [nonExistentDirs, setNonExistentDirs] = useState<Set<string>>(new Set());

  // ── Auto-revert sessions whose worktree directory was removed ────
  useEffect(() => {
    const check = async () => {
      const current = sessionsRef.current;
      const worktreeSessions = current.filter((s) => s.directory?.includes("/.worktrees/"));
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
      // Check all unique session directories and hide non-existent ones from the sidebar
      const allDirs = [...new Set(current.map((s) => s.directory).filter(Boolean))] as string[];
      const results = await Promise.all(
        allDirs.map(async (dir) => {
          const exists = await invoke<boolean>("directory_exists", { path: dir });
          return { dir, exists };
        })
      );
      const missing = new Set(results.filter((r) => !r.exists).map((r) => r.dir));
      setNonExistentDirs(missing);
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

  // Stable usage data: token/cost info that changes only when JSONL flushes or
  // agent reports new usage — not on every agent message (avoids re-computing
  // during active streaming sessions).
  const baseUsage = useMemo(() => {
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
    return merged;
  }, [jsonlUsage, agentUsageMap]);

  // Merge busy overlay on top of base usage. This re-runs on every agent message
  // but is now a cheap pass over the already-computed base map.
  const sessionUsage = useMemo(() => {
    const merged = new Map(baseUsage);
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
    // Force stopped sessions to never appear busy — unless backend says they're still active
    for (const s of sessions) {
      if (s.status === "stopped" && !agentBusyMap.get(s.id)) {
        const existing = merged.get(s.id);
        if (existing?.isBusy) {
          merged.set(s.id, { ...existing, isBusy: false });
        }
      }
    }
    return merged;
  }, [baseUsage, agentBusyMap, sessions]);

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
      if (wasBusy && !isBusy && !wasActive && session.status !== "stopped") {
        const targetId = session.parentSessionId && sessionsRef.current.some(s => s.id === session.parentSessionId)
          ? session.parentSessionId
          : session.id;
        const isTargetActive = prevActiveSessionIdRef.current === targetId;
        const targetSession = sessionsRef.current.find(s => s.id === targetId);
        if (!isTargetActive && targetSession?.status !== "stopped") {
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

  // Clear unread for stopped sessions (e.g. killed by session limit)
  useEffect(() => {
    const stoppedIds = sessions.filter(s => s.status === "stopped").map(s => s.id);
    if (stoppedIds.length === 0) return;
    setUnreadSessions((prev) => {
      let changed = false;
      for (const id of stoppedIds) {
        if (prev.has(id)) { changed = true; break; }
      }
      if (!changed) return prev;
      const next = new Set(prev);
      for (const id of stoppedIds) next.delete(id);
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
    () => [...sessions].sort((a, b) => (lastActiveAtRef.current.get(b.id) ?? b.lastActiveAt) - (lastActiveAtRef.current.get(a.id) ?? a.lastActiveAt)),
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

  const workspaces = useMemo(() => deriveWorkspaces(sessions, nonExistentDirs), [sessions, nonExistentDirs]);

  const activeWorkspaceId = useMemo(
    () => activeSessionId ? workspaceForSession(activeSessionId, sessions) : null,
    [activeSessionId, sessions]
  );

  const activeWorktreePath = useMemo(() => {
    if (!effectiveSessionId) return null;
    const session = sessions.find((s) => s.id === effectiveSessionId);
    return session?.directory ?? null;
  }, [effectiveSessionId, sessions]);

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
    // Refresh on any JSONL change event (debounced: coalesce rapid writes)
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unlistenPromise = listen<string>("jsonl-changed", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fetchUsage, 300);
    });
    // Slow fallback for sessions managed outside this app
    const interval = setInterval(fetchUsage, 120_000);
    return () => {
      unlistenPromise.then((fn) => fn());
      clearInterval(interval);
      if (debounceTimer) clearTimeout(debounceTimer);
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
      selectSession,
      selectWorkspace,
      selectWorktree,
      createSession,
      createPendingSession,
      startPendingSession,
      updateSessionModel,
      updateSessionProvider,
      createWorktree,
      removeWorktree,
      archiveSession,
      unarchiveSession,
      archiveWorktree,
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
      selectSession,
      selectWorkspace,
      selectWorktree,
      createSession,
      createPendingSession,
      startPendingSession,
      updateSessionModel,
      updateSessionProvider,
      createWorktree,
      removeWorktree,
      archiveSession,
      unarchiveSession,
      archiveWorktree,
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
    ]
  );

  // Frequently-updated live data in its own context so cold consumers don't re-render
  const liveValue = useMemo<SessionLiveContextValue>(
    () => ({ sessionUsage, todayCost, todayTokens, unreadSessions }),
    [sessionUsage, todayCost, todayTokens, unreadSessions]
  );

  return (
    <SessionContext.Provider value={value}>
      <SessionLiveContext.Provider value={liveValue}>
        {children}
      </SessionLiveContext.Provider>
    </SessionContext.Provider>
  );
}
