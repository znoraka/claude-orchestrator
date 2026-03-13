import { useRef, useCallback, useEffect } from "react";
import type { ContentBlock, ChatMessage } from "../types";

const STREAM_THROTTLE_MS = 50;

export interface StreamAccumulator {
  pendingStreamRef: React.MutableRefObject<{ id: string; content: ContentBlock[] } | null>;
  accumulatedBlocksRef: React.MutableRefObject<Map<string, ContentBlock[]>>;
  currentStreamIdRef: React.MutableRefObject<string | null>;
  flushPendingStream: () => void;
  scheduleFlush: () => void;
}

export function useStreamAccumulator(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
): StreamAccumulator {
  const pendingStreamRef = useRef<{ id: string; content: ContentBlock[] } | null>(null);
  const accumulatedBlocksRef = useRef<Map<string, ContentBlock[]>>(new Map());
  const rafIdRef = useRef<number | null>(null);
  const lastFlushRef = useRef<number>(0);
  const currentStreamIdRef = useRef<string | null>(null);

  const flushPendingStream = useCallback(() => {
    rafIdRef.current = null;
    const pending = pendingStreamRef.current;
    if (!pending) return;
    pendingStreamRef.current = null;
    lastFlushRef.current = Date.now();

    const accumulated = accumulatedBlocksRef.current.get(pending.id) || [];

    setMessages((prev) => {
      const existingIndex = prev.findIndex(
        (m) => m.type === "assistant" && m.id === pending.id
      );
      if (existingIndex !== -1) {
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          content: accumulated,
        };
        return updated;
      }
      const filtered = prev.filter((m) => !m.isStreaming);
      return [
        ...filtered,
        {
          id: pending.id,
          type: "assistant",
          content: accumulated,
          timestamp: Date.now(),
        },
      ];
    });
  }, [setMessages]);

  const scheduleFlush = useCallback(() => {
    const now = Date.now();
    if (now - lastFlushRef.current >= STREAM_THROTTLE_MS) {
      flushPendingStream();
    } else if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(flushPendingStream);
    }
  }, [flushPendingStream]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  return {
    pendingStreamRef,
    accumulatedBlocksRef,
    currentStreamIdRef,
    flushPendingStream,
    scheduleFlush,
  };
}
