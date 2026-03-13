import type { ChatMessage, ChangedFile } from "../types";
import { ChangedFilesPanel } from "./shared/ChangedFilesPanel";

interface ResultMessageProps {
  message: ChatMessage;
  modifiedFiles?: ChangedFile[];
  onOpenFile?: (filePath: string, diff: string) => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export function ResultMessage({ message, modifiedFiles, onOpenFile }: ResultMessageProps) {
  const usage = message.usage;
  const cost = message.costUsd;
  const durationMs = message.durationMs;
  const hasStats = usage || cost || durationMs;
  const hasFiles = modifiedFiles && modifiedFiles.length > 0 && onOpenFile;

  if (!hasStats && !hasFiles) return null;

  return (
    <div className="flex flex-col">
      {hasStats && (
        <div className="flex items-center gap-3 px-3 py-1 text-[10px] text-[var(--text-tertiary)]">
          {usage && (
            <span>{((usage.input_tokens || 0) + (usage.output_tokens || 0)).toLocaleString()} tokens</span>
          )}
          {durationMs !== undefined && durationMs > 0 && (
            <span>{formatDuration(durationMs)}</span>
          )}
          {cost !== undefined && cost > 0 && (
            <span>${cost.toFixed(2)}</span>
          )}
        </div>
      )}
      {hasFiles && (
        <ChangedFilesPanel files={modifiedFiles!} onOpenFile={onOpenFile!} />
      )}
    </div>
  );
}
