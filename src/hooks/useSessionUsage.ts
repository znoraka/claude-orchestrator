import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session, SessionUsage } from "../types";

export function useSessionUsage(sessions: Session[]): Map<string, SessionUsage> {
  const [usageMap, setUsageMap] = useState<Map<string, SessionUsage>>(new Map());
  const usageMapRef = useRef(usageMap);
  usageMapRef.current = usageMap;

  useEffect(() => {
    const fetchUsage = () => {
      const eligible = sessions.filter((s) => s.claudeSessionId && s.directory);
      if (eligible.length === 0) return;

      for (const session of eligible) {
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
              prev.outputTokens === usage.outputTokens
            )
              return;
            setUsageMap((m) => {
              const next = new Map(m);
              next.set(session.id, usage);
              return next;
            });
          })
          .catch(() => {});
      }
    };

    fetchUsage();
    const interval = setInterval(fetchUsage, 5000);
    return () => clearInterval(interval);
  }, [sessions]);

  return usageMap;
}
