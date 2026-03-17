import { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect, useDeferredValue } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatMessage } from "../types";
import { mergeToolOnlyMessages } from "../constants";

const INITIAL_WINDOW = 40;
const LOAD_MORE_CHUNK = 40;
const VIRTUAL_THRESHOLD = 20;

export function useVirtualMessages(
  messages: ChatMessage[],
  isActive: boolean,
  sessionId: string,
  scrollRef: React.RefObject<HTMLDivElement | null>,
  isGenerating: boolean = false
) {
  const [renderCount, setRenderCount] = useState(INITIAL_WINDOW);
  const [isLayoutReady, setIsLayoutReady] = useState(true);
  const layoutCheckRafRef = useRef<number | null>(null);
  const layoutSettleRef = useRef<{ lastSig: string; stable: number; frames: number }>({
    lastSig: "", stable: 0, frames: 0,
  });
  const prevSessionIdRef = useRef(sessionId);
  const prevUseVirtualRef = useRef(false);
  const prevMsgLenRef = useRef(0);

  // Reset window on bulk load
  useEffect(() => {
    if (messages.length - prevMsgLenRef.current > LOAD_MORE_CHUNK) {
      setRenderCount(INITIAL_WINDOW);
      if (isActive && messages.length > 0) {
        setIsLayoutReady(false);
      }
    }
    prevMsgLenRef.current = messages.length;
  }, [messages.length, isActive]);

  const visibleMessages = useMemo(() => {
    const sliced = messages.length <= renderCount ? messages : messages.slice(messages.length - renderCount);
    return mergeToolOnlyMessages(sliced);
  }, [messages, renderCount]);

  const hasMore = messages.length > renderCount;

  const deferredMessages = useDeferredValue(visibleMessages);
  const trailingMessages = useMemo(() => {
    if (deferredMessages === visibleMessages) return [];
    const deferredIds = new Set(deferredMessages.map((m) => m.id));
    const trailing: typeof visibleMessages = [];
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (deferredIds.has(visibleMessages[i].id)) break;
      trailing.unshift(visibleMessages[i]);
    }
    return trailing;
  }, [deferredMessages, visibleMessages]);

  const allMessages = useMemo(
    () => [...deferredMessages, ...trailingMessages],
    [deferredMessages, trailingMessages],
  );

  const useVirtualRendering = allMessages.length >= VIRTUAL_THRESHOLD && !isGenerating;

  const estimateItemSize = useMemo(() => {
    const sizeCache = new Map<string, number>();
    return (index: number): number => {
      const cachedSize = sizeCache.get(`index-${index}`);
      if (cachedSize !== undefined) return cachedSize;
      const message = allMessages[index];
      if (!message) return 80;
      let estimatedSize = 80;
      switch (message.type) {
        case "user": estimatedSize = 60; break;
        case "assistant": {
          let size = 80;
          if (message.content && Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === "thinking") size += 60;
              else if (block.type === "tool_use") size += 100;
              else if (block.type === "tool_result") size += 80;
              else if (block.type === "text" && block.text) {
                size += Math.min(600, Math.ceil(block.text.length / 60) * 20);
              }
            }
          }
          estimatedSize = Math.min(size, 1500);
          break;
        }
        case "system": estimatedSize = 30; break;
        case "result": estimatedSize = 50; break;
        case "error": estimatedSize = 40; break;
        default: estimatedSize = 80;
      }
      sizeCache.set(`index-${index}`, estimatedSize);
      return estimatedSize;
    };
  }, [allMessages]);

  const adaptiveOverscan = useMemo(() => {
    if (!scrollRef.current) return 8;
    const viewportHeight = scrollRef.current.clientHeight;
    if (viewportHeight === 0) return 8;
    let totalEstimatedSize = 0;
    let count = 0;
    for (let i = 0; i < Math.min(allMessages.length, 20); i++) {
      const estimatedSize = estimateItemSize(i);
      if (estimatedSize > 0) { totalEstimatedSize += estimatedSize; count++; }
    }
    const averageItemSize = count > 0 ? totalEstimatedSize / count : 80;
    const targetOverscanHeight = viewportHeight * 3.5;
    const calculatedOverscan = Math.max(3, Math.floor(targetOverscanHeight / averageItemSize));
    return Math.min(Math.max(calculatedOverscan, 3), 15);
  }, [scrollRef.current, allMessages, estimateItemSize]);

  const estimateItemSizeRef = useRef(estimateItemSize);
  estimateItemSizeRef.current = estimateItemSize;

  const measureElementCache = useCallback((el: Element | null): number => {
    if (!el) return 0;
    const height = el.getBoundingClientRect().height;
    if (height === 0) {
      const index = Number((el as HTMLElement).dataset?.index ?? -1);
      return index >= 0 ? estimateItemSizeRef.current(index) : 80;
    }
    return height;
  }, []); // stable — no deps

  const rowVirtualizer = useVirtualizer({
    count: useVirtualRendering ? allMessages.length : 0,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index: number) => allMessages[index]?.id ?? index.toString(),
    estimateSize: estimateItemSize,
    overscan: adaptiveOverscan,
    useFlushSync: false,
    measureElement: measureElementCache,
  });

  const virtualizerTotalSize = rowVirtualizer.getTotalSize();
  const virtualItems = useVirtualRendering ? rowVirtualizer.getVirtualItems() : [];

  useEffect(() => { rowVirtualizer.measure(); }, [sessionId, rowVirtualizer]);

  useLayoutEffect(() => {
    if (!useVirtualRendering || !isActive) return;
    rowVirtualizer.measure();
  }, [useVirtualRendering, isActive, sessionId, rowVirtualizer]);

  useLayoutEffect(() => {
    const sessionChanged = prevSessionIdRef.current !== sessionId;
    const virtualEnabled = useVirtualRendering && !prevUseVirtualRef.current;
    if ((sessionChanged || virtualEnabled) && isActive && messages.length > 0) {
      setIsLayoutReady(false);
    }
    prevSessionIdRef.current = sessionId;
    prevUseVirtualRef.current = useVirtualRendering;
  }, [sessionId, useVirtualRendering, isActive, messages.length]);

  useEffect(() => {
    if (!isActive || messages.length === 0) setIsLayoutReady(true);
  }, [isActive, messages.length]);

  useLayoutEffect(() => {
    if (isLayoutReady || !isActive || messages.length === 0) return;
    layoutSettleRef.current = { lastSig: "", stable: 0, frames: 0 };

    const check = () => {
      let sig = "";
      if (useVirtualRendering) {
        const items = rowVirtualizer.getVirtualItems();
        if (items.length === 0) {
          sig = "empty";
        } else {
          sig = items.map((i) => `${i.index}:${Math.round(i.start)}:${Math.round(i.size)}`).join("|") +
            `|total:${Math.round(rowVirtualizer.getTotalSize())}`;
        }
      } else {
        const scrollEl = scrollRef.current;
        const h = scrollEl?.scrollHeight ?? 0;
        const c = scrollEl?.clientHeight ?? 0;
        sig = `h:${Math.round(h)}|c:${Math.round(c)}`;
      }
      const settle = layoutSettleRef.current;
      if (sig && sig === settle.lastSig) { settle.stable += 1; }
      else { settle.lastSig = sig; settle.stable = 0; }
      settle.frames += 1;
      if (settle.stable >= 2 || settle.frames >= 12) { setIsLayoutReady(true); return; }
      layoutCheckRafRef.current = requestAnimationFrame(check);
    };

    layoutCheckRafRef.current = requestAnimationFrame(check);
    return () => {
      if (layoutCheckRafRef.current) {
        cancelAnimationFrame(layoutCheckRafRef.current);
        layoutCheckRafRef.current = null;
      }
    };
  }, [isLayoutReady, isActive, messages.length, useVirtualRendering, rowVirtualizer]);

  const loadMore = useCallback(() => {
    setRenderCount((prev) => Math.min(prev + LOAD_MORE_CHUNK, messages.length));
  }, [messages.length]);


  return {
    allMessages,
    hasMore,
    loadMore,
    useVirtualRendering,
    isLayoutReady,
    rowVirtualizer,
    virtualizerTotalSize,
    virtualItems,
    deferredMessages,
    trailingMessages,
  };
}
