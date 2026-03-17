import { useEffect, useMemo, useRef } from "react";
import { invoke } from "../lib/bridge";
import { listen } from "../lib/bridge";
import { jsonlDirectory, type Session } from "../types";
import { useAppVisible } from "./useAppVisible";

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
  const retryCountRef = useRef<Map<string, number>>(new Map());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const appVisible = useAppVisible();

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
    () => sessions.filter((s) => s.claudeSessionId && s.directory && s.status === "running" && s.provider !== "opencode"),
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
          } else {
            const count = (retryCountRef.current.get(session.id) ?? 0) + 1;
            retryCountRef.current.set(session.id, count);
            if (count >= 3) {
              smartStateRef.current.set(session.id, { titled: true });
            }
          }
        })
        .catch(() => {
          smartPendingRef.current.delete(session.id);
          // Errors are transient (e.g. title server still starting up) — don't count toward the
          // retry limit. The JSONL file watcher and 5s fallback will trigger another attempt.
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

    // Listen for file change events (debounced per session: coalesce rapid writes)
    const titleDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const unlistenPromise = listen<string>("jsonl-changed", (event) => {
      const changedPath = event.payload;
      for (const [sessionId, session] of pathToSession) {
        if (changedPath.includes(sessionId)) {
          const prev = titleDebounceTimers.get(session.id);
          if (prev) clearTimeout(prev);
          titleDebounceTimers.set(
            session.id,
            setTimeout(() => {
              titleDebounceTimers.delete(session.id);
              tryResolveTitle(session);
            }, 500)
          );
          break;
        }
      }
    });

    // Fallback interval for cases where the file doesn't exist yet (only when visible)
    const fallbackInterval = appVisible
      ? setInterval(() => {
          for (const session of pending) {
            if (!smartStateRef.current.has(session.id)) {
              tryResolveTitle(session);
            }
          }
        }, 5_000)
      : null;

    return () => {
      unlistenPromise.then((fn) => fn());
      if (fallbackInterval) clearInterval(fallbackInterval);
      for (const t of titleDebounceTimers.values()) clearTimeout(t);
      titleDebounceTimers.clear();
    };
  }, [runningSessions, renameSession, markTitleGenerated, appVisible]);
}
