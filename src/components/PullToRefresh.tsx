import { useRef, useCallback, useEffect, useState } from "react";

const THRESHOLD = 80;
const MAX_PULL = 120;

/**
 * Adds a pull-to-refresh gesture on touch devices.
 * Renders an indicator at the top of the screen and reloads the page when pulled past threshold.
 */
export default function PullToRefresh({ children }: { children: React.ReactNode }) {
  const startY = useRef(0);
  const pulling = useRef(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [releasing, setReleasing] = useState(false);

  const onTouchStart = useCallback((e: TouchEvent) => {
    // Only activate when at the very top of the page (no scrollable ancestor is scrolled)
    if (window.scrollY > 0) return;
    // Check if any scrollable parent is scrolled
    let el = e.target as HTMLElement | null;
    while (el && el !== document.body) {
      if (el.scrollTop > 0) return;
      el = el.parentElement;
    }
    startY.current = e.touches[0].clientY;
    pulling.current = true;
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
    if (!pulling.current) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy < 0) {
      setPullDistance(0);
      return;
    }
    // Dampen the pull
    const dampened = Math.min(dy * 0.4, MAX_PULL);
    setPullDistance(dampened);
  }, []);

  const onTouchEnd = useCallback(() => {
    if (!pulling.current) return;
    pulling.current = false;
    if (pullDistance >= THRESHOLD * 0.4) {
      setReleasing(true);
      setPullDistance(THRESHOLD * 0.4);
      setTimeout(() => window.location.reload(), 300);
    } else {
      setPullDistance(0);
    }
  }, [pullDistance]);

  useEffect(() => {
    // Only enable on touch devices
    if (!("ontouchstart" in window)) return;
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [onTouchStart, onTouchMove, onTouchEnd]);

  const progress = Math.min(pullDistance / (THRESHOLD * 0.4), 1);
  const showIndicator = pullDistance > 4;

  return (
    <>
      {showIndicator && (
        <div
          className="fixed left-1/2 z-[100] flex items-center justify-center pointer-events-none"
          style={{
            top: pullDistance - 20,
            transform: "translateX(-50%)",
            opacity: progress,
            transition: pulling.current ? "none" : "all 0.3s ease-out",
          }}
        >
          <div
            className="w-8 h-8 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-color)] shadow-lg flex items-center justify-center"
          >
            {releasing ? (
              <div className="w-4 h-4 rounded-full border-2 border-[var(--text-tertiary)] border-t-[var(--text-primary)] animate-spin" />
            ) : (
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                className="text-[var(--text-secondary)]"
                style={{
                  transform: `rotate(${progress * 180}deg)`,
                  transition: pulling.current ? "none" : "transform 0.3s ease-out",
                }}
              >
                <path d="M12 5v14M5 12l7-7 7 7" />
              </svg>
            )}
          </div>
        </div>
      )}
      {children}
    </>
  );
}
