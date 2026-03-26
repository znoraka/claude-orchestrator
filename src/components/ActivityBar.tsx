import { memo } from "react";

interface ActivityBarProps {
  activeView: "overview" | "session";
  drawerOpen: boolean;
  activePanel: "prs" | null;
  unreadCount: number;
  onOverview: () => void;
  onToggleSidebar: () => void;
  onSessionsClick: () => void;
  onTogglePRs: () => void;
  isMobile?: boolean;
}

function ActivityIcon({
  active,
  onClick,
  tooltip,
  children,
  isMobile,
}: {
  active?: boolean;
  onClick: () => void;
  tooltip: string;
  children: React.ReactNode;
  isMobile?: boolean;
}) {
  if (isMobile) {
    return (
      <button
        onClick={onClick}
        aria-label={tooltip}
        className={`flex flex-col items-center justify-center flex-1 h-full gap-0.5 transition-colors ${
          active
            ? "text-[var(--accent-color)]"
            : "text-[var(--text-secondary)] active:text-[var(--text-primary)]"
        }`}
      >
        {children}
        <span
          className={`w-1 h-1 rounded-full bg-[var(--accent-color)] transition-opacity ${
            active ? "opacity-100" : "opacity-0"
          }`}
        />
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      data-tooltip={tooltip}
      className={`activity-tooltip relative w-10 h-10 flex items-center justify-center ${
        active
          ? "bg-[var(--accent-color)]/15 text-[var(--accent-color)] border border-[var(--accent-color)]/30"
          : "text-[var(--text-secondary)] hover:text-[var(--accent-color)] hover:bg-white/5"
      }`}
    >
      {children}
      <span className={`absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[var(--accent-color)] ${active ? "opacity-100" : "opacity-0"}`} />
    </button>
  );
}

const SessionsIcon = ({ size }: { size: number }) => (
  <svg style={{ width: size, height: size }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
  </svg>
);

export default memo(function ActivityBar({
  activeView,
  drawerOpen,
  activePanel,
  unreadCount,
  onOverview,
  onToggleSidebar,
  onSessionsClick,
  onTogglePRs,
  isMobile,
}: ActivityBarProps) {
  if (isMobile) {
    return (
      <div
        className="flex items-stretch shrink-0 border-t-2 border-[var(--border-color)]"
        style={{
          height: "var(--mobile-nav-height, 56px)",
          background: "var(--activity-bar-bg)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        {/* Sidebar toggle */}
        <ActivityIcon
          active={drawerOpen}
          onClick={onToggleSidebar}
          tooltip="Sessions list"
          isMobile
        >
          <svg style={{ width: 22, height: 22 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </ActivityIcon>

        {/* Overview */}
        <ActivityIcon
          active={activeView === "overview" && activePanel === null && !drawerOpen}
          onClick={onOverview}
          tooltip="Overview"
          isMobile
        >
          <svg style={{ width: 22, height: 22 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
        </ActivityIcon>

        {/* Sessions */}
        <ActivityIcon
          active={activeView === "session" && activePanel === null && !drawerOpen}
          onClick={onSessionsClick}
          tooltip="Current session"
          isMobile
        >
          <span className="relative">
            <SessionsIcon size={22} />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[var(--accent)] text-white text-[8px] flex items-center justify-center font-bold">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </span>
        </ActivityIcon>

        {/* PRs */}
        <ActivityIcon
          active={activePanel === "prs"}
          onClick={onTogglePRs}
          tooltip="Pull Requests"
          isMobile
        >
          <svg style={{ width: 22, height: 22 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
        </ActivityIcon>

      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-center py-2 px-1 gap-0.5 shrink-0 border-r-2 border-[var(--border-color)]"
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
              <SessionsIcon size={18} />
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-[var(--accent)] text-white text-[8px] flex items-center justify-center font-bold">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            </span>
          ) : (
            <SessionsIcon size={18} />
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



      </div>
    </div>
  );
});
