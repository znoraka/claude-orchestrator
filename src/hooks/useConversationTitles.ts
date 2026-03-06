import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { jsonlDirectory, type Session } from "../types";

interface TitleState {
  titled: true;
}

/**
 * Generates a one-time AI title for sessions using Haiku.
 * Triggers immediately on the first user message (4-5 word title).
 * Once generated, the title is never changed.
 */
export function useConversationTitles(
  sessions: Session[],
  renameSession: (id: string, name: string) => void,
  markTitleGenerated: (id: string) => void
) {
  const smartStateRef = useRef<Map<string, TitleState>>(new Map());
  const smartPendingRef = useRef<Set<string>>(new Set());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Initialize state for sessions that already have a generated title (e.g., on resume)
  // This prevents regenerating titles when resuming a conversation
  useEffect(() => {
    for (const session of sessions) {
      if (session.hasTitleBeenGenerated && !smartStateRef.current.has(session.id)) {
        // Mark as already having a title so we don't regenerate
        smartStateRef.current.set(session.id, { titled: true });
      }
    }
  }, [sessions]);

  // Stable key: only changes when the set of running sessions changes (not on activeTime/name updates)
  const runningKey = sessions.filter((s) => s.status === "running").map((s) => `${s.id}:${s.claudeSessionId ?? ""}`).join(",");
  const runningSessions = useMemo(
    () => sessions.filter((s) => s.claudeSessionId && s.directory && s.status === "running"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runningKey]
  );

  // Register file watchers and listen for changes
  useEffect(() => {
    const pending = runningSessions;

    if (pending.length === 0) return;

    // Start watching JSONL files for these sessions
    for (const session of pending) {
      invoke("watch_jsonl", {
        claudeSessionId: session.claudeSessionId,
        directory: jsonlDirectory(session),
      }).catch(() => {});
    }

    // Build a reverse map: claudeSessionId -> session
    const pathToSession = new Map<string, Session>();
    for (const session of pending) {
      pathToSession.set(session.claudeSessionId!, session);
    }

    const triggerSmartTitle = (session: Session) => {
      if (smartPendingRef.current.has(session.id)) return;

      smartPendingRef.current.add(session.id);
      invoke<string | null>("generate_smart_title", {
        claudeSessionId: session.claudeSessionId,
        directory: jsonlDirectory(session),
      })
        .then((title) => {
          smartPendingRef.current.delete(session.id);
          if (title) {
            renameSession(session.id, title);
            markTitleGenerated(session.id);
            smartStateRef.current.set(session.id, { titled: true });
          }
        })
        .catch(() => {
          smartPendingRef.current.delete(session.id);
        });
    };

    const tryResolveTitle = (session: Session) => {
      if (smartStateRef.current.has(session.id)) return;

      // generate_smart_title returns None if no assistant response yet, so this
      // will naturally retry on subsequent JSONL changes until it succeeds
      triggerSmartTitle(session);
    };

    // Do an initial check for all pending sessions
    for (const session of pending) {
      tryResolveTitle(session);
    }

    // Listen for file change events
    const unlistenPromise = listen<string>("jsonl-changed", (event) => {
      const changedPath = event.payload;
      for (const [sessionId, session] of pathToSession) {
        if (changedPath.includes(sessionId)) {
          tryResolveTitle(session);
          break;
        }
      }
    });

    // Fallback interval for cases where the file doesn't exist yet
    const fallbackInterval = setInterval(() => {
      for (const session of pending) {
        if (!smartStateRef.current.has(session.id)) {
          tryResolveTitle(session);
        }
      }
    }, 5_000);

    return () => {
      unlistenPromise.then((fn) => fn());
      clearInterval(fallbackInterval);
    };
  }, [runningSessions, renameSession, markTitleGenerated]);
}
