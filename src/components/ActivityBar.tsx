import { memo } from "react";

interface ActivityBarProps {
  activeView: "overview" | "session";
  drawerOpen: boolean;
  activePanel: "prs" | "shell" | null;
  totalCostToday: number;
  unreadCount: number;
  onOverview: () => void;
  onToggleSidebar: () => void;
  onSessionsClick: () => void;
  onTogglePRs: () => void;
  onToggleShell: () => void;
  onNewSession: () => void;
  onShowUsage: () => void;
  onOpenInEditor: () => void;
}

function ActivityIcon({
  active,
  onClick,
  tooltip,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  tooltip: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      data-tooltip={tooltip}
      className={`activity-tooltip relative w-10 h-10 flex items-center justify-center rounded-xl ${
        active
          ? "bg-[var(--accent)]/20 text-[var(--accent)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-white/5"
      }`}
    >
      {children}
      <span className={`absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-r bg-[var(--accent)] ${active ? "opacity-100" : "opacity-0"}`} />
    </button>
  );
}

export default memo(function ActivityBar({
  activeView,
  drawerOpen,
  activePanel,
  totalCostToday,
  unreadCount,
  onOverview,
  onToggleSidebar,
  onSessionsClick,
  onTogglePRs,
  onToggleShell,
  onNewSession,
  onShowUsage,
  onOpenInEditor,
}: ActivityBarProps) {
  const costLabel = totalCostToday >= 1
    ? `$${totalCostToday.toFixed(2)}`
    : totalCostToday >= 0.01
    ? `$${totalCostToday.toFixed(2)}`
    : totalCostToday > 0
    ? "<$0.01"
    : "$0.00";

  return (
    <div
      className="flex flex-col items-center py-2 px-1 gap-0.5 shrink-0 border-r border-[var(--border-subtle)]"
      style={{ width: 48, background: "var(--activity-bar-bg)" }}
    >
      {/* Top group */}
      <div className="flex flex-col items-center gap-0.5 flex-1">
        {/* Sidebar toggle */}
        <ActivityIcon
          active={false}
          onClick={onToggleSidebar}
          tooltip="Toggle Sidebar (⌘B)"
        >
          <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </ActivityIcon>

        {/* Overview */}
        <ActivityIcon
          active={activeView === "overview" && activePanel === null}
          onClick={onOverview}
          tooltip="Overview (⌘0)"
        >
          <svg className="w-4.5 h-4.5" style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
        </ActivityIcon>

        {/* Sessions */}
        <ActivityIcon
          active={drawerOpen && activeView === "session" && activePanel === null}
          onClick={onSessionsClick}
          tooltip="Sessions (⌘J)"
        >
          {unreadCount > 0 ? (
            <span className="relative">
              <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-[var(--accent)] text-white text-[8px] flex items-center justify-center font-bold">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            </span>
          ) : (
            <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
            </svg>
          )}
        </ActivityIcon>

        {/* PRs */}
        <ActivityIcon
          active={activePanel === "prs"}
          onClick={onTogglePRs}
          tooltip="Pull Requests (⌘P)"
        >
          <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
        </ActivityIcon>

        {/* Shell */}
        <ActivityIcon
          active={activePanel === "shell"}
          onClick={onToggleShell}
          tooltip="Shell (⌘T)"
        >
          <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
        </ActivityIcon>


      </div>

      {/* Bottom group */}
      <div className="flex flex-col items-center gap-0.5">
        {/* Open in Editor */}
        <ActivityIcon onClick={onOpenInEditor} tooltip="Open in Editor (⌘E)">
          <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
          </svg>
        </ActivityIcon>

        {/* New Session */}
        <ActivityIcon onClick={onNewSession} tooltip="New Session (⌘N)">
          <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </ActivityIcon>

        {/* Cost badge / Usage */}
        <button
          onClick={onShowUsage}
          data-tooltip="Usage stats"
          className="activity-tooltip relative w-10 flex flex-col items-center justify-center py-1.5 rounded-xl transition-all duration-150 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-white/5"
        >
          <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
          </svg>
        </button>
      </div>
    </div>
  );
});
