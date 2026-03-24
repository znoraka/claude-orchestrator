import { useState, useEffect, useRef } from "react";
import { invoke } from "../lib/bridge";
import { useAppVisible } from "./useAppVisible";

/**
 * Polls shell PTY sessions to detect running child processes.
 * Returns:
 * - activeCounts: Map of directory → number of shells with active processes
 * - busySessionIds: Set of session IDs that have a running command
 * - foregroundCommands: Map of session ID → command name for busy sessions
 * Pauses polling when the app is not visible.
 */
export function useShellProcessStatus(
  shellTabs: { id: string; directory: string }[],
  pollInterval = 5000
): { activeCounts: Map<string, number>; busySessionIds: Set<string>; foregroundCommands: Map<string, string> } {
  const [activeCounts, setActiveCounts] = useState<Map<string, number>>(new Map());
  const [busySessionIds, setBusySessionIds] = useState<Set<string>>(new Set());
  const [foregroundCommands, setForegroundCommands] = useState<Map<string, string>>(new Map());
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
        setBusySessionIds((prev) => (prev.size === 0 ? prev : new Set()));
        setForegroundCommands((prev) => (prev.size === 0 ? prev : new Map()));
        return;
      }

      const next = new Map<string, number>();
      const nextBusy = new Set<string>();
      const nextCmds = new Map<string, string>();
      const promises: Promise<void>[] = [];

      for (const tab of tabs) {
        promises.push(
          invoke<string | null>("pty_foreground_command", { sessionId: tab.id })
            .then((cmd) => {
              if (cmd) {
                next.set(tab.directory, (next.get(tab.directory) || 0) + 1);
                nextBusy.add(tab.id);
                nextCmds.set(tab.id, cmd);
              }
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
        setBusySessionIds((prev) => {
          if (prev.size === nextBusy.size && [...prev].every((id) => nextBusy.has(id))) return prev;
          return nextBusy;
        });
        setForegroundCommands((prev) => {
          if (prev.size === nextCmds.size && [...prev].every(([k, v]) => nextCmds.get(k) === v)) return prev;
          return nextCmds;
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

  return { activeCounts, busySessionIds, foregroundCommands };
}
