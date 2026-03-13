import { useRef, useState, useCallback, useEffect } from "react";

export function useScrollManager(isActive: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const savedScrollRef = useRef<number | null>(null);
  const savedIsAtBottomRef = useRef<boolean | null>(null);
  const wasActiveRef = useRef(isActive);

  const scrollToBottom = useCallback(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  }, []);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 100;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  }, []);

  // Save/restore scroll position on tab switch
  useEffect(() => {
    if (!isActive && wasActiveRef.current && scrollRef.current) {
      savedScrollRef.current = scrollRef.current.scrollTop;
      savedIsAtBottomRef.current = isAtBottomRef.current;
    }
    if (isActive && !wasActiveRef.current && scrollRef.current && savedScrollRef.current !== null) {
      scrollRef.current.scrollTop = savedScrollRef.current;
      savedScrollRef.current = null;
      if (savedIsAtBottomRef.current !== null) {
        isAtBottomRef.current = savedIsAtBottomRef.current;
        setIsAtBottom(savedIsAtBottomRef.current);
        savedIsAtBottomRef.current = null;
      }
    }
    wasActiveRef.current = isActive;
  }, [isActive]);

  return {
    scrollRef,
    isAtBottomRef,
    isAtBottom,
    scrollToBottom,
    handleScroll,
  };
}
