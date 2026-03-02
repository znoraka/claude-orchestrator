import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Session } from "../types";

interface TitleState {
  lastMessageCount: number;
  lastTitleAt: number; // epoch ms of last title generation
}

/**
 * Watches Claude's conversation JSONL files to extract the first user message
 * and use it as the tab title (phase 1), then generates a smart AI title
 * via `claude -p --model haiku` (phase 2).
 *
 * Also re-triggers title generation when message count grows by 5+ since
 * last generation (evolving titles), with a 2-minute cooldown.
 *
 * Uses file system events (notify crate) instead of polling timers.
 */
export function useConversationTitles(
  sessions: Session[],
  renameSession: (id: string, name: string) => void
) {
  const resolvedRef = useRef<Set<string>>(new Set());
  const smartStateRef = useRef<Map<string, TitleState>>(new Map());
  const smartPendingRef = useRef<Set<string>>(new Set());

  // Register file watchers and listen for changes
  useEffect(() => {
    const pending = sessions.filter(
      (s) =>
        s.claudeSessionId &&
        s.directory &&
        s.status === "running"
    );

    if (pending.length === 0) return;

    // Start watching JSONL files for these sessions
    for (const session of pending) {
      invoke("watch_jsonl", {
        claudeSessionId: session.claudeSessionId,
        directory: session.directory,
      }).catch(() => {});
    }

    // Build a reverse map: claudeSessionId -> session
    const pathToSession = new Map<string, Session>();
    for (const session of pending) {
      pathToSession.set(session.claudeSessionId!, session);
    }

    const triggerSmartTitle = (session: Session, includeRecent: boolean) => {
      if (smartPendingRef.current.has(session.id)) return;

      smartPendingRef.current.add(session.id);
      invoke<string | null>("generate_smart_title", {
        claudeSessionId: session.claudeSessionId,
        directory: session.directory,
        includeRecent,
      })
        .then((title) => {
          smartPendingRef.current.delete(session.id);
          if (title) {
            renameSession(session.id, title);

            // Update state with current message count and timestamp
            invoke<number>("get_message_count", {
              claudeSessionId: session.claudeSessionId,
              directory: session.directory,
            }).then((count) => {
              smartStateRef.current.set(session.id, {
                lastMessageCount: count,
                lastTitleAt: Date.now(),
              });
            }).catch(() => {});
          }
        })
        .catch(() => {
          smartPendingRef.current.delete(session.id);
        });
    };

    const tryResolveTitle = (session: Session) => {
      if (resolvedRef.current.has(session.id)) {
        // Already have initial title — check for evolving title
        const state = smartStateRef.current.get(session.id);
        if (!state) {
          // First smart title generation
          triggerSmartTitle(session, false);
          return;
        }

        // Check cooldown (2 minutes)
        if (Date.now() - state.lastTitleAt < 120_000) return;
        if (smartPendingRef.current.has(session.id)) return;

        // Check if message count grew by 5+
        invoke<number>("get_message_count", {
          claudeSessionId: session.claudeSessionId,
          directory: session.directory,
        })
          .then((count) => {
            const st = smartStateRef.current.get(session.id);
            if (st && count - st.lastMessageCount >= 5) {
              triggerSmartTitle(session, true);
            }
          })
          .catch(() => {});
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
