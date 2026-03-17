import { memo, useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "../lib/bridge";

interface TitleBarProps {
  workspaceName?: string;
  sessionTitle?: string;
  children?: React.ReactNode;
}

function TitleBar({ workspaceName, sessionTitle, children }: TitleBarProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

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
      {/* Left spacer behind traffic lights */}
      <div style={{ width: "var(--traffic-light-width)", flexShrink: 0 }} />
      {/* Right content */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 5, padding: "0 10px", minWidth: 0 }}>
        {workspaceName && (
          <span style={{
            fontSize: 12,
            color: "var(--text-tertiary)",
            background: "rgba(255,255,255,0.05)",
            borderRadius: 999,
            padding: "0 9px",
            height: 22,
            display: "inline-flex",
            alignItems: "center",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 130,
            flexShrink: 1,
          }}>
            {workspaceName}
          </span>
        )}
        {workspaceName && sessionTitle && (
          <svg width="6" height="10" viewBox="0 0 6 10" fill="none" style={{ flexShrink: 0, opacity: 0.3 }}>
            <path d="M1 1l4 4-4 4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
        {sessionTitle && (
          <span style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            background: "rgba(255,255,255,0.05)",
            borderRadius: 999,
            padding: "0 9px",
            height: 22,
            display: "inline-flex",
            alignItems: "center",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 160,
            flexShrink: 1,
          }}>
            {sessionTitle}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {children}
      </div>
    </div>
  );
}

export default memo(TitleBar);
