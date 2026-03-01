import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../types";

/**
 * Polls Claude's conversation JSONL files to extract the first user message
 * and use it as the tab title (phase 1), then generates a smart AI title
 * via `claude -p --model haiku` (phase 2).
 */
export function useConversationTitles(
  sessions: Session[],
  renameSession: (id: string, name: string) => void
) {
  const resolvedRef = useRef<Set<string>>(new Set());
  const smartResolvedRef = useRef<Set<string>>(new Set());
  const smartPendingRef = useRef<Set<string>>(new Set());

  // Phase 1: extract first user message as title
  useEffect(() => {
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

    tryResolve();
    const interval = setInterval(tryResolve, 1000);

    return () => clearInterval(interval);
  }, [sessions, renameSession]);

  // Phase 2: generate smart AI title
  useEffect(() => {
    const pending = sessions.filter(
      (s) =>
        s.claudeSessionId &&
        s.directory &&
        resolvedRef.current.has(s.id) &&
        !smartResolvedRef.current.has(s.id) &&
        !smartPendingRef.current.has(s.id)
    );

    if (pending.length === 0) return;

    const trySmartResolve = () => {
      for (const session of pending) {
        if (
          smartResolvedRef.current.has(session.id) ||
          smartPendingRef.current.has(session.id)
        )
          continue;
        // Must have passed phase 1 (no longer "Session N")
        if (!resolvedRef.current.has(session.id)) continue;

        smartPendingRef.current.add(session.id);

        invoke<string | null>("generate_smart_title", {
          claudeSessionId: session.claudeSessionId,
          directory: session.directory,
        })
          .then((title) => {
            smartPendingRef.current.delete(session.id);
            if (title) {
              smartResolvedRef.current.add(session.id);
              renameSession(session.id, title);
            }
          })
          .catch(() => {
            smartPendingRef.current.delete(session.id);
          });
      }
    };

    trySmartResolve();
    const interval = setInterval(trySmartResolve, 3000);

    return () => clearInterval(interval);
  }, [sessions, renameSession]);
}
