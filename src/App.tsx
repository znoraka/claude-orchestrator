import { useCallback, useRef, useState, useEffect, useMemo } from "react";
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
import { directoryColor, shortenPath } from "./components/SessionTab";
import { repoRootDir } from "./utils/workspaces";

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
  const [dirInputDirty, setDirInputDirty] = useState(false);

  // ── Panel state (replaces per-workspace tab state) ──────────────
  const [activePanel, setActivePanel] = useState<"git" | "prs" | "shell" | null>(null);

  // panelDirectory: which directory Git/PRs/Shell target
  // null = auto-follow active session's directory
  const [panelDirOverride, setPanelDirOverride] = useState<string | null>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );

  const panelDirectory = panelDirOverride ?? activeSession?.directory ?? "~";

  // Reset override when selecting a new session (auto-follow)
  const prevActiveSessionId = useRef(activeSessionId);
  useEffect(() => {
    if (activeSessionId !== prevActiveSessionId.current) {
      prevActiveSessionId.current = activeSessionId;
      setPanelDirOverride(null);
    }
  }, [activeSessionId]);

  // Worktrees for the directory dropdown
  const [dropdownWorktrees, setDropdownWorktrees] = useState<string[]>([]);
  useEffect(() => {
    invoke<string[]>("list_worktrees", { directory: panelDirectory })
      .then(setDropdownWorktrees)
      .catch(() => setDropdownWorktrees([]));
  }, [panelDirectory]);

  // Unique directories from sessions (for dropdown)
  const sessionDirectories = useMemo(() => {
    const dirs = new Set(sessions.map((s) => s.directory).filter(Boolean));
    return [...dirs].sort();
  }, [sessions]);

  // All dropdown choices: session dirs + worktrees (deduplicated)
  const dropdownChoices = useMemo(() => {
    const all = new Set([...sessionDirectories, ...dropdownWorktrees]);
    return [...all].sort();
  }, [sessionDirectories, dropdownWorktrees]);

  // Sanitize directory path into a Tauri-event-safe session ID.
  // Tauri v2 event names only allow alphanumeric, '-', '/', ':', '_'.
  const shellSessionId = (dir: string) =>
    `shell-${dir.replace(/[^a-zA-Z0-9\-_/:]/g, "_")}`;

  // Track which directories have a shell PTY created
  const [shellDirs, setShellDirs] = useState<Set<string>>(new Set());

  // Dropdown open state
  const [showDirDropdown, setShowDirDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDirDropdown) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDirDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showDirDropdown]);

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

  const ensureShellPty = async (dir: string) => {
    if (shellDirs.has(dir)) return;
    const sid = shellSessionId(dir);
    try {
      await invoke("create_shell_pty_session", { sessionId: sid, directory: dir });
      setShellDirs((prev) => new Set(prev).add(dir));
    } catch (err) {
      console.error("Failed to create shell PTY:", err);
    }
  };

  const togglePanel = (panel: "git" | "prs" | "shell") => {
    setActivePanel((prev) => (prev === panel ? null : panel));
    if (panel === "shell") ensureShellPty(panelDirectory);
  };

  // Cmd+N to open new session dialog, Cmd+G/P/T to toggle panels
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "n") {
        e.preventDefault();
        setDirInput(localStorage.getItem("claude-orchestrator-last-dir") || "~");
        setRecentDirs(loadRecentDirs());
        setShowDirDialog(true);
      }
      if (e.metaKey && e.key === "e") {
        if (activePanel === "git") return;
        e.preventDefault();
        setEditorFilePath(undefined);
        setShowFileEditor((v) => !v);
      }
      if (e.metaKey && e.key === "g") {
        e.preventDefault();
        togglePanel("git");
      }
      if (e.metaKey && e.key === "p") {
        e.preventDefault();
        togglePanel("prs");
      }
      if (e.metaKey && e.key === "t") {
        e.preventDefault();
        togglePanel("shell");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activePanel, panelDirectory]);

  // Wrap deleteSession to handle shell PTY lifecycle
  const handleDeleteSession = async (id: string) => {
    await deleteSession(id);
  };

  const [worktrees, setWorktrees] = useState<string[]>([]);

  const handleNewSession = () => {
    setDirInput(localStorage.getItem("claude-orchestrator-last-dir") || "~");
    setDirInputDirty(false);
    setSuggestions([]);
    setRecentDirs(loadRecentDirs());
    setShowDirDialog(true);
    const lastDir = localStorage.getItem("claude-orchestrator-last-dir") || "~";
    invoke<string[]>("list_worktrees", { directory: lastDir })
      .then(setWorktrees)
      .catch(() => setWorktrees([]));
  };

  const handleDirConfirm = async () => {
    const dir = dirInput.trim();
    if (!dir || creating) return;
    setCreating(true);
    const rootDir = repoRootDir(dir);
    localStorage.setItem("claude-orchestrator-last-dir", rootDir);
    saveRecentDir(rootDir);
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

  // Fetch directory suggestions as user types (only after manual edits)
  useEffect(() => {
    if (!showDirDialog || !dirInput.trim() || !dirInputDirty) {
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
  }, [dirInput, showDirDialog, dirInputDirty]);

  const acceptSuggestion = (path: string) => {
    setDirInput(path + "/");
    setSuggestions([]);
  };

  const quickCreate = async (dir: string) => {
    if (creating) return;
    setCreating(true);
    // Save the repo root as last-dir so worktrees are always listed from the main repo
    const rootDir = repoRootDir(dir);
    localStorage.setItem("claude-orchestrator-last-dir", rootDir);
    saveRecentDir(rootDir);
    setShowDirDialog(false);
    try {
      await createSession(undefined, dir, skipPermissions);
    } finally {
      setCreating(false);
    }
  };

  const handleSelectSession = (id: string) => {
    selectSession(id);
    setActivePanel(null);
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
        onSelectSession={handleSelectSession}
        onCreateSession={handleNewSession}
        onRenameSession={renameSession}
        onDeleteSession={handleDeleteSession}
        onShowUsage={() => setShowUsagePanel(true)}
      />

      {/* Main area */}
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
          <div className="absolute inset-0 flex flex-col">
            {/* Tab bar: [color dot] Claude | Git | PRs | Shell | [~/short/path ▼] */}
            <div className="flex items-center px-2 py-0.5 border-b border-[var(--border-color)] flex-shrink-0">
              <button
                onClick={() => setActivePanel(null)}
                className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                  activePanel === null
                    ? "text-[var(--text-primary)] bg-[var(--bg-tertiary)] font-medium"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                }`}
              >
                Claude
              </button>
              <div className="px-3">
                <div className="w-px h-3.5" style={{ backgroundColor: directoryColor(panelDirectory) }} />
              </div>
              <button
                onClick={() => togglePanel("git")}
                className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                  activePanel === "git"
                    ? "text-[var(--text-primary)] bg-[var(--bg-tertiary)] font-medium"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                }`}
              >
                Git
              </button>
              <button
                onClick={() => togglePanel("prs")}
                className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                  activePanel === "prs"
                    ? "text-[var(--text-primary)] bg-[var(--bg-tertiary)] font-medium"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                }`}
              >
                PRs
              </button>
              <button
                onClick={() => togglePanel("shell")}
                className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                  activePanel === "shell"
                    ? "text-[var(--text-primary)] bg-[var(--bg-tertiary)] font-medium"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                }`}
              >
                Shell
              </button>

              {/* Directory dropdown */}
              <div className="ml-auto pl-3 relative" ref={dropdownRef}>
                <button
                  onClick={() => setShowDirDropdown((v) => !v)}
                  className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded border transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)] font-mono"
                  style={{ borderColor: directoryColor(panelDirectory) }}
                >
                  {shortenPath(panelDirectory)}
                  <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showDirDropdown && (
                  <div className="absolute right-0 top-full mt-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg max-h-64 overflow-y-auto z-20 min-w-[200px]">
                    {dropdownChoices.map((dir) => (
                      <button
                        key={dir}
                        onClick={() => {
                          setPanelDirOverride(dir);
                          setShowDirDropdown(false);
                          // If switching to shell, ensure PTY exists
                          if (activePanel === "shell") ensureShellPty(dir);
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] font-mono transition-colors ${
                          dir === panelDirectory
                            ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: directoryColor(dir) }}
                        />
                        <span className="truncate">{shortenPath(dir)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Content area */}
            <div className="flex-1 min-h-0 relative">
              {/* Session panels — one per session, visibility-toggled */}
              {sessions.map((session) => {
                const isVisible = session.id === activeSessionId && activePanel === null;
                return (
                  <div
                    key={session.id}
                    className="absolute inset-0 bg-[var(--bg-primary)]"
                    style={{
                      zIndex: isVisible ? 2 : 0,
                      pointerEvents: isVisible ? "auto" : "none",
                      visibility: (isVisible || session.id === activeSessionId) ? "visible" : "hidden",
                    }}
                  >
                    <ErrorBoundary key={`eb-${session.id}-${session.status}`}>
                      {session.status === "stopped" ? (
                        <SessionConversation
                          session={session}
                          onResume={() => restartSession(session.id)}
                        />
                      ) : (
                        <Terminal
                          sessionId={session.id}
                          isActive={isVisible}
                          onExit={() => {
                            markStopped(session.id);
                          }}
                          onTitleChange={() => {}}
                          onActivity={() => touchSession(session.id)}
                          onRegisterWriteText={(fn) => registerWriteText(session.id, fn)}
                        />
                      )}
                    </ErrorBoundary>
                  </div>
                );
              })}

              {/* Git panel */}
              {activePanel === "git" && (
                <div
                  className="absolute inset-0 bg-[var(--bg-primary)]"
                  style={{ zIndex: 2 }}
                >
                  <GitPanel
                    directory={panelDirectory}
                    isActive={activePanel === "git"}
                    onEditFile={(relativePath) => {
                      const dir = panelDirectory.endsWith("/") ? panelDirectory : panelDirectory + "/";
                      setEditorFilePath(dir + relativePath);
                      setShowFileEditor(true);
                    }}
                  />
                </div>
              )}

              {/* PRs panel */}
              {activePanel === "prs" && (
                <div
                  className="absolute inset-0 bg-[var(--bg-primary)]"
                  style={{ zIndex: 2 }}
                >
                  <PRPanel
                    directory={panelDirectory}
                    isActive={activePanel === "prs"}
                    onAskClaude={(prompt) => {
                      if (!activeSessionId) return;
                      const writeFn = writeTextCallbacks.current.get(activeSessionId);
                      writeFn?.(prompt + "\n");
                      setActivePanel(null);
                    }}
                  />
                </div>
              )}

              {/* Shell */}
              {activePanel === "shell" && shellDirs.has(panelDirectory) && (
                <div
                  className="absolute inset-0 bg-[var(--bg-primary)]"
                  style={{ zIndex: 2 }}
                >
                  <Terminal
                    sessionId={shellSessionId(panelDirectory)}
                    isActive={activePanel === "shell"}
                    onExit={() => {
                      setShellDirs((prev) => {
                        const next = new Set(prev);
                        next.delete(panelDirectory);
                        return next;
                      });
                      setActivePanel(null);
                    }}
                    onTitleChange={() => {}}
                  />
                </div>
              )}
            </div>
          </div>
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
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl w-[420px] shadow-2xl flex flex-col overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
            {/* Search input */}
            <div className="px-4 pt-4 pb-3">
              <div className="relative">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-tertiary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  autoFocus
                  value={dirInput}
                  onChange={(e) => { setDirInput(e.target.value); setDirInputDirty(true); }}
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
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg pl-9 pr-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] font-mono transition-colors"
                  placeholder="Type a path or pick below…"
                />
              </div>
            </div>

            {/* Autocomplete suggestions (overlay) */}
            {suggestions.length > 0 && (
              <div className="px-4 -mt-1 pb-2 relative">
                <div
                  ref={suggestionsRef}
                  className="bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg shadow-lg max-h-40 overflow-y-auto"
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
              </div>
            )}

            {/* Directory list */}
            {(recentDirs.length > 0 || worktrees.length > 0) && suggestions.length === 0 && (
              <div className="max-h-[280px] overflow-y-auto border-t border-[var(--border-color)]">
                {recentDirs.length > 0 && (
                  <div>
                    <div className="px-4 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                      Recent
                    </div>
                    {recentDirs.map((d) => (
                      <button
                        key={d}
                        onClick={() => quickCreate(d)}
                        className="w-full flex items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] group"
                      >
                        <svg className="w-4 h-4 shrink-0 text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.06-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                        </svg>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-[var(--text-primary)] truncate">
                            {d.includes("/") ? d.split("/").filter(Boolean).pop() : d}
                          </div>
                          <div className="text-[10px] text-[var(--text-tertiary)] font-mono truncate">
                            {d.startsWith("~") ? d : "~/" + d.split("/").slice(3).join("/")}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {worktrees.length > 0 && (
                  <div>
                    <div className="px-4 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                      Worktrees
                    </div>
                    {worktrees.map((wt) => (
                      <button
                        key={wt}
                        onClick={() => quickCreate(wt)}
                        className="w-full flex items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] group"
                      >
                        <svg className="w-4 h-4 shrink-0 text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.54a4.5 4.5 0 00-6.364-6.364L4.5 8.25" />
                        </svg>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-[var(--text-primary)] truncate">
                            {wt.includes("/") ? wt.split("/").filter(Boolean).pop() : wt}
                          </div>
                          <div className="text-[10px] text-[var(--text-tertiary)] font-mono truncate">
                            {wt.startsWith("~") ? wt : "~/" + wt.split("/").slice(3).join("/")}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border-color)]">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={skipPermissions}
                  onChange={(e) => setSkipPermissions(e.target.checked)}
                  className="accent-[var(--accent)] w-3.5 h-3.5"
                />
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  Skip permissions
                </span>
              </label>
              <div className="flex gap-2">
                <button
                  onClick={handleDirCancel}
                  className="px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDirConfirm}
                  disabled={creating}
                  className="px-4 py-1.5 text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md transition-colors font-medium"
                >
                  {creating ? "Creating…" : "Create"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
