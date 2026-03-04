import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Polls shell PTY sessions to detect running child processes.
 * Returns a Map of directory path → number of shells with active processes.
 */
export function useShellProcessStatus(
  shellTabs: Map<string, { id: string; num: number }[]>,
  pollInterval = 5000
): Map<string, number> {
  const [activeCounts, setActiveCounts] = useState<Map<string, number>>(new Map());
  const shellTabsRef = useRef(shellTabs);
  shellTabsRef.current = shellTabs;

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const tabs = shellTabsRef.current;
      if (tabs.size === 0) {
        setActiveCounts((prev) => (prev.size === 0 ? prev : new Map()));
        return;
      }

      const next = new Map<string, number>();
      const promises: Promise<void>[] = [];

      for (const [dir, shells] of tabs) {
        for (const shell of shells) {
          promises.push(
            invoke<boolean>("pty_has_child_process", { sessionId: shell.id })
              .then((has) => {
                if (has) next.set(dir, (next.get(dir) || 0) + 1);
              })
              .catch(() => {})
          );
        }
      }

      await Promise.all(promises);
      if (!cancelled) {
        setActiveCounts((prev) => {
          if (prev.size === next.size && [...prev].every(([k, v]) => next.get(k) === v)) return prev;
          return next;
        });
      }
    };

    poll();
    const id = setInterval(poll, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollInterval]);

  return activeCounts;
}
