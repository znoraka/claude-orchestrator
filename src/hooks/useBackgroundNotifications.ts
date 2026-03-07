import { useEffect, useRef } from "react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { Session, SessionUsage } from "../types";

/**
 * Sends an OS notification when a non-active session transitions from
 * busy (isBusy=true) to idle (isBusy=false), meaning Claude finished
 * responding while the user was looking at a different tab.
 */
export function useBackgroundNotifications(
  sessions: Session[],
  sessionUsage: Map<string, SessionUsage>,
  activeSessionId: string | null
) {
  const prevBusyRef = useRef<Map<string, boolean>>(new Map());
  const prevQuestionRef = useRef<Map<string, boolean>>(new Map());
  const permissionRef = useRef<boolean | null>(null);

  // Request permission once
  useEffect(() => {
    (async () => {
      let granted = await isPermissionGranted();
      if (!granted) {
        const result = await requestPermission();
        granted = result === "granted";
      }
      permissionRef.current = granted;
    })();
  }, []);

  useEffect(() => {
    if (permissionRef.current === false) return;

    for (const session of sessions) {
      const usage = sessionUsage.get(session.id);
      const wasBusy = prevBusyRef.current.get(session.id) ?? false;
      const isBusy = usage?.isBusy ?? false;

      // Detect busy -> idle transition for non-active sessions
      if (
        wasBusy &&
        !isBusy &&
        session.id !== activeSessionId &&
        session.status === "running"
      ) {
        sendNotification({
          title: "Claude finished",
          body: session.name,
        });
      }

      // Detect hasQuestion false -> true transition for non-active sessions
      const hadQuestion = prevQuestionRef.current.get(session.id) ?? false;
      const hasQuestion = session.hasQuestion ?? false;
      if (
        !hadQuestion &&
        hasQuestion &&
        session.id !== activeSessionId &&
        (session.status === "running" || session.status === "starting")
      ) {
        sendNotification({
          title: "Claude has a question",
          body: session.name,
        });
      }

      prevBusyRef.current.set(session.id, isBusy);
      prevQuestionRef.current.set(session.id, hasQuestion);
    }
  }, [sessions, sessionUsage, activeSessionId]);
}
