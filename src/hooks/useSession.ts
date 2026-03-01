import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "uuid";
import type { Session } from "../types";

const MAX_RUNNING_SESSIONS = 8;

export function useSession() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const sessionsRef = useRef<Session[]>([]);

  // Load persisted sessions on mount
  useEffect(() => {
    invoke<
      Array<{
        id: string;
        name: string;
        createdAt: number;
        lastActiveAt: number;
        directory: string;
        claudeSessionId?: string;
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
          }));
          setSessions(restored);
        }
        loadedRef.current = true;
      })
      .catch((err) => {
        console.error("Failed to load sessions:", err);
        loadedRef.current = true;
      });
  }, []);

  // Keep ref in sync for synchronous access
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // Persist sessions on every change (after initial load)
  useEffect(() => {
    if (!loadedRef.current) return;
    const metas = sessions.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      directory: s.directory,
      claudeSessionId: s.claudeSessionId,
    }));
    invoke("save_sessions", { sessions: metas }).catch((err) =>
      console.error("Failed to save sessions:", err)
    );
  }, [sessions]);

  // Kill oldest running sessions when over the limit
  const enforceMaxSessions = useCallback(
    async (excludeId?: string) => {
      const current = sessionsRef.current;
      const running = current
        .filter((s) => s.status === "running" && s.id !== excludeId)
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt); // oldest first

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

      const killIds = new Set(toKill.map((s) => s.id));
      setSessions((prev) =>
        prev.map((s) =>
          killIds.has(s.id) ? { ...s, status: "stopped" } : s
        )
      );
    },
    []
  );

  const createSession = useCallback(
    async (name: string | undefined, directory: string, dangerouslySkipPermissions = false) => {
      const id = uuidv4();
      const claudeSessionId = uuidv4();
      const now = Date.now();
      const session: Session = {
        id,
        name: name || `Session ${sessions.length + 1}`,
        status: "starting",
        createdAt: now,
        lastActiveAt: now,
        directory,
        claudeSessionId,
        dangerouslySkipPermissions,
      };

      setSessions((prev) => [...prev, session]);
      setActiveSessionId(id);

      try {
        await invoke("create_pty_session", {
          sessionId: id,
          directory,
          claudeSessionId,
          resume: false,
          dangerouslySkipPermissions,
        });
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, status: "running" } : s))
        );
        await enforceMaxSessions(id);
      } catch (err) {
        console.error("Failed to create session:", err);
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...s, status: "stopped" } : s))
        );
      }

      return id;
    },
    [sessions.length, enforceMaxSessions]
  );

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await invoke("destroy_pty_session", { sessionId: id });
      } catch (err) {
        console.error("Failed to destroy session:", err);
      }

      setSessions((prev) => prev.filter((s) => s.id !== id));

      if (activeSessionId === id) {
        setSessions((prev) => {
          const remaining = prev.filter((s) => s.id !== id);
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
          return remaining;
        });
      }
    },
    [activeSessionId]
  );

  const renameSession = useCallback((id: string, name: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name } : s))
    );
  }, []);

  const markStopped = useCallback((id: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status: "stopped" } : s))
    );
  }, []);

  const restartSession = useCallback(async (id: string) => {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) {
      console.error(`[useSession] Session ${id} not found`);
      return;
    }
    const { directory, claudeSessionId } = session;

    setSessions((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, status: "starting", lastActiveAt: Date.now() } : s
      )
    );
    setActiveSessionId(id);

    try {
      await invoke("create_pty_session", {
        sessionId: id,
        directory,
        claudeSessionId: claudeSessionId ?? null,
        resume: !!claudeSessionId,
        dangerouslySkipPermissions: session.dangerouslySkipPermissions ?? false,
      });
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status: "running" } : s))
      );
      await enforceMaxSessions(id);
    } catch (err) {
      console.error("Failed to restart session:", err);
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status: "stopped" } : s))
      );
    }
  }, [enforceMaxSessions]);

  const touchSession = useCallback((id: string) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, lastActiveAt: Date.now() } : s
      )
    );
  }, []);

  const selectSession = useCallback(
    (id: string) => {
      setActiveSessionId(id);
    },
    []
  );

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    [sessions]
  );

  return {
    sessions,
    sortedSessions,
    activeSessionId,
    setActiveSessionId,
    createSession,
    deleteSession,
    renameSession,
    markStopped,
    restartSession,
    touchSession,
    selectSession,
  };
}
