import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Session, SessionUsage } from "../types";

export function useSessionUsage(sessions: Session[]): Map<string, SessionUsage> {
  const [usageMap, setUsageMap] = useState<Map<string, SessionUsage>>(new Map());
  const usageMapRef = useRef(usageMap);
  usageMapRef.current = usageMap;

  // Watch running sessions and update usage on JSONL file changes
  useEffect(() => {
    const eligible = sessions.filter(
      (s) => s.claudeSessionId && s.directory && s.status === "running"
    );
    if (eligible.length === 0) return;

    const fetchUsageForSession = (session: Session) => {
      invoke<SessionUsage>("get_session_usage", {
        claudeSessionId: session.claudeSessionId,
        directory: session.directory,
      })
        .then((usage) => {
          if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
          const prev = usageMapRef.current.get(session.id);
          if (
            prev &&
            prev.inputTokens === usage.inputTokens &&
            prev.outputTokens === usage.outputTokens &&
            prev.costUsd === usage.costUsd
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

    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, [sessions]);

  // Fetch once for stopped sessions that have no cached usage yet
  useEffect(() => {
    const stoppedWithoutUsage = sessions.filter(
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
  }, [sessions]);

  return usageMap;
}
