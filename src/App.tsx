import { useCallback, useRef, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionContext } from "./contexts/SessionContext";
import { useClipboard } from "./hooks/useClipboard";
import Terminal from "./components/Terminal";
import Sidebar from "./components/Sidebar";
import SessionConversation from "./components/SessionConversation";
import GitPanel from "./components/GitPanel";
import PRPanel from "./components/PRPanel";
import ErrorBoundary from "./components/ErrorBoundary";
import UsagePanel from "./components/UsagePanel";
import FileEditor from "./components/FileEditor";

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
  const [showUsagePanel, setShowUsagePanel] = useState(false);
  const [showFileEditor, setShowFileEditor] = useState(false);
  const [editorFilePath, setEditorFilePath] = useState<string | undefined>();
  const [showDirDialog, setShowDirDialog] = useState(false);
  const [dirInput, setDirInput] = useState(() =>
    localStorage.getItem("claude-orchestrator-last-dir") || "~"
  );
  const [recentDirs, setRecentDirs] = useState<string[]>(loadRecentDirs);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [skipPermissions, setSkipPermissions] = useState(true);
  const [creating, setCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<Map<string, "main" | "git" | "prs" | "shell">>(new Map());
  // Track which sessions have a shell PTY created
  const [shellSessions, setShellSessions] = useState<Set<string>>(new Set());
  // LRU cache of mounted tab panels (most recent at end). Max 16 slots (8 sessions × 2 tabs).
  const MAX_MOUNTED_TABS = 16;
  const [mountedTabsLru, setMountedTabsLru] = useState<Array<{ sessionId: string; tab: string }>>([]);
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

  const getTab = (sessionId: string): "main" | "git" | "prs" | "shell" =>
    activeTab.get(sessionId) || "main";
  const isTabMounted = (sessionId: string, tab: string) =>
    mountedTabsLru.some((e) => e.sessionId === sessionId && e.tab === tab);
  const touchMountedTab = (sessionId: string, tab: string) => {
    setMountedTabsLru((prev) => {
      // Move to end (most recent), evict oldest if over limit
      const filtered = prev.filter((e) => !(e.sessionId === sessionId && e.tab === tab));
      const next = [...filtered, { sessionId, tab }];
      return next.length > MAX_MOUNTED_TABS ? next.slice(next.length - MAX_MOUNTED_TABS) : next;
    });
  };
  const switchTab = (sessionId: string, tab: "main" | "git" | "prs" | "shell") => {
    setActiveTab((prev) => {
      const next = new Map(prev);
      next.set(sessionId, tab);
      return next;
    });
    if (tab !== "main") touchMountedTab(sessionId, tab);
  };
  const ensureShellPty = async (sessionId: string, directory: string) => {
    if (shellSessions.has(sessionId)) return;
    const shellSessionId = `shell-${sessionId}`;
    try {
      await invoke("create_shell_pty_session", { sessionId: shellSessionId, directory });
      setShellSessions((prev) => new Set(prev).add(sessionId));
    } catch (err) {
      console.error("Failed to create shell PTY:", err);
    }
  };
  const toggleTab = (sessionId: string) => {
    const next = getTab(sessionId) === "main" ? "git" : "main";
    switchTab(sessionId, next);
  };
  const togglePRsTab = (sessionId: string) => {
    const next = getTab(sessionId) === "prs" ? "main" : "prs";
    switchTab(sessionId, next);
  };
  const toggleShellTab = (sessionId: string, directory: string) => {
    const next = getTab(sessionId) === "shell" ? "main" : "shell";
    if (next === "shell") ensureShellPty(sessionId, directory);
    switchTab(sessionId, next);
  };

  // Cmd+N to open new session dialog, Cmd+G to toggle git tab
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "n") {
        e.preventDefault();
        setDirInput(localStorage.getItem("claude-orchestrator-last-dir") || "~");
        setRecentDirs(loadRecentDirs());
        setShowDirDialog(true);
      }
      if (e.metaKey && e.key === "e") {
        // When git tab is active, GitPanel handles Cmd+E with the selected file
        if (activeSessionId && getTab(activeSessionId) === "git") return;
        e.preventDefault();
        setEditorFilePath(undefined);
        setShowFileEditor((v) => !v);
      }
      if (e.metaKey && e.key === "g" && activeSessionId) {
        e.preventDefault();
        toggleTab(activeSessionId);
      }
      if (e.metaKey && e.key === "p" && activeSessionId) {
        e.preventDefault();
        togglePRsTab(activeSessionId);
      }
      if (e.metaKey && e.key === "t" && activeSessionId) {
        e.preventDefault();
        const session = sessions.find((s) => s.id === activeSessionId);
        if (session) toggleShellTab(activeSessionId, session.directory);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeSessionId, activeTab]);

  // Wrap deleteSession to also clean up shell PTY
  const handleDeleteSession = async (id: string) => {
    if (shellSessions.has(id)) {
      invoke("destroy_pty_session", { sessionId: `shell-${id}` }).catch(() => {});
      setShellSessions((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
    await deleteSession(id);
  };

  const [worktrees, setWorktrees] = useState<string[]>([]);

  const handleNewSession = () => {
    setDirInput(localStorage.getItem("claude-orchestrator-last-dir") || "~");
    setRecentDirs(loadRecentDirs());
    setShowDirDialog(true);
    // Fetch worktrees from the last-used directory
    const lastDir = localStorage.getItem("claude-orchestrator-last-dir") || "~";
    invoke<string[]>("list_worktrees", { directory: lastDir })
      .then(setWorktrees)
      .catch(() => setWorktrees([]));
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

  const quickCreate = async (dir: string) => {
    if (creating) return;
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
        onDeleteSession={handleDeleteSession}
        onShowUsage={() => setShowUsagePanel(true)}
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
          sessions.map((session) => {
            const tab = getTab(session.id);
            const mainLabel = session.status === "stopped" ? "Conversation" : "Claude";
            return (
            <div
              key={session.id}
              className="absolute inset-0 flex flex-col"
              style={{
                zIndex: session.id === activeSessionId ? 1 : 0,
                visibility: session.id === activeSessionId ? "visible" : "hidden",
                pointerEvents: session.id === activeSessionId ? "auto" : "none",
                overflow: session.id === activeSessionId ? undefined : "hidden",
              }}
            >
              {/* Tab bar */}
              <div className="flex items-center gap-1 px-3 py-1 border-b border-[var(--border-color)] flex-shrink-0 bg-[var(--bg-secondary)]">
                <button
                  onClick={() => switchTab(session.id, "main")}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    tab === "main"
                      ? "text-[var(--text-primary)] bg-[var(--bg-tertiary)] font-medium"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  }`}
                >
                  {mainLabel}
                </button>
                <button
                  onClick={() => switchTab(session.id, "git")}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    tab === "git"
                      ? "text-[var(--text-primary)] bg-[var(--bg-tertiary)] font-medium"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  }`}
                >
                  Git
                </button>
                <button
                  onClick={() => switchTab(session.id, "prs")}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    tab === "prs"
                      ? "text-[var(--text-primary)] bg-[var(--bg-tertiary)] font-medium"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  }`}
                >
                  PRs
                </button>
                <button
                  onClick={() => {
                    ensureShellPty(session.id, session.directory);
                    switchTab(session.id, "shell");
                  }}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    tab === "shell"
                      ? "text-[var(--text-primary)] bg-[var(--bg-tertiary)] font-medium"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  }`}
                >
                  Shell
                </button>
              </div>

              {/* Tab content */}
              <div className="flex-1 min-h-0 relative">
                <div className="absolute inset-0 bg-[var(--bg-primary)]" style={{ zIndex: tab === "main" ? 2 : 0, pointerEvents: tab === "main" ? "auto" : "none" }}>
                  <ErrorBoundary key={`eb-${session.id}-${session.status}`}>
                    {session.status === "stopped" ? (
                      <SessionConversation
                        session={session}
                        onResume={() => restartSession(session.id)}
                      />
                    ) : (
                      <Terminal
                        sessionId={session.id}
                        isActive={session.id === activeSessionId && tab === "main"}
                        onExit={() => {
                          markStopped(session.id);
                          setMountedTabsLru((prev) => prev.filter((e) => e.sessionId !== session.id));
                          setActiveTab((prev) => { const next = new Map(prev); next.set(session.id, "main"); return next; });
                          // Destroy shell PTY if one exists
                          if (shellSessions.has(session.id)) {
                            invoke("destroy_pty_session", { sessionId: `shell-${session.id}` }).catch(() => {});
                            setShellSessions((prev) => { const next = new Set(prev); next.delete(session.id); return next; });
                          }
                        }}
                        onTitleChange={() => {}}
                        onActivity={() => touchSession(session.id)}
                        onRegisterWriteText={(fn) => registerWriteText(session.id, fn)}
                      />
                    )}
                  </ErrorBoundary>
                </div>
                {(tab === "git" || isTabMounted(session.id, "git")) && (
                  <div className="absolute inset-0 bg-[var(--bg-primary)]" style={{ zIndex: tab === "git" ? 2 : 0, pointerEvents: tab === "git" ? "auto" : "none" }}>
                    <GitPanel
                      directory={session.directory}
                      isActive={session.id === activeSessionId && tab === "git"}
                      onEditFile={(relativePath) => {
                        const dir = session.directory.endsWith("/") ? session.directory : session.directory + "/";
                        setEditorFilePath(dir + relativePath);
                        setShowFileEditor(true);
                      }}
                    />
                  </div>
                )}
                {(tab === "prs" || isTabMounted(session.id, "prs")) && (
                  <div className="absolute inset-0 bg-[var(--bg-primary)]" style={{ zIndex: tab === "prs" ? 2 : 0, pointerEvents: tab === "prs" ? "auto" : "none" }}>
                    <PRPanel
                      directory={session.directory}
                      isActive={session.id === activeSessionId && tab === "prs"}
                    />
                  </div>
                )}
                {(tab === "shell" || isTabMounted(session.id, "shell")) && shellSessions.has(session.id) && (
                  <div className="absolute inset-0 bg-[var(--bg-primary)]" style={{ zIndex: tab === "shell" ? 2 : 0, pointerEvents: tab === "shell" ? "auto" : "none" }}>
                    <Terminal
                      sessionId={`shell-${session.id}`}
                      isActive={session.id === activeSessionId && tab === "shell"}
                      onExit={() => {
                        setShellSessions((prev) => { const next = new Set(prev); next.delete(session.id); return next; });
                        switchTab(session.id, "main");
                      }}
                      onTitleChange={() => {}}
                    />
                  </div>
                )}
              </div>
            </div>
            );
          })
        )}
      </div>

      {/* Usage panel modal */}
      {showUsagePanel && (
        <UsagePanel onClose={() => setShowUsagePanel(false)} />
      )}

      {/* File editor overlay */}
      {showFileEditor && (
        <FileEditor
          baseDirectory={activeSessionId ? sessions.find((s) => s.id === activeSessionId)?.directory : undefined}
          initialFilePath={editorFilePath}
          onClose={() => { setShowFileEditor(false); setEditorFilePath(undefined); }}
        />
      )}

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
                    onClick={() => quickCreate(d)}
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
            {worktrees.length > 0 && (
              <>
              <label className="block text-[10px] text-[var(--text-tertiary)] pb-1.5 pt-1">
                Worktrees
              </label>
              <div className="flex flex-wrap gap-1.5 pb-2">
                {worktrees.map((wt) => (
                  <button
                    key={wt}
                    onClick={() => quickCreate(wt)}
                    className="px-2 py-0.5 text-[11px] font-mono rounded border transition-colors truncate max-w-[12rem] bg-[var(--bg-primary)] text-[var(--text-secondary)] border-dashed border-[var(--border-color)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
                    title={wt}
                  >
                    {wt.includes("/") ? wt.split("/").filter(Boolean).slice(-2).join("/") : wt}
                  </button>
                ))}
              </div>
              </>
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
