import { useState, useRef } from "react";

interface InlinePermissionComposerProps {
  permission: { toolName: string; input: Record<string, unknown> };
  onAllow: () => void;
  onDeny: () => void;
  onAllowInNew: () => void;
  onFeedback: (text: string) => void;
}

export function InlinePermissionComposer({
  permission, onAllow, onDeny, onAllowInNew, onFeedback,
}: InlinePermissionComposerProps) {
  const isExitPlan = permission.toolName === "ExitPlanMode";
  const [feedback, setFeedback] = useState("");
  const feedbackRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-[var(--text-secondary)]">
        {isExitPlan ? "Plan ready — how do you want to proceed?" : "Permission requested"}
      </div>
      {!isExitPlan && (
        <div className="text-sm text-[var(--text-primary)] font-mono truncate">
          {permission.toolName}
          {permission.input?.command != null && (
            <span className="text-[var(--text-tertiary)] ml-1">{String(permission.input.command).substring(0, 200)}</span>
          )}
          {permission.input?.file_path != null && (
            <span className="text-[var(--text-tertiary)] ml-1">{String(permission.input.file_path)}</span>
          )}
        </div>
      )}
      {isExitPlan && (
        <div className="flex gap-1.5 items-end">
          <textarea
            ref={feedbackRef}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && feedback.trim()) {
                e.preventDefault();
                onFeedback(feedback.trim());
                setFeedback("");
              }
            }}
            placeholder="Suggest changes to the plan..."
            rows={1}
            className="flex-1 resize-none rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={() => { if (feedback.trim()) { onFeedback(feedback.trim()); setFeedback(""); } }}
            disabled={!feedback.trim()}
            className="px-2.5 py-1.5 text-xs rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] font-medium disabled:opacity-40"
          >
            Send
          </button>
        </div>
      )}
      <div className="flex gap-2">
        {!isExitPlan && (
          <button onClick={onAllow} className="px-3 py-1.5 text-xs rounded-md bg-[var(--accent)] text-white hover:opacity-90 font-medium">Allow</button>
        )}
        <button onClick={onAllowInNew} className="px-3 py-1.5 text-xs rounded-md bg-[var(--accent)] text-white hover:opacity-90 font-medium">
          {isExitPlan ? "Execute" : "Allow in new"}
        </button>
        <button onClick={onDeny} className="px-3 py-1.5 text-xs rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] font-medium">Deny</button>
      </div>
    </div>
  );
}
