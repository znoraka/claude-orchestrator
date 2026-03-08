import { useEffect, useRef } from "react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { Session, SessionUsage } from "../types";
import { playDoneSound, playQuestionSound } from "../utils/notificationSound";
import { useAppVisible } from "./useAppVisible";

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
  const appVisible = useAppVisible();
  const prevBusyRef = useRef<Map<string, boolean>>(new Map());
  const prevQuestionRef = useRef<Map<string, boolean>>(new Map());
  const prevActiveRef = useRef<string | null>(null);
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

      // For child sessions, attribute notifications to the parent
      const parentId = session.parentSessionId;
      const parent = parentId ? sessions.find((s) => s.id === parentId) : null;
      const notifName = parent ? parent.name : session.name;
      // The "effective active" ID is the parent if this is a child of the active session
      const effectiveActiveId = parentId === activeSessionId ? activeSessionId : session.id;

      // Detect busy -> idle transition
      // Skip if this session was the active one last tick (user just switched away, e.g. plan fork)
      if (
        wasBusy &&
        !isBusy &&
        session.id !== prevActiveRef.current &&
        session.status === "running"
      ) {
        // For child sessions: suppress if parent is the active session and app is visible
        if (effectiveActiveId !== activeSessionId || !appVisible) {
          sendNotification({
            title: "Claude finished",
            body: notifName,
          });
        }
        playDoneSound();
      }

      // Detect hasQuestion false -> true transition for non-active sessions
      const hadQuestion = prevQuestionRef.current.get(session.id) ?? false;
      const hasQuestion = session.hasQuestion ?? false;
      if (
        !hadQuestion &&
        hasQuestion &&
        (session.status === "running" || session.status === "starting")
      ) {
        if (effectiveActiveId !== activeSessionId || !appVisible) {
          sendNotification({
            title: "Claude has a question",
            body: notifName,
          });
        }
        playQuestionSound();
      }

      prevBusyRef.current.set(session.id, isBusy);
      prevQuestionRef.current.set(session.id, hasQuestion);
    }

    prevActiveRef.current = activeSessionId;
  }, [sessions, sessionUsage, activeSessionId, appVisible]);
}
