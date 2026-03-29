import { useEffect, useRef, useState } from "react";
import { invoke, listen } from "../../lib/bridge";
import { Spinner } from "../ui/spinner";

interface InlineCommandBarProps {
  sessionId: string;
  command: string;
  onDismiss: () => void;
}

/** Strip ANSI escape sequences and terminal control codes from PTY output. */
function stripAnsi(text: string): string {
  return text
    // CSI sequences: ESC [ ... (letter) — includes ?-prefixed like [?25h
    .replace(/\x1b\[[\x20-\x3f]*[\x30-\x3f]*[\x40-\x7e]/g, "")
    // OSC sequences: ESC ] ... (ST or BEL)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Other ESC sequences (two-char)
    .replace(/\x1b[\x20-\x7e]/g, "")
    // Carriage returns
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function InlineCommandBar({ sessionId, command, onDismiss }: InlineCommandBarProps) {
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(true);
  const [isExpanded, setIsExpanded] = useState(true);
  const outputRef = useRef<HTMLPreElement>(null);
  const ptyId = `inline-${sessionId}`;

  useEffect(() => {
    const unlisten: Array<() => void> = [];

    listen<string>(`pty-output-${ptyId}`, (event) => {
      setOutput((prev) => prev + stripAnsi(event.payload));
    }).then((u) => unlisten.push(u));

    listen<string>(`pty-exit-${ptyId}`, () => {
      setIsRunning(false);
    }).then((u) => unlisten.push(u));

    return () => {
      unlisten.forEach((u) => u());
    };
  }, [ptyId]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleKill = () => {
    invoke("kill_inline_command", { sessionId }).catch(console.error);
  };

  return (
    <div className="mx-3 mb-2 overflow-hidden border-2 border-[var(--border-subtle)] bg-[var(--bg-primary)]">
      {/* Header row — mimics ToolRow compact style */}
      <button
        onClick={() => setIsExpanded((e) => !e)}
        className="w-full flex items-center gap-2 py-1.5 px-3 hover:bg-white/5 cursor-pointer text-sm"
      >
        {/* Chevron */}
        <svg
          className={`w-3 h-3 shrink-0 text-[var(--text-tertiary)] transition-transform ${isExpanded ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>

        {/* Shell badge */}
        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-500/15 border-2 border-amber-500/25 text-xs font-bold text-amber-400 shrink-0">
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          Shell
        </span>

        {/* Command text */}
        <span className="text-xs text-[var(--text-tertiary)] truncate flex-1 font-mono text-left">
          {command}
        </span>

        {/* Status / actions */}
        {isRunning ? (
          <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <Spinner className="w-3.5 h-3.5" />
            <button
              onClick={handleKill}
              className="text-red-400 hover:text-red-300 text-xs font-medium cursor-pointer"
            >
              Kill
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <span className="text-xs shrink-0 text-green-400">✓</span>
            <button
              onClick={onDismiss}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] text-xs cursor-pointer"
            >
              ✕
            </button>
          </span>
        )}
      </button>

      {/* Expanded output */}
      {isExpanded && (
        <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <pre
            ref={outputRef}
            className="p-2 text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap max-h-48 overflow-y-auto"
          >
            {output || (isRunning ? "Waiting for output…" : "(no output)")}
          </pre>
        </div>
      )}
    </div>
  );
}
