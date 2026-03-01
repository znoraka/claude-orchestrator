import { useEffect, useRef, useState, useCallback, useMemo } from "react";
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
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const matchRefs = useRef<(HTMLElement | null)[]>([]);

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

  // Cmd+F to toggle search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "f") {
        e.preventDefault();
        setShowSearch((prev) => {
          if (prev) {
            setSearchQuery("");
            setMatchIndex(0);
            setMatchCount(0);
            return false;
          }
          setTimeout(() => searchInputRef.current?.focus(), 0);
          return true;
        });
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Scroll to current match
  useEffect(() => {
    if (matchCount > 0 && matchRefs.current[matchIndex]) {
      matchRefs.current[matchIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [matchIndex, matchCount]);

  // Count total matches when query changes
  useEffect(() => {
    if (!searchQuery) {
      setMatchCount(0);
      setMatchIndex(0);
      matchRefs.current = [];
      return;
    }
    const q = searchQuery.toLowerCase();
    let count = 0;
    for (const msg of messages) {
      let idx = 0;
      const text = msg.text.toLowerCase();
      while ((idx = text.indexOf(q, idx)) !== -1) {
        count++;
        idx += q.length;
      }
    }
    matchRefs.current = [];
    setMatchCount(count);
    setMatchIndex(0);
  }, [searchQuery, messages]);

  const goToMatch = useCallback((dir: 1 | -1) => {
    if (matchCount === 0) return;
    setMatchIndex((prev) => (prev + dir + matchCount) % matchCount);
  }, [matchCount]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      goToMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      setSearchQuery("");
      setShowSearch(false);
      setMatchIndex(0);
      setMatchCount(0);
    }
  };

  // Render text with highlighted search matches
  const renderHighlighted = (text: string, globalOffset: number) => {
    if (!searchQuery) return <>{text}</>;
    const q = searchQuery.toLowerCase();
    const parts: React.ReactNode[] = [];
    let lastEnd = 0;
    let localMatch = 0;
    const lower = text.toLowerCase();
    let idx = 0;
    while ((idx = lower.indexOf(q, idx)) !== -1) {
      if (idx > lastEnd) parts.push(text.slice(lastEnd, idx));
      const isActive = globalOffset + localMatch === matchIndex;
      parts.push(
        <mark
          key={`${idx}-${localMatch}`}
          ref={(el) => { matchRefs.current[globalOffset + localMatch] = el; }}
          className={isActive
            ? "bg-[var(--accent)] text-white rounded-sm px-0.5"
            : "bg-yellow-500/30 text-[var(--text-primary)] rounded-sm px-0.5"}
        >
          {text.slice(idx, idx + q.length)}
        </mark>
      );
      lastEnd = idx + q.length;
      localMatch++;
      idx += q.length;
    }
    if (lastEnd < text.length) parts.push(text.slice(lastEnd));
    return <>{parts}</>;
  };

  // Pre-compute per-message match offsets as prefix sums (O(n) instead of O(n²))
  const matchOffsets = useMemo(() => {
    if (!searchQuery) return [];
    const q = searchQuery.toLowerCase();
    const offsets: number[] = [0];
    for (let i = 0; i < messages.length; i++) {
      let count = 0;
      let idx = 0;
      const text = messages[i].text.toLowerCase();
      while ((idx = text.indexOf(q, idx)) !== -1) {
        count++;
        idx += q.length;
      }
      offsets.push(offsets[i] + count);
    }
    return offsets;
  }, [searchQuery, messages]);

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
    <div className="flex flex-col h-full relative">
      {showSearch && (
        <div className="absolute top-2 right-4 z-10 flex items-center gap-1.5 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-1.5 shadow-lg">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Find in transcript..."
            className="bg-transparent text-xs text-[var(--text-primary)] outline-none w-48 placeholder:text-[var(--text-tertiary)]"
          />
          {searchQuery && matchCount > 0 && (
            <span className="text-[10px] text-[var(--text-secondary)] tabular-nums">
              {matchIndex + 1}/{matchCount}
            </span>
          )}
          <button
            onClick={() => goToMatch(-1)}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-0.5"
            title="Previous (Shift+Enter)"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            onClick={() => goToMatch(1)}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-0.5"
            title="Next (Enter)"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button
            onClick={() => {
              setSearchQuery("");
              setShowSearch(false);
              setMatchIndex(0);
              setMatchCount(0);
            }}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-0.5 ml-1"
            title="Close (Esc)"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
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
                  {renderHighlighted(msg.text, matchOffsets[i] ?? 0)}
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
