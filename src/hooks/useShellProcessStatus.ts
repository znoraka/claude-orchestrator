import { useState, useEffect, useRef } from "react";
import { invoke } from "../lib/bridge";
import { useAppVisible } from "./useAppVisible";

/**
 * Polls shell PTY sessions to detect running child processes.
 * Returns a Map of directory path → number of shells with active processes.
 * Pauses polling when the app is not visible.
 */
export function useShellProcessStatus(
  shellTabs: { id: string; directory: string }[],
  pollInterval = 5000
): Map<string, number> {
  const [activeCounts, setActiveCounts] = useState<Map<string, number>>(new Map());
  const shellTabsRef = useRef(shellTabs);
  shellTabsRef.current = shellTabs;
  const appVisible = useAppVisible();

  useEffect(() => {
    if (!appVisible) return;
    let cancelled = false;

    const poll = async () => {
      const tabs = shellTabsRef.current;
      if (tabs.length === 0) {
        setActiveCounts((prev) => (prev.size === 0 ? prev : new Map()));
        return;
      }

      const next = new Map<string, number>();
      const promises: Promise<void>[] = [];

      for (const tab of tabs) {
        promises.push(
          invoke<boolean>("pty_has_child_process", { sessionId: tab.id })
            .then((has) => {
              if (has) next.set(tab.directory, (next.get(tab.directory) || 0) + 1);
            })
            .catch(() => {})
        );
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
  }, [pollInterval, appVisible]);

  return activeCounts;
}
