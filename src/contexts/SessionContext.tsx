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
import { useToast } from "../components/Toast";
import type { Session, SessionUsage } from "../types";

const MAX_RUNNING_SESSIONS = 8;

// ── Reducer ──────────────────────────────────────────────────────────

type SessionAction =
  | { type: "SET_ALL"; sessions: Session[] }
  | { type: "ADD"; session: Session }
  | { type: "REMOVE"; id: string }
  | { type: "UPDATE"; id: string; patch: Partial<Session> }
  | { type: "MARK_STOPPED"; ids: string[] };

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

  selectSession: (id: string) => void;
  createSession: (
    name: string | undefined,
    directory: string,
    dangerouslySkipPermissions?: boolean
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
        claudeSessionId?: string;
        dangerouslySkipPermissions?: boolean;
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
            claudeSessionId: s.claudeSessionId,
            dangerouslySkipPermissions: s.dangerouslySkipPermissions,
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

  // ── Persist sessions on every change (after initial load) ────────
  useEffect(() => {
    if (!loadedRef.current) return;
    const metas = sessions.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      directory: s.directory,
      claudeSessionId: s.claudeSessionId,
      dangerouslySkipPermissions: s.dangerouslySkipPermissions,
    }));
    invoke("save_sessions", { sessions: metas }).catch((err) => {
      console.error("Failed to save sessions:", err);
      showError(`Failed to save sessions: ${err}`);
    });
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
      dangerouslySkipPermissions = false
    ) => {
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
        directory,
        claudeSessionId,
        dangerouslySkipPermissions,
      };

      dispatch({ type: "ADD", session });
      setActiveSessionId(id);

      try {
        await invoke("create_pty_session", {
          sessionId: id,
          directory,
          claudeSessionId,
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

  // ── Derived state / side-effect hooks ────────────────────────────

  useConversationTitles(sessions, renameSession);
  const sessionUsage = useSessionUsage(sessions);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    [sessions]
  );

  // Today's cost — refreshed on JSONL file changes + a slow fallback interval
  const [todayCost, setTodayCost] = useState(0);
  useEffect(() => {
    const fetchCost = () => {
      invoke<number>("get_total_cost_today")
        .then(setTodayCost)
        .catch(() => {});
    };
    fetchCost();
    // Refresh on any JSONL change event
    const unlistenPromise = listen<string>("jsonl-changed", () => {
      fetchCost();
    });
    // Slow fallback for sessions managed outside this app
    const interval = setInterval(fetchCost, 120_000);
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
