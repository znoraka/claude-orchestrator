import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Session } from "../types";

/**
 * Watches Claude's conversation JSONL files to extract the first user message
 * and use it as the tab title (phase 1), then generates a smart AI title
 * via `claude -p --model haiku` (phase 2).
 *
 * Uses file system events (notify crate) instead of polling timers.
 */
export function useConversationTitles(
  sessions: Session[],
  renameSession: (id: string, name: string) => void
) {
  const resolvedRef = useRef<Set<string>>(new Set());
  const smartResolvedRef = useRef<Set<string>>(new Set());
  const smartPendingRef = useRef<Set<string>>(new Set());

  // Register file watchers and listen for changes
  useEffect(() => {
    const pending = sessions.filter(
      (s) =>
        s.claudeSessionId &&
        s.directory &&
        s.status === "running" &&
        !smartResolvedRef.current.has(s.id)
    );

    if (pending.length === 0) return;

    // Start watching JSONL files for these sessions
    for (const session of pending) {
      invoke("watch_jsonl", {
        claudeSessionId: session.claudeSessionId,
        directory: session.directory,
      }).catch(() => {});
    }

    // Build a reverse map: claudeSessionId -> session (match by session ID in filename)
    const pathToSession = new Map<string, Session>();
    for (const session of pending) {
      pathToSession.set(session.claudeSessionId!, session);
    }

    const tryResolveTitle = (session: Session) => {
      if (resolvedRef.current.has(session.id)) {
        // Phase 2: smart title
        if (
          smartResolvedRef.current.has(session.id) ||
          smartPendingRef.current.has(session.id)
        )
          return;

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
        return;
      }

      // Phase 1: extract first user message
      if (!/^Session \d+$/.test(session.name)) {
        resolvedRef.current.add(session.id);
        return;
      }

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
    };

    // Do an initial check for all pending sessions
    for (const session of pending) {
      tryResolveTitle(session);
    }

    // Listen for file change events
    const unlistenPromise = listen<string>("jsonl-changed", (event) => {
      const changedPath = event.payload;
      // Match by session ID in the filename
      for (const [sessionId, session] of pathToSession) {
        if (changedPath.includes(sessionId)) {
          tryResolveTitle(session);
          break;
        }
      }
    });

    // Also set a fallback interval for cases where the file doesn't exist yet
    // (watcher can't watch a non-existent file's parent if the project dir doesn't exist)
    const fallbackInterval = setInterval(() => {
      for (const session of pending) {
        if (!resolvedRef.current.has(session.id)) {
          tryResolveTitle(session);
        }
      }
    }, 5000);

    return () => {
      unlistenPromise.then((fn) => fn());
      clearInterval(fallbackInterval);
    };
  }, [sessions, renameSession]);
}
