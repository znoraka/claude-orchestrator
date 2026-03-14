import { memo, useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, padding: "0 12px", minWidth: 0 }}>
        {workspaceName && (
          <span style={{ fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
            {workspaceName}
          </span>
        )}
        {workspaceName && sessionTitle && (
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>/</span>
        )}
        {sessionTitle && (
          <span style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
