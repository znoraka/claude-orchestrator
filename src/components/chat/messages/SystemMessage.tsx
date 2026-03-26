import type { ChatMessage } from "../types";

interface SystemMessageProps {
  message: ChatMessage;
  onNavigateToSession?: (sessionId: string) => void;
}

export function SystemMessage({ message, onNavigateToSession }: SystemMessageProps) {
  const content = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];

  if (message.forkSessionId) {
    return (
      <div className="mx-3 my-2 px-3 py-2 bg-blue-500/10 border border-blue-500/20 flex items-center gap-2 text-xs text-blue-400">
        <span>→</span>
        <span>Plan executing in</span>
        <button
          className="font-medium underline underline-offset-2 hover:text-blue-300 cursor-pointer"
          onClick={() => onNavigateToSession?.(message.forkSessionId!)}
        >
          {message.forkSessionName || "new session"}
        </button>
      </div>
    );
  }

  return (
    <div className="px-3 py-1.5 text-xs text-[var(--text-tertiary)] italic text-center">
      {content[0]?.text}
    </div>
  );
}
