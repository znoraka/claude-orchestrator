import { useState } from "react";
import type { ChatMessage, ContentBlock } from "../types";
import { ContentBlockView } from "./shared/ContentBlockView";
import { InlinePlanBlock } from "./shared/InlinePlanBlock";
import { normaliseWs } from "../constants";

interface UserMessageProps {
  message: ChatMessage;
  onEdit?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  onRetry?: (messageId: string) => void;
  onCopy?: (messageId: string) => void;
  planContent?: string;
}

export function UserMessage({ message, onEdit, onFork, onRetry, onCopy, planContent }: UserMessageProps) {
  const [copied, setCopied] = useState(false);

  const content = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content } as ContentBlock]
      : [];

  const visible = content.filter((b) => b.type !== "tool_result");
  if (visible.length === 0) return null;

  const hasPlan = planContent && visible.some(b => {
    if (b.type !== "text" || !b.text) return false;
    if (b.text.includes("Execute the plan")) return true;
    if (b.text.length > 200) {
      const normText = normaliseWs(b.text);
      const normPlan = normaliseWs(planContent);
      return normPlan.includes(normText.slice(0, 200)) || normText.includes(normPlan.slice(0, 200));
    }
    return false;
  });

  return (
    <div className="flex flex-col items-end gap-1 animate-message-enter">
      <div className="group flex justify-end items-end gap-1">
        {/* Hover action buttons */}
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5 mb-1">
          {onRetry && (
            <button onClick={() => onRetry(message.id)} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]" title="Retry from here">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>
            </button>
          )}
          {onFork && (
            <button onClick={() => onFork(message.id)} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]" title="Fork conversation from here">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7" /><path d="M7 7h10v10" /></svg>
            </button>
          )}
          {onEdit && (
            <button onClick={() => onEdit(message.id)} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]" title="Edit & resend">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
            </button>
          )}
          {onCopy && (
            <button onClick={() => { onCopy(message.id); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]" title="Copy message">
              {copied ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
            </button>
          )}
        </div>

        {/* Right-aligned bubble */}
        <div className="max-w-[85%] max-h-96 overflow-y-auto chat-bubble-user text-[var(--text-primary)] rounded-2xl rounded-br-sm px-4 py-3">
          {visible.map((block, i) => {
            if (hasPlan && block.type === "text" && block.text && block.text.length > 200) {
              return <ContentBlockView key={i} block={{ type: "text", text: "Execute the plan." }} />;
            }
            if (block.type === "text" && block.text?.startsWith("\u{1F4CE} ")) {
              return (
                <div key={i} className="flex flex-wrap gap-1.5 mb-2">
                  {block.text.split("\n").map((line, j) => (
                    <span key={j} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-[var(--accent)]/15 text-[var(--text-secondary)] border border-[var(--accent)]/20">
                      <svg className="w-3 h-3 shrink-0 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>
                      {line.replace(/^\u{1F4CE}\s*/u, "")}
                    </span>
                  ))}
                </div>
              );
            }
            return <ContentBlockView key={i} block={block} />;
          })}
        </div>
      </div>
      {hasPlan && planContent && <InlinePlanBlock content={planContent} />}
    </div>
  );
}
