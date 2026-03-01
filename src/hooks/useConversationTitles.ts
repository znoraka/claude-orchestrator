import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../types";

/**
 * Polls Claude's conversation JSONL files to extract the first user message
 * and use it as the tab title. Only updates sessions that still have their
 * auto-generated "Session N" name.
 */
export function useConversationTitles(
  sessions: Session[],
  renameSession: (id: string, name: string) => void
) {
  const resolvedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Find sessions that need a title: running, have a claudeSessionId,
    // and still have the default auto-generated name
    const pending = sessions.filter(
      (s) =>
        s.claudeSessionId &&
        s.directory &&
        !resolvedRef.current.has(s.id) &&
        /^Session \d+$/.test(s.name)
    );

    if (pending.length === 0) return;

    const tryResolve = () => {
      for (const session of pending) {
        if (resolvedRef.current.has(session.id)) continue;

        invoke<string | null>("get_conversation_title", {
          claudeSessionId: session.claudeSessionId,
          directory: session.directory,
        })
          .then((title) => {
            if (title) {
              resolvedRef.current.add(session.id);
              renameSession(session.id, title);
            }
          })
          .catch(() => {});
      }
    };

    // Check immediately, then poll every second
    tryResolve();
    const interval = setInterval(tryResolve, 1000);

    return () => clearInterval(interval);
  }, [sessions, renameSession]);
}
