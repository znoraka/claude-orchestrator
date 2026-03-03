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
import type { Session, SessionUsage, Harness } from "../types";

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
  activeSessionId: string | null;
  sessionUsage: Map<string, SessionUsage>;
  todayCost: number;
  todayTokens: number;

  selectSession: (id: string) => void;
  createSession: (
    name: string | undefined,
    directory: string,
    dangerouslySkipPermissions?: boolean,
    harness?: Harness
  ) => Promise<string>;
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
  const loadedRef = useRef(false);
  const { showError } = useToast();

  // ── Load persisted sessions on mount ─────────────────────────────
  useEffect(() => {
    invoke<
      Array<{
        id: string;
        name: string;
        createdAt: number;
        lastActiveAt: number;
        directory: string;
        harness?: string;
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
            directory: s.directory,
            harness: (s.harness as Harness) || "claude",
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
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        harness: s.harness,
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
  }, [sessions]);

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
  }, []);

  const createSession = useCallback(
    async (
      name: string | undefined,
      directory: string,
      dangerouslySkipPermissions = false,
      harness: Harness = "claude"
    ) => {
      const id = uuidv4();
      const claudeSessionId = harness === "claude" ? uuidv4() : undefined;
      const now = Date.now();
      const sessionCount = sessionsRef.current.length;
      const session: Session = {
        id,
        name: name || `Session ${sessionCount + 1}`,
        status: "starting",
        createdAt: now,
        lastActiveAt: now,
        directory,
        harness,
        claudeSessionId,
        dangerouslySkipPermissions,
      };

      dispatch({ type: "ADD", session });
      setActiveSessionId(id);

      try {
        await invoke("create_pty_session", {
          sessionId: id,
          directory,
          harness,
          claudeSessionId: claudeSessionId ?? null,
          resume: false,
          dangerouslySkipPermissions,
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

      dispatch({
        type: "UPDATE",
        id,
        patch: { status: "starting", lastActiveAt: Date.now() },
      });
      setActiveSessionId(id);

      try {
        await invoke("create_pty_session", {
          sessionId: id,
          directory: session.directory,
          harness: session.harness || "claude",
          claudeSessionId: session.claudeSessionId ?? null,
          resume: !!session.claudeSessionId,
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

  // ── Duration tracking ──────────────────────────────────────────
  const runningSinceRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // Track when sessions start running
    for (const s of sessions) {
      if (s.status === "running" && !runningSinceRef.current.has(s.id)) {
        runningSinceRef.current.set(s.id, Date.now());
      } else if (s.status !== "running") {
        runningSinceRef.current.delete(s.id);
      }
    }
  }, [sessions]);

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

  // ── Derived state / side-effect hooks ────────────────────────────

  useConversationTitles(sessions, renameSession);
  const sessionUsage = useSessionUsage(sessions);
  useBackgroundNotifications(sessions, sessionUsage, activeSessionId);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    [sessions]
  );

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
      activeSessionId,
      sessionUsage,
      todayCost,
      todayTokens,
      selectSession,
      createSession,
      deleteSession,
      renameSession,
      markStopped,
      restartSession,
      touchSession,
    }),
    [
      sessions,
      sortedSessions,
      activeSessionId,
      sessionUsage,
      todayCost,
      todayTokens,
      selectSession,
      createSession,
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
