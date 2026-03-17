import { memo } from "react";

export type SessionStatus = "running" | "starting" | "waiting" | "stopped" | "error";

interface Props {
  status: SessionStatus;
  size?: "sm" | "md";
}

export default memo(function SessionStatusBadge({ status, size = "sm" }: Props) {
  const dotSize = size === "md" ? "w-2.5 h-2.5" : "w-2 h-2";

  if (status === "running") {
    return (
      <span
        className={`${dotSize} rounded-full bg-[var(--status-running)] animate-green-ring shrink-0`}
        title="Running"
      />
    );
  }
  if (status === "starting") {
    return (
      <span
        className={`${dotSize} rounded-full border-2 border-[var(--accent-color)] border-t-transparent animate-spin shrink-0`}
        style={{ width: size === "md" ? 10 : 8, height: size === "md" ? 10 : 8 }}
        title="Starting"
      />
    );
  }
  if (status === "waiting") {
    return (
      <span
        className={`${dotSize} rounded-full bg-[var(--status-waiting)] animate-amber-pulse shrink-0`}
        title="Needs input"
      />
    );
  }
  if (status === "error") {
    return (
      <span
        className={`${dotSize} rounded-full bg-[var(--danger)] shrink-0`}
        title="Error"
      />
    );
  }
  // stopped
  return (
    <span
      className={`${dotSize} rounded-full bg-[var(--status-stopped)] shrink-0`}
      title="Stopped"
    />
  );
});
