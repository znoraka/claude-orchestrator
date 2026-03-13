import { memo } from "react";
import type { ChatMessage, ChangedFile } from "../types";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { SystemMessage } from "./SystemMessage";
import { ResultMessage } from "./ResultMessage";

interface MessageBubbleProps {
  message: ChatMessage;
  toolStates: Record<string, "expanded" | "collapsed">;
  onToggleTool: (id: string, isCurrentlyExpanded: boolean) => void;
  isLastMessage: boolean;
  onEdit?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  onRetry?: (messageId: string) => void;
  onCopy?: (messageId: string) => void;
  planContent?: string;
  onNavigateToSession?: (sessionId: string) => void;
  modifiedFiles?: ChangedFile[];
  onOpenFile?: (filePath: string, diff: string) => void;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  toolStates,
  onToggleTool,
  isLastMessage,
  onEdit,
  onFork,
  onRetry,
  onCopy,
  planContent,
  onNavigateToSession,
  modifiedFiles,
  onOpenFile,
}: MessageBubbleProps) {
  if (message.type === "user") {
    return (
      <UserMessage
        message={message}
        onEdit={onEdit}
        onFork={onFork}
        onRetry={onRetry}
        onCopy={onCopy}
        planContent={planContent}
      />
    );
  }

  if (message.type === "system") {
    return <SystemMessage message={message} onNavigateToSession={onNavigateToSession} />;
  }

  if (message.type === "error") {
    const content = Array.isArray(message.content) ? message.content : [];
    return (
      <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
        {content[0]?.text || "Unknown error"}
      </div>
    );
  }

  if (message.type === "result") {
    return (
      <ResultMessage
        message={message}
        modifiedFiles={modifiedFiles}
        onOpenFile={onOpenFile}
      />
    );
  }

  // Assistant message
  return (
    <AssistantMessage
      message={message}
      toolStates={toolStates}
      onToggleTool={onToggleTool}
      isLastMessage={isLastMessage}
      planContent={planContent}
    />
  );
});
