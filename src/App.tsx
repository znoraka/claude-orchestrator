import { useCallback, useRef, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionContext } from "./contexts/SessionContext";
import { useClipboard } from "./hooks/useClipboard";
import Terminal from "./components/Terminal";
import Sidebar from "./components/Sidebar";
import SessionTranscript from "./components/SessionTranscript";
import ErrorBoundary from "./components/ErrorBoundary";

export default function App() {
  const {
    sessions,
    sortedSessions,
    activeSessionId,
    sessionUsage,
    todayCost,
    todayTokens,
    selectSession,
    createSession,
    deleteSession,
    renameSession,
    markStopped,
    restartSession,
    touchSession,
  } = useSessionContext();

  // Registry of writeText callbacks from Terminal components
  const writeTextCallbacks = useRef<Map<string, (text: string) => void>>(new Map());

  // Recent directories helpers
  const MAX_RECENT_DIRS = 8;
  const loadRecentDirs = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem("claude-orchestrator-recent-dirs") || "[]");
    } catch { return []; }
  };
  const saveRecentDir = (dir: string) => {
    const recent = loadRecentDirs().filter((d) => d !== dir);
    recent.unshift(dir);
    localStorage.setItem(
      "claude-orchestrator-recent-dirs",
      JSON.stringify(recent.slice(0, MAX_RECENT_DIRS))
    );
  };

  // Directory dialog state
  const [showDirDialog, setShowDirDialog] = useState(false);
  const [dirInput, setDirInput] = useState(() =>
    localStorage.getItem("claude-orchestrator-last-dir") || "~"
  );
  const [recentDirs, setRecentDirs] = useState<string[]>(loadRecentDirs);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [skipPermissions, setSkipPermissions] = useState(true);
  const [creating, setCreating] = useState(false);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  const registerWriteText = useCallback(
    (sessionId: string, fn: ((text: string) => void) | null) => {
      if (fn) {
        writeTextCallbacks.current.set(sessionId, fn);
      } else {
        writeTextCallbacks.current.delete(sessionId);
      }
    },
    []
  );

  // Clipboard image handler: inject path into active session's PTY
  const handleImagePath = useCallback(
    (path: string) => {
      if (!activeSessionId) return;
      const writeFn = writeTextCallbacks.current.get(activeSessionId);
      writeFn?.("'" + path.replace(/'/g, "'\\''") + "' ");
    },
    [activeSessionId]
  );

  useClipboard(handleImagePath);

  // Cmd+N to open new session dialog
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "n") {
        e.preventDefault();
        setDirInput(localStorage.getItem("claude-orchestrator-last-dir") || "~");
        setRecentDirs(loadRecentDirs());
        setShowDirDialog(true);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleNewSession = () => {
    setDirInput(localStorage.getItem("claude-orchestrator-last-dir") || "~");
    setRecentDirs(loadRecentDirs());
    setShowDirDialog(true);
  };

  const handleDirConfirm = async () => {
    const dir = dirInput.trim();
    if (!dir || creating) return;
    setCreating(true);
    localStorage.setItem("claude-orchestrator-last-dir", dir);
    saveRecentDir(dir);
    setShowDirDialog(false);
    try {
      await createSession(undefined, dir, skipPermissions);
    } finally {
      setCreating(false);
    }
  };

  const handleDirCancel = () => {
    setShowDirDialog(false);
    setSuggestions([]);
  };

  // Fetch directory suggestions as user types
  useEffect(() => {
    if (!showDirDialog || !dirInput.trim()) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      invoke<string[]>("list_directories", { partial: dirInput })
        .then((dirs) => {
          setSuggestions(dirs);
          setSelectedIdx(-1);
        })
        .catch((err) => {
          console.error("Failed to list directories:", err);
          setSuggestions([]);
        });
    }, 100);
    return () => clearTimeout(timer);
  }, [dirInput, showDirDialog]);

  const acceptSuggestion = (path: string) => {
    setDirInput(path + "/");
    setSuggestions([]);
  };

  return (
    <div className="flex h-screen w-screen bg-[var(--bg-primary)]">
      {/* Left sidebar */}
      <Sidebar
        sessions={sortedSessions}
        activeSessionId={activeSessionId}
        sessionUsage={sessionUsage}
        todayCost={todayCost}
        todayTokens={todayTokens}
        onSelectSession={selectSession}
        onCreateSession={handleNewSession}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
      />

      {/* Main terminal area */}
      <div className="flex-1 min-w-0 relative">
        {sessions.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <h1 className="text-2xl font-light text-[var(--text-primary)] mb-3">
                Claude Session Manager
              </h1>
              <p className="text-sm text-[var(--text-secondary)] mb-8">
                Manage multiple Claude CLI sessions
              </p>
              <button
                onClick={handleNewSession}
                className="px-6 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg text-sm font-medium transition-colors"
              >
                New Session
              </button>
            </div>
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className="absolute inset-0"
              style={{
                visibility: session.id === activeSessionId ? "visible" : "hidden",
                pointerEvents: session.id === activeSessionId ? "auto" : "none",
              }}
            >
              <ErrorBoundary key={`eb-${session.id}-${session.status}`}>
                {session.status === "stopped" ? (
                  <SessionTranscript
                    session={session}
                    onResume={() => restartSession(session.id)}
                  />
                ) : (
                  <Terminal
                    sessionId={session.id}
                    isActive={session.id === activeSessionId}
                    onExit={() => markStopped(session.id)}
                    onTitleChange={() => {}}
                    onActivity={() => touchSession(session.id)}
                    onRegisterWriteText={(fn) => registerWriteText(session.id, fn)}
                  />
                )}
              </ErrorBoundary>
            </div>
          ))
        )}
      </div>

      {/* Directory picker dialog */}
      {showDirDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 dialog-backdrop" onMouseDown={handleDirCancel}>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl p-8 w-96 shadow-2xl flex flex-col gap-3" onMouseDown={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              New Session
            </h2>
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={skipPermissions}
                onChange={(e) => setSkipPermissions(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              <span className="text-xs text-[var(--text-secondary)]">
                Skip permissions
              </span>
            </label>
            <div>
            <label className="block text-xs text-[var(--text-secondary)] pb-2">
              Working directory
            </label>
            {recentDirs.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pb-2">
                {recentDirs.map((d) => (
                  <button
                    key={d}
                    onClick={() => setDirInput(d)}
                    className={`px-2 py-0.5 text-[11px] font-mono rounded border transition-colors truncate max-w-[10rem] ${
                      dirInput === d
                        ? "bg-[var(--accent)] text-white border-[var(--accent)]"
                        : "bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
                    }`}
                    title={d}
                  >
                    {d.includes("/") ? d.split("/").filter(Boolean).slice(-2).join("/") : d}
                  </button>
                ))}
              </div>
            )}
            <div className="relative">
              <input
                autoFocus
                value={dirInput}
                onChange={(e) => setDirInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Tab" && suggestions.length > 0) {
                    e.preventDefault();
                    acceptSuggestion(suggestions[Math.max(0, selectedIdx)]);
                  } else if (e.key === "ArrowDown" && suggestions.length > 0) {
                    e.preventDefault();
                    setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1));
                  } else if (e.key === "ArrowUp" && suggestions.length > 0) {
                    e.preventDefault();
                    setSelectedIdx((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter") {
                    if (selectedIdx >= 0 && suggestions.length > 0) {
                      acceptSuggestion(suggestions[selectedIdx]);
                    } else {
                      handleDirConfirm();
                    }
                  } else if (e.key === "Escape") {
                    if (suggestions.length > 0) {
                      setSuggestions([]);
                    } else {
                      handleDirCancel();
                    }
                  }
                }}
                className="w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] font-mono transition-colors"
                placeholder="~/projects/my-app"
              />
              {suggestions.length > 0 && (
                <div
                  ref={suggestionsRef}
                  className="absolute left-0 right-0 top-full mt-1 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded shadow-lg max-h-48 overflow-y-auto z-10"
                >
                  {suggestions.map((s, i) => (
                    <div
                      key={s}
                      onClick={() => acceptSuggestion(s)}
                      className={`px-3 py-1.5 text-xs font-mono cursor-pointer truncate ${
                        i === selectedIdx
                          ? "bg-[var(--accent)] text-white"
                          : "text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                      }`}
                    >
                      {s}
                    </div>
                  ))}
                </div>
              )}
            </div>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={handleDirCancel}
                className="px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDirConfirm}
                disabled={creating}
                className="px-3 py-1.5 text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
