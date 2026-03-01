import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../types";

interface TranscriptMessage {
  role: string;
  text: string;
  timestamp: string;
}

interface Props {
  session: Session;
  onResume: () => void;
}

export default function SessionTranscript({ session, onResume }: Props) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session.claudeSessionId || !session.directory) {
      setLoading(false);
      return;
    }
    setLoading(true);
    invoke<TranscriptMessage[]>("get_session_transcript", {
      claudeSessionId: session.claudeSessionId,
      directory: session.directory,
    })
      .then(setMessages)
      .catch(() => setMessages([]))
      .finally(() => setLoading(false));
  }, [session.claudeSessionId, session.directory]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (!session.directory) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-xs text-[var(--text-secondary)] italic">
          Missing directory — please delete and recreate this session.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-[var(--text-secondary)]">Loading transcript...</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-sm text-[var(--text-secondary)] mb-1.5">
                {session.name}
              </p>
              <p className="text-xs text-[var(--text-secondary)] opacity-60">
                No transcript found
              </p>
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {messages.map((msg, i) => (
              <div key={i} className={`rounded-lg px-4 py-3 ${
                msg.role === "user"
                  ? "bg-[var(--accent)]/10 border border-[var(--accent)]/20"
                  : "bg-[var(--bg-secondary)] border border-[var(--border-color)]"
              }`}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`text-[10px] font-semibold uppercase tracking-wider ${
                    msg.role === "user" ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"
                  }`}>
                    {msg.role === "user" ? "You" : "Claude"}
                  </span>
                  {msg.timestamp && (
                    <span className="text-[10px] text-[var(--text-secondary)] opacity-40">
                      {msg.timestamp.replace("T", " ").slice(0, 19)}
                    </span>
                  )}
                </div>
                <pre className="text-xs text-[var(--text-primary)] font-mono whitespace-pre-wrap break-words leading-relaxed">
                  {msg.text}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="sticky bottom-0 px-6 py-4 bg-[var(--bg-primary)] border-t border-[var(--border-color)]">
        <div className="max-w-3xl mx-auto flex justify-center">
          <button
            onClick={onResume}
            className="px-6 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg text-sm font-medium transition-colors"
          >
            Resume Session
          </button>
        </div>
      </div>
    </div>
  );
}
