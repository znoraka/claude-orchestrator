import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Session, SessionUsage } from "../types";

export function useSessionUsage(sessions: Session[]): Map<string, SessionUsage> {
  const [usageMap, setUsageMap] = useState<Map<string, SessionUsage>>(new Map());
  const usageMapRef = useRef(usageMap);
  usageMapRef.current = usageMap;

  // Stable key: only changes when running session set changes (not on activeTime/name updates)
  const runningKey = sessions.filter((s) => s.status === "running").map((s) => s.id).join(",");
  const runningSessions = useMemo(
    () => sessions.filter((s) => s.claudeSessionId && s.directory && s.status === "running"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runningKey]
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Watch running sessions and update usage on JSONL file changes
  useEffect(() => {
    const eligible = runningSessions;
    if (eligible.length === 0) return;

    const fetchUsageForSession = (session: Session) => {
      invoke<SessionUsage>("get_session_usage", {
        claudeSessionId: session.claudeSessionId,
        directory: session.directory,
      })
        .then((usage) => {
          if (usage.inputTokens === 0 && usage.outputTokens === 0 && !usage.isBusy) return;
          const prev = usageMapRef.current.get(session.id);
          if (
            prev &&
            prev.inputTokens === usage.inputTokens &&
            prev.outputTokens === usage.outputTokens &&
            prev.costUsd === usage.costUsd &&
            prev.isBusy === usage.isBusy &&
            prev.needsInput === usage.needsInput
          )
            return;
          setUsageMap((m) => {
            const next = new Map(m);
            next.set(session.id, usage);
            return next;
          });
        })
        .catch(() => {});
    };

    // Start watching and do initial fetch
    for (const session of eligible) {
      invoke("watch_jsonl", {
        claudeSessionId: session.claudeSessionId,
        directory: session.directory,
      }).catch(() => {});
      fetchUsageForSession(session);
    }

    // Build session ID set for fast lookup
    const sessionIdMap = new Map<string, Session>();
    for (const session of eligible) {
      sessionIdMap.set(session.claudeSessionId!, session);
    }

    // Listen for file change events
    const unlistenPromise = listen<string>("jsonl-changed", (event) => {
      const changedPath = event.payload;
      for (const [claudeSessionId, session] of sessionIdMap) {
        if (changedPath.includes(claudeSessionId)) {
          fetchUsageForSession(session);
          break;
        }
      }
    });

    // Poll busy sessions every 2s as a fallback in case file events are missed
    const pollInterval = setInterval(() => {
      for (const session of eligible) {
        const usage = usageMapRef.current.get(session.id);
        if (usage?.isBusy) {
          fetchUsageForSession(session);
        }
      }
    }, 2000);

    return () => {
      unlistenPromise.then((fn) => fn());
      clearInterval(pollInterval);
    };
  }, [runningSessions]);

  // Stable key for stopped sessions: only re-run when session list actually changes
  const stoppedSessionKey = useMemo(
    () => sessions.filter((s) => s.status === "stopped").map((s) => s.id).join(","),
    [sessions]
  );

  // Fetch once for stopped sessions that have no cached usage yet
  useEffect(() => {
    const stoppedWithoutUsage = sessionsRef.current.filter(
      (s) =>
        s.claudeSessionId &&
        s.directory &&
        s.status === "stopped" &&
        !usageMapRef.current.has(s.id)
    );
    for (const session of stoppedWithoutUsage) {
      invoke<SessionUsage>("get_session_usage", {
        claudeSessionId: session.claudeSessionId,
        directory: session.directory,
      })
        .then((usage) => {
          if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
          setUsageMap((m) => {
            const next = new Map(m);
            next.set(session.id, usage);
            return next;
          });
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stoppedSessionKey]);

  return usageMap;
}
