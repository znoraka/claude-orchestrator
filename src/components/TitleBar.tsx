import { memo, useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "../lib/bridge";
import { useMobileLayout } from "../hooks/useMobileLayout";

interface TitleBarProps {
  sessionTitle?: string;
  children?: React.ReactNode;
}

function TitleBar({ sessionTitle, children }: TitleBarProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showFullTitle, setShowFullTitle] = useState(false);
  const isMobile = useMobileLayout();

  useEffect(() => {
    const win = getCurrentWindow();
    win.isFullscreen().then(setIsFullscreen).catch(() => {});
    const unlisten = win.onResized(async () => {
      try {
        setIsFullscreen(await win.isFullscreen());
      } catch {}
    });
    return () => { unlisten.then((fn) => fn()).catch(() => {}); };
  }, []);

  useEffect(() => {
    if (!showFullTitle) return;
    const handle = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-title-popover]")) {
        setShowFullTitle(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [showFullTitle]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, a, input, [data-no-drag]")) return;
    getCurrentWindow().startDragging().catch(() => {});
  }, []);

  if (isFullscreen) return null;

  return (
    <div
      data-tauri-drag-region
      onMouseDown={handleMouseDown}
      style={{
        height: "var(--titlebar-height)",
        background: "var(--activity-bar-bg)",
        borderBottom: "1px solid var(--border-subtle)",
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
        cursor: "default",
      }}
    >
      {/* Left spacer behind traffic lights — only needed in Tauri desktop */}
      {!isMobile && <div style={{ width: "var(--traffic-light-width)", flexShrink: 0 }} />}
      {/* Right content */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 5, padding: "0 10px", minWidth: 0 }}>
        {sessionTitle && (
          <div style={{ position: "relative", minWidth: 0, flexShrink: 1 }} data-title-popover>
            <button
              data-no-drag
              onClick={() => setShowFullTitle((v) => !v)}
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                background: "rgba(255,255,255,0.05)",
                border: "none",
                borderRadius: 999,
                padding: "0 9px",
                height: 22,
                display: "inline-flex",
                alignItems: "center",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
                maxWidth: "100%",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {sessionTitle}
            </button>
            {showFullTitle && (
              <div style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                background: "#1a1a1a",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 14,
                color: "var(--text-primary)",
                whiteSpace: "nowrap",
                zIndex: 300,
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                maxWidth: "80vw",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}>
                {sessionTitle}
              </div>
            )}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 8 }} />
        {children}
      </div>
    </div>
  );
}

export default memo(TitleBar);
