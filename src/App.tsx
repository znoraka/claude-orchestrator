// Plan mode test comment
import { useRef, useState, useEffect, useMemo, useCallback, memo, startTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionContext } from "./contexts/SessionContext";
import Terminal from "./components/Terminal";
import Sidebar from "./components/Sidebar";
import AgentChat from "./components/AgentChat";
import PRPanel from "./components/PRPanel";
import ErrorBoundary from "./components/ErrorBoundary";
import UsagePanel from "./components/UsagePanel";
import FileEditor from "./components/FileEditor";
import { repoColor } from "./components/SessionTab";
import { prewarmContextMenu } from "./components/ContextMenu";
import { repoRootDir, worktreeName } from "./utils/workspaces";
import { useWorktreeBranches } from "./hooks/useWorktreeBranches";
import { useShellProcessStatus } from "./hooks/useShellProcessStatus";
import { AGENT_PROVIDERS, defaultModelForProvider, jsonlDirectory, modelsForProvider, type AgentProvider, type ModelOption, type Session } from "./types";
import CommandPalette from "./components/CommandPalette";
import { useUpdater } from "./hooks/useUpdater";
import { useToast } from "./components/Toast";
import ActivityBar from "./components/ActivityBar";
import OverviewDashboard from "./components/OverviewDashboard";
import ContextRail from "./components/ContextRail";
import { useSessionLive } from "./contexts/SessionContext";

export interface OpenCodeModel {
  id: string;
  providerID: string;
  name: string;
  free: boolean;
  costIn: number;
  costOut: number;
}

// Memoized wrapper to prevent all AgentChat instances from re-rendering
// when the sessions array changes (e.g. new session added).
const SessionPanel = memo(function SessionPanel({
  session,
  isActive,
  activePanel,
  markStopped,
  touchSession,
  setAgentBusy,
  setAgentUsage,
  setSessionDraft,
  setSessionQuestion,
  updateClaudeSessionId,
  renameSession,
  markTitleGenerated,
  clearPendingPrompt,
  restartSession,
  createSession,
  currentModel,
  onModelChange,
  activeModels,
  setChatInputHeight,
  onAvailableModels,
  onNavigateToSession,
  updatePermissionMode,
  parentSession,
  childSessions,
  onOpenFile,
}: {
  session: Session;
  isActive: boolean;
  activePanel: string | null;
  markStopped: (id: string, exitCode?: number) => void;
  touchSession: (id: string) => void;
  setAgentBusy: (id: string, isBusy: boolean) => void;
  setAgentUsage: (id: string, usage: import("./types").SessionUsage) => void;
  setSessionDraft: (id: string, hasDraft: boolean) => void;
  setSessionQuestion: (id: string, hasQuestion: boolean) => void;
  updateClaudeSessionId: (id: string, claudeSessionId: string) => void;
  renameSession: (id: string, name: string) => void;
  markTitleGenerated: (id: string) => void;
  clearPendingPrompt: (id: string) => void;
  restartSession: (id: string) => Promise<void>;
  createSession: (name: string | undefined, directory: string, skip?: boolean, systemPrompt?: string, pendingPrompt?: string, provider?: AgentProvider, model?: string, permissionMode?: "bypassPermissions" | "plan", planContent?: string, parentSessionId?: string) => Promise<string>;
  updatePermissionMode: (id: string, mode: "bypassPermissions" | "plan") => void;
  currentModel: string;
  onModelChange: (modelId: string) => void;
  activeModels: import("./types").ModelOption[];
  setChatInputHeight: (h: number) => void;
  onAvailableModels?: (models: OpenCodeModel[]) => void;
  onNavigateToSession?: (sessionId: string) => void;
  parentSession?: { id: string; name: string; claudeSessionId?: string; directory?: string } | null;
  childSessions?: Array<{ id: string; name: string; claudeSessionId?: string; directory?: string; status: string }>;
  onOpenFile?: (filePath: string, diff: string) => void;
}) {
  const isVisible = isActive && activePanel === null;

  const handleExit = useCallback((exitCode?: number) => markStopped(session.id, exitCode), [session.id, markStopped]);
  const handleActivity = useCallback(() => touchSession(session.id), [session.id, touchSession]);
  const handleBusyChange = useCallback((isBusy: boolean) => setAgentBusy(session.id, isBusy), [session.id, setAgentBusy]);
  const handleUsageUpdate = useCallback((usage: import("./types").SessionUsage) => setAgentUsage(session.id, usage), [session.id, setAgentUsage]);
  const handleDraftChange = useCallback((hasDraft: boolean) => setSessionDraft(session.id, hasDraft), [session.id, setSessionDraft]);
  const handleQuestionChange = useCallback((hasQuestion: boolean) => setSessionQuestion(session.id, hasQuestion), [session.id, setSessionQuestion]);
  const handleClaudeSessionId = useCallback((claudeSessionId: string) => updateClaudeSessionId(session.id, claudeSessionId), [session.id, updateClaudeSessionId]);
  const handleResume = useCallback(() => restartSession(session.id), [session.id, restartSession]);
  const handleFork = useCallback((systemPrompt: string) => createSession(`Fork of ${session.name}`, session.directory, session.dangerouslySkipPermissions, systemPrompt), [session.name, session.directory, session.dangerouslySkipPermissions, createSession]);
  const handleForkWithPrompt = useCallback((systemPrompt: string, pendingPrompt: string, planContent?: string) => createSession(`Execute: ${session.name}`, session.directory, false, systemPrompt, pendingPrompt, session.provider, session.model, "bypassPermissions", planContent, session.id), [session.name, session.directory, session.provider, session.model, session.id, createSession]);
  const handleRename = useCallback((name: string) => renameSession(session.id, name), [session.id, renameSession]);
  const handleMarkTitleGenerated = useCallback(() => markTitleGenerated(session.id), [session.id, markTitleGenerated]);
  const handleClearPendingPrompt = useCallback(() => clearPendingPrompt(session.id), [session.id, clearPendingPrompt]);
  const handlePermissionModeChange = useCallback((mode: "bypassPermissions" | "plan") => updatePermissionMode(session.id, mode), [session.id, updatePermissionMode]);
  const handleEditFile = useCallback((filePath: string) => {
    const dir = session.directory.endsWith("/") ? session.directory : session.directory + "/";
    const editor = localStorage.getItem("claude-orchestrator-editor-command") || "code";
    invoke("open_in_editor", { editor, filePath: dir + filePath });
  }, [session.directory]);

  return (
    <div
      className="absolute inset-0 bg-[var(--bg-primary)]"
      style={{
        zIndex: isVisible ? 2 : 0,
        pointerEvents: isVisible ? "auto" : "none",
        visibility: (isVisible || isActive) ? "visible" : "hidden",
      }}
    >
      <ErrorBoundary key={`eb-${session.id}`}>
        <AgentChat
          sessionId={session.id}
          isActive={isVisible}
          onExit={handleExit}
          onActivity={handleActivity}
          onBusyChange={handleBusyChange}
          onUsageUpdate={handleUsageUpdate}
          onDraftChange={handleDraftChange}
          onQuestionChange={handleQuestionChange}
          onClaudeSessionId={handleClaudeSessionId}
          session={session}
          onResume={handleResume}
          onFork={handleFork}
          onForkWithPrompt={handleForkWithPrompt}
          currentModel={currentModel}
          onModelChange={onModelChange}
          activeModels={activeModels}
          onInputHeightChange={isVisible ? setChatInputHeight : undefined}
          onEditFile={handleEditFile}
          onOpenFile={onOpenFile}
          onAvailableModels={onAvailableModels}
          onRename={handleRename}
          onMarkTitleGenerated={handleMarkTitleGenerated}
          onClearPendingPrompt={handleClearPendingPrompt}
          onNavigateToSession={onNavigateToSession}
          onPermissionModeChange={handlePermissionModeChange}
          parentSession={parentSession}
          childSessions={childSessions}
        />
      </ErrorBoundary>
    </div>
  );
});

export default function App() {
  const {
    sessions,
    workspaces,
    activeSessionId,
    effectiveSessionId,
    activeWorktreePath,
    youngestDescendantMap,
    selectSession,
    createSession,
    createWorktree,
    archiveSession,
    unarchiveSession,
    archiveWorktree,
    deleteSession,
    renameSession,
    markTitleGenerated,
    clearPendingPrompt,
    markStopped,
    restartSession,
    touchSession,
    updateClaudeSessionId,
    setAgentBusy,
    setAgentUsage,
    setSessionDraft,
    setSessionQuestion,
    updatePermissionMode,
  } = useSessionContext();

  const { showError } = useToast();
  const { sessionUsage, unreadSessions } = useSessionLive();
  const { update, status, progress, install, dismiss } = useUpdater(showError);

  // Recent directories helpers
  const MAX_RECENT_DIRS = 8;
  const loadRecentDirs = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem("claude-orchestrator-recent-dirs") || "[]");
    } catch { return []; }
  };
  const saveRecentDir = (dir: string) => {
    const normalized = dir.replace(/\/+$/, "") || dir;
    const recent = loadRecentDirs()
      .map((d) => d.replace(/\/+$/, "") || d)
      .filter((d) => d !== normalized);
    recent.unshift(normalized);
    localStorage.setItem(
      "claude-orchestrator-recent-dirs",
      JSON.stringify(recent.slice(0, MAX_RECENT_DIRS))
    );
  };

  // ── Parent/child session maps (for fork linking) ────────────────
  const sessionNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) map.set(s.id, s.name);
    return map;
  }, [sessions]);

  const childSessionsMap = useMemo(() => {
    const map = new Map<string, Array<{ id: string; name: string; claudeSessionId?: string; directory?: string; status: string }>>();
    for (const s of sessions) {
      if (s.parentSessionId) {
        const arr = map.get(s.parentSessionId) || [];
        arr.push({ id: s.id, name: s.name, claudeSessionId: s.claudeSessionId, directory: s.directory, status: s.status });
        map.set(s.parentSessionId, arr);
      }
    }
    return map;
  }, [sessions]);

  // Pre-computed parent info map — avoids per-render IIFE that creates new object
  // references on every render and defeats React.memo on SessionPanel.
  const parentSessionMap = useMemo(() => {
    const map = new Map<string, { id: string; name: string; claudeSessionId?: string; directory?: string } | null>();
    for (const s of sessions) {
      if (s.parentSessionId) {
        const parent = sessions.find((p) => p.id === s.parentSessionId);
        map.set(s.id, parent
          ? { id: parent.id, name: parent.name, claudeSessionId: parent.claudeSessionId, directory: jsonlDirectory(parent) }
          : { id: s.parentSessionId, name: sessionNameMap.get(s.parentSessionId) || "Unknown" });
      } else {
        map.set(s.id, null);
      }
    }
    return map;
  }, [sessions, sessionNameMap]);

  // Directory dialog state
  const [showUsagePanel, setShowUsagePanel] = useState(false);
  const [showFileEditor, setShowFileEditor] = useState(false);
  const [editorFilePath, setEditorFilePath] = useState<string | undefined>();
  const [showDirDialog, setShowDirDialog] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [dirInput, setDirInput] = useState(() =>
    localStorage.getItem("claude-orchestrator-last-dir") || "~"
  );
  const [recentDirs, setRecentDirs] = useState<string[]>(loadRecentDirs);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [permissionMode, setPermissionMode] = useState<"bypassPermissions" | "plan">("plan");
  const [creating, setCreating] = useState(false);
  const [dirInputDirty, setDirInputDirty] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [addDirMode, setAddDirMode] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>("claude-code");
  // Track exact last-used session directory (including worktree paths)
  const [preselectedDir, setPreselectedDir] = useState<string | null>(null);

  // ── Panel state (replaces per-workspace tab state) ──────────────
  const [activePanel, setActivePanel] = useState<"prs" | "shell" | null>(null);
  const [, setChatInputHeight] = useState(0);

  // ── New layout state ─────────────────────────────────────────────
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() => {
    try { return JSON.parse(localStorage.getItem("ui:drawerOpen") ?? "true"); } catch { return true; }
  });
  const [railOpen, setRailOpen] = useState<boolean>(() => {
    try { return JSON.parse(localStorage.getItem("ui:railOpen") ?? "false"); } catch { return false; }
  });
  const [railTab, setRailTab] = useState<"git" | "cost">(() => {
    return (localStorage.getItem("ui:railTab") as "git" | "cost") ?? "git";
  });
  const [railWidth, setRailWidth] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem("ui:railWidth") ?? "320", 10);
    return isNaN(saved) ? 320 : saved;
  });
  const isResizingRail = useRef(false);

  // ── Model picker (per-provider, persisted) ──────────────────
  const [modelByProvider, setModelByProvider] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("claude-orchestrator-models") || "{}");
    } catch { return {}; }
  });

  const [selectedGitFile, setSelectedGitFile] = useState<{ path: string; seq: number; diff?: string } | undefined>();
  const fileSelectionSeqRef = useRef(0);
  const handleOpenFile = useCallback((filePath: string, diff?: string) => {
    setSelectedGitFile({ path: filePath, seq: ++fileSelectionSeqRef.current, diff });
    setRailOpen(true);
    setRailTab("git");
  }, []);

  const handleModelChange = useCallback((modelId: string) => {
    const provider: AgentProvider = sessions.find((s) => s.id === activeSessionId)?.provider || "claude-code";
    setModelByProvider((prev) => {
      const next = { ...prev, [provider]: modelId };
      localStorage.setItem("claude-orchestrator-models", JSON.stringify(next));
      return next;
    });
    // Send set_model to the active session's agent
    if (activeSessionId) {
      const msg = JSON.stringify({ type: "set_model", model: modelId });
      invoke("send_agent_message", { sessionId: activeSessionId, message: msg }).catch(() => {});
    }
  }, [activeSessionId, sessions]);

  useEffect(() => { localStorage.setItem("ui:drawerOpen", JSON.stringify(drawerOpen)); }, [drawerOpen]);
  useEffect(() => { localStorage.setItem("ui:railOpen", JSON.stringify(railOpen)); }, [railOpen]);
  useEffect(() => { localStorage.setItem("ui:railTab", railTab); }, [railTab]);
  useEffect(() => { localStorage.setItem("ui:railWidth", String(railWidth)); }, [railWidth]);

  // ── Pre-warm context menu IPC + icon cache ─────────────────────
  useEffect(() => {
    prewarmContextMenu();
  }, []);

  // ── Provider availability (detect installed CLIs) ─────────────
  const [providerAvailability, setProviderAvailability] = useState<Record<string, boolean>>({});
  useEffect(() => {
    invoke<Record<string, boolean>>("check_providers").then(setProviderAvailability).catch(() => {});
  }, []);

  // ── Dynamic OpenCode models (fetched at startup) ─────────────
  const [opencodeModels, setOpencodeModels] = useState<OpenCodeModel[]>([]);

  // Fetch opencode models once at startup (only if opencode is available)
  useEffect(() => {
    invoke<string>("fetch_opencode_models").then((json) => {
      try {
        const models: OpenCodeModel[] = JSON.parse(json);
        if (models.length > 0) {
          setOpencodeModels(models);
          // Default to first model if none selected yet
          setModelByProvider((prev) => {
            if (prev["opencode"]) return prev;
            const modelKey = `${models[0].providerID}/${models[0].id}`;
            const next = { ...prev, opencode: modelKey };
            localStorage.setItem("claude-orchestrator-models", JSON.stringify(next));
            return next;
          });
        }
      } catch {}
    }).catch((err) => console.warn("Failed to fetch opencode models:", err));
  }, []);

  const handleAvailableModels = useCallback((models: OpenCodeModel[]) => {
    setOpencodeModels((prev) => {
      if (prev.length === models.length && prev[0]?.id === models[0]?.id) return prev;
      return models;
    });
    setModelByProvider((prev) => {
      if (prev["opencode"]) return prev;
      const freeModel = models.find((m) => m.free);
      if (!freeModel) return prev;
      const modelKey = `${freeModel.providerID}/${freeModel.id}`;
      const next = { ...prev, opencode: modelKey };
      localStorage.setItem("claude-orchestrator-models", JSON.stringify(next));
      return next;
    });
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === effectiveSessionId) ?? null,
    [sessions, effectiveSessionId]
  );

  const activeProvider: AgentProvider = activeSession?.provider || "claude-code";
  const activeModels: ModelOption[] = useMemo(() => {
    if (activeProvider === "opencode" && opencodeModels.length > 0) {
      // Convert dynamic models to ModelOption format, free first
      const free = opencodeModels.filter((m) => m.free);
      const paid = opencodeModels.filter((m) => !m.free);
      return [
        ...free.map((m) => ({ id: `${m.providerID}/${m.id}`, name: m.name, desc: "Free", free: true as const })),
        ...paid.map((m) => ({ id: `${m.providerID}/${m.id}`, name: m.name, desc: `$${m.costIn}/${m.costOut} per MTok`, free: false as const })),
      ];
    }
    return modelsForProvider(activeProvider);
  }, [activeProvider, opencodeModels]);
  const selectedModel = modelByProvider[activeProvider] || (
    activeProvider === "opencode" && activeModels.length > 0
      ? activeModels[0].id // first free model
      : defaultModelForProvider(activeProvider)
  );

  const panelDirectory = activeSession?.directory ?? "~";

  const totalCostToday = useMemo(
    () => [...sessionUsage.values()].reduce((sum, u) => sum + (u.costUsd ?? 0), 0),
    [sessionUsage]
  );
  const unreadCount = unreadSessions?.size ?? 0;

  // Sanitize directory path into a Tauri-event-safe session ID.
  // Tauri v2 event names only allow alphanumeric, '-', '/', ':', '_'.
  const sanitizeDir = (dir: string) => dir.replace(/[^a-zA-Z0-9\-_/:]/g, "_");

  // Global shell tabs (not scoped to any workspace)
  type ShellTab = { id: string; num: number; directory: string };
  const [shellTabs, setShellTabs] = useState<ShellTab[]>([]);
  const [activeShellId, setActiveShellId] = useState<string | null>(null);
  const [showShellPicker, setShowShellPicker] = useState(false);
  const [shellPickerIndex, setShellPickerIndex] = useState(0);

  const shellCounter = useRef(0);
  const shellProcessDirs = useShellProcessStatus(shellTabs);


  const suggestionsRef = useRef<HTMLDivElement>(null);
  const dirListRef = useRef<HTMLDivElement>(null);

  const addShellTab = async (dir: string) => {
    const num = ++shellCounter.current;
    const sid = `shell-${sanitizeDir(dir)}-${num}`;
    try {
      await invoke("create_shell_pty_session", { sessionId: sid, directory: dir });
      const tab: ShellTab = { id: sid, num, directory: dir };
      setShellTabs((prev) => [...prev, tab]);
      setActiveShellId(sid);
    } catch (err) {
      console.error("Failed to create shell PTY:", err);
    }
  };

  // Ref to notify PRPanel to reset to list view
  const prPanelResetRef = useRef<(() => void) | null>(null);

  const togglePanel = (panel: "prs" | "shell") => {
    if (activePanel === panel) {
      // Already on this panel — reset internal state (e.g. PR review → PR list)
      if (panel === "prs") prPanelResetRef.current?.();
      return;
    }
    setActivePanel(panel);
  };

  // Close shell picker when clicking outside
  useEffect(() => {
    if (!showShellPicker) return;
    const close = () => setShowShellPicker(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [showShellPicker]);

  // Ctrl+N/P navigation for shell worktree pickers
  const allWorktrees = workspaces.flatMap((ws) => ws.worktrees);
  const shellPickerVisible = activePanel === "shell" && (shellTabs.length === 0 || showShellPicker);

  useEffect(() => {
    if (!shellPickerVisible) return;
    setShellPickerIndex(0);
  }, [shellPickerVisible]);

  useEffect(() => {
    if (!shellPickerVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "n") {
        e.preventDefault();
        setShellPickerIndex((i) => Math.min(i + 1, allWorktrees.length - 1));
      } else if (e.ctrlKey && e.key === "p") {
        e.preventDefault();
        setShellPickerIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const wt = allWorktrees[shellPickerIndex];
        if (wt) {
          addShellTab(wt.path);
          setShowShellPicker(false);
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [shellPickerVisible, allWorktrees, shellPickerIndex]);

  // Cmd+N to open new session dialog, Cmd+G/P/T to toggle panels
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't fire app shortcuts when a modal is already open
      const anyModalOpen = showDirDialog || showCommandPalette;

      if (e.metaKey && e.key === "n") {
        e.preventDefault();
        if (anyModalOpen) return;
        setDirInput(localStorage.getItem("claude-orchestrator-last-dir") || "~");
        setPreselectedDir(localStorage.getItem("claude-orchestrator-last-session-dir") || null);
        setRecentDirs(loadRecentDirs());
        setSearchFilter("");
        setAddDirMode(false);
        setShowDirDialog(true);
      }
      if (e.metaKey && e.key === "e") {
        e.preventDefault();
        const editor = localStorage.getItem("claude-orchestrator-editor-command") || "code";
        if (panelDirectory) {
          invoke("open_in_editor", { editor, filePath: panelDirectory });
        }
      }
      if (e.metaKey && e.key === "p") {
        e.preventDefault();
        togglePanel("prs");
      }
      if (e.metaKey && e.key === "t") {
        e.preventDefault();
        if (activePanel === "shell" && shellTabs.length > 0) {
          const activeTab = shellTabs.find((t) => t.id === activeShellId);
          const dir = activeTab?.directory ?? panelDirectory;
          addShellTab(dir);
        } else {
          togglePanel("shell");
        }
      }
      if (e.metaKey && e.key === "j") {
        e.preventDefault();
        setActivePanel(null);
      }
      if (e.metaKey && e.key === "k") {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
      }
      if (e.metaKey && e.shiftKey && e.key === "c") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("orchestrator-commit"));
      }
      if (e.metaKey && e.key === "b") {
        e.preventDefault();
        setDrawerOpen((v) => !v);
      }
      if (e.metaKey && e.key === "0") {
        e.preventDefault();
        selectSession(null as unknown as string); // go to overview
      }
      if (e.metaKey && e.key === "\\") {
        e.preventDefault();
        setRailOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activePanel, panelDirectory, showDirDialog, showCommandPalette, shellTabs, activeShellId]);

  // Wrap deleteSession to handle shell PTY lifecycle
  const handleDeleteSession = async (id: string) => {
    await deleteSession(id);
  };

  // Worktree creation dialog
  const [showWorktreeDialog, setShowWorktreeDialog] = useState(false);
  const [worktreeRepoDir, setWorktreeRepoDir] = useState("");
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [creatingWorktree, setCreatingWorktree] = useState(false);

  const handleCreateWorktree = (repoDir: string) => {
    setWorktreeRepoDir(repoDir);
    setWorktreeBranch("");
    setShowWorktreeDialog(true);
  };

  const handleWorktreeConfirm = async () => {
    if (!worktreeBranch.trim() || creatingWorktree) return;
    setCreatingWorktree(true);
    try {
      const path = await createWorktree(worktreeRepoDir, worktreeBranch.trim());
      setShowWorktreeDialog(false);
      localStorage.setItem("claude-orchestrator-last-session-dir", path);
      // Create a session in the new worktree
      await createSession(undefined, path, skipPermissions, undefined, undefined, undefined, undefined, permissionMode);
      setActivePanel(null);
    } catch (err) {
      console.error("Failed to create worktree:", err);
    } finally {
      setCreatingWorktree(false);
    }
  };

  // Branch info for all worktrees across all workspaces (shared hook, polls every 10s)
  const { branches: dialogBranches, byRepo: gitWorktreesByRepo } = useWorktreeBranches(workspaces);

  const handleNewSession = () => {
    setDirInput(localStorage.getItem("claude-orchestrator-last-dir") || "~");
    setDirInputDirty(false);
    setSuggestions([]);
    setPreselectedDir(localStorage.getItem("claude-orchestrator-last-session-dir") || null);
    const allRecent = loadRecentDirs();
    Promise.all(allRecent.map((d) => invoke<boolean>("directory_exists", { path: d }).catch(() => false)))
      .then((exists) => setRecentDirs(allRecent.filter((_, i) => exists[i])));
    setRecentDirs(allRecent);
    setSearchFilter("");
    setAddDirMode(false);
    setShowDirDialog(true);
  };

  // Recent dirs that aren't already a known workspace
  const extraRecentDirs = useMemo(() => {
    const knownRoots = new Set(workspaces.map((w) => w.directory));
    return recentDirs.filter((d) => !knownRoots.has(d));
  }, [recentDirs, workspaces]);

  // Filtered workspaces and recent dirs for search mode
  const filteredWorkspaces = useMemo(() => {
    // Filter out worktrees where all sessions are archived
    const activeWorkspaces = workspaces
      .map((ws) => ({
        ...ws,
        worktrees: ws.worktrees.filter(
          (wt) => wt.sessions.length === 0 || wt.sessions.some((s) => !s.archived)
        ),
      }))
      .filter((ws) => ws.worktrees.length > 0);

    if (!searchFilter) return activeWorkspaces;
    const lower = searchFilter.toLowerCase();
    return activeWorkspaces.flatMap((ws) => {
      const repoName = ws.directory.split("/").filter(Boolean).pop() || "";
      if (repoName.toLowerCase().includes(lower)) return [ws];
      const filteredWts = ws.worktrees.filter((wt) => {
        const wtName = wt.path.split("/").filter(Boolean).pop() || "";
        const branch = dialogBranches.get(wt.path) || "";
        return wtName.toLowerCase().includes(lower) || branch.toLowerCase().includes(lower);
      });
      if (filteredWts.length > 0) return [{ ...ws, worktrees: filteredWts }];
      return [];
    });
  }, [workspaces, searchFilter, dialogBranches]);

  const filteredExtraRecentDirs = useMemo(() => {
    if (!searchFilter) return extraRecentDirs;
    const lower = searchFilter.toLowerCase();
    return extraRecentDirs.filter((d) => {
      const name = d.split("/").filter(Boolean).pop() || d;
      return name.toLowerCase().includes(lower) || d.toLowerCase().includes(lower);
    });
  }, [extraRecentDirs, searchFilter]);

  // Flat list of all selectable paths in the dialog (for Ctrl+N/P navigation)
  const selectablePaths = useMemo(() => {
    const paths: string[] = [];
    for (const ws of filteredWorkspaces) {
      const existingPaths = new Set(ws.worktrees.map((wt) => wt.path));
      const gitWts = gitWorktreesByRepo.get(ws.directory) || [];
      const sessionlessWts = gitWts.filter((gwt) => !existingPaths.has(gwt.path));
      for (const wt of ws.worktrees) paths.push(wt.path);
      for (const gwt of sessionlessWts) paths.push(gwt.path);
    }
    for (const d of filteredExtraRecentDirs) paths.push(d);
    return paths;
  }, [filteredWorkspaces, gitWorktreesByRepo, filteredExtraRecentDirs]);

  // Auto-select first available provider when dialog opens
  useEffect(() => {
    if (!showDirDialog || Object.keys(providerAvailability).length === 0) return;
    if (providerAvailability[selectedProvider] === false) {
      const available = AGENT_PROVIDERS.find((p) => providerAvailability[p.id] !== false);
      if (available) setSelectedProvider(available.id);
    }
  }, [showDirDialog, providerAvailability]);

  // Scroll selected item into view when navigating with Cmd+N/P
  useEffect(() => {
    if (!preselectedDir || !dirListRef.current) return;
    const el = dirListRef.current.querySelector(`[data-path="${CSS.escape(preselectedDir)}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [preselectedDir]);

  const handleDirConfirm = async () => {
    const dir = dirInput.trim();
    if (!dir || creating || providerAvailability[selectedProvider] === false) return;
    setCreating(true);
    const rootDir = repoRootDir(dir);
    localStorage.setItem("claude-orchestrator-last-dir", rootDir);
    localStorage.setItem("claude-orchestrator-last-session-dir", dir);
    saveRecentDir(rootDir);
    setShowDirDialog(false);
    try {
      await createSession(undefined, dir, skipPermissions, undefined, undefined, selectedProvider, selectedModel, permissionMode);
      setActivePanel(null);
    } finally {
      setCreating(false);
    }
  };

  const handleDirCancel = () => {
    setShowDirDialog(false);
    setSuggestions([]);
  };

  // Fetch directory suggestions as user types (only after manual edits)
  const suggestionsVersion = useRef(0);
  useEffect(() => {
    const version = ++suggestionsVersion.current;
    if (!showDirDialog || !addDirMode || !dirInput.trim() || !dirInputDirty) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      invoke<string[]>("list_directories", { partial: dirInput })
        .then((dirs) => {
          if (suggestionsVersion.current === version) {
            setSuggestions(dirs);
            setSelectedIdx(-1);
          }
        })
        .catch((err) => {
          console.error("Failed to list directories:", err);
          if (suggestionsVersion.current === version) {
            setSuggestions([]);
          }
        });
    }, 100);
    return () => clearTimeout(timer);
  }, [dirInput, showDirDialog, dirInputDirty, addDirMode]);

  const acceptSuggestion = (path: string) => {
    setDirInput(path + "/");
    setSuggestions([]);
  };

  const quickCreate = async (dir: string) => {
    if (creating || providerAvailability[selectedProvider] === false) return;
    setCreating(true);
    // Save the repo root as last-dir so worktrees are always listed from the main repo
    const rootDir = repoRootDir(dir);
    localStorage.setItem("claude-orchestrator-last-dir", rootDir);
    localStorage.setItem("claude-orchestrator-last-session-dir", dir);
    saveRecentDir(rootDir);
    setShowDirDialog(false);
    try {
      await createSession(undefined, dir, skipPermissions, undefined, undefined, selectedProvider, selectedModel, permissionMode);
      setActivePanel(null);
    } finally {
      setCreating(false);
    }
  };

  const handleSelectSession = (id: string) => {
    startTransition(() => {
      selectSession(id);
      setActivePanel(null);
    });
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[var(--bg-primary)]">
      {update && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss(); }}>
          <div
            className="flex flex-col bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl w-[360px]"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-[var(--border-color)]">
              <div className="text-sm font-semibold text-[var(--text-primary)]">Update available</div>
              <div className="text-xs text-[var(--text-secondary)] mt-0.5">Version {update.version} is ready to install.</div>
            </div>
            {status !== "idle" && (
              <div className="px-5 py-3 border-b border-[var(--border-color)]">
                <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1.5">
                  <span>{status === "installing" ? "Installing…" : "Downloading…"}</span>
                  {status === "downloading" && <span>{progress}%</span>}
                </div>
                <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-all duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}
            <div className="flex items-center justify-end gap-2 px-5 py-3">
              <button
                onClick={dismiss}
                disabled={status !== "idle"}
                className="px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
              >
                Dismiss
              </button>
              <button
                onClick={install}
                disabled={status !== "idle"}
                className="px-4 py-1.5 text-sm font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg transition-colors disabled:opacity-50"
              >
                {status === "idle" ? "Update & Restart" : status === "downloading" ? "Downloading…" : "Installing…"}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="flex flex-1 min-h-0 relative">
        {/* Activity bar */}
        <ActivityBar
          activeView={activeSessionId === null ? "overview" : "session"}
          drawerOpen={drawerOpen}
          activePanel={activePanel}
          totalCostToday={totalCostToday}
          unreadCount={unreadCount}
          onOverview={() => {
            startTransition(() => selectSession(null as unknown as string));
            setActivePanel(null);
          }}
          onToggleSidebar={() => setDrawerOpen((v) => !v)}
          onSessionsClick={() => {
            setActivePanel(null);
            if (activeSessionId === null) {
              const last = sessions.slice().sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0];
              if (last) startTransition(() => selectSession(last.id));
            }
          }}
          onTogglePRs={() => togglePanel("prs")}
          onToggleShell={() => togglePanel("shell")}
          onNewSession={handleNewSession}
          onShowUsage={() => setShowUsagePanel(true)}
          onOpenInEditor={() => {
            const editor = localStorage.getItem("claude-orchestrator-editor-command") || "code";
            if (panelDirectory) {
              invoke("open_in_editor", { editor, filePath: panelDirectory });
            }
          }}
        />

        {/* Session drawer */}
        <div
          className="overflow-hidden shrink-0 transition-all duration-200 h-full"
          style={{
            width: drawerOpen ? 280 : 0,
            background: "var(--drawer-bg)",
            borderRight: drawerOpen ? "1px solid var(--border-subtle)" : "none",
          }}
        >
          <div style={{ width: 280, height: "100%" }}>
            <Sidebar
              workspaces={workspaces}
              activeSessionId={activeSessionId}
              activeWorktreePath={activeWorktreePath}
              onSelectSession={handleSelectSession}
              onCreateSession={handleNewSession}
              onCreateWorktree={handleCreateWorktree}
              onRenameSession={renameSession}
              onDeleteSession={handleDeleteSession}
              onArchiveSession={archiveSession}
              onUnarchiveSession={unarchiveSession}
              onArchiveWorktree={archiveWorktree}
              shellProcessDirs={shellProcessDirs}
              worktreeBranches={dialogBranches}
              youngestDescendantMap={youngestDescendantMap}
            />
          </div>
        </div>

        {/* Context rail toggle button — always at top-right of workspace */}
        {activeSessionId && (
          <button
            onClick={() => setRailOpen((v) => !v)}
            className="absolute top-2 right-2 z-20 p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text-normal)] hover:bg-[var(--bg-hover)] transition-colors"
            title={railOpen ? "Hide context rail (⌘\\)" : "Show context rail (⌘\\)"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              {railOpen
                ? <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>
                : <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
              }
            </svg>
          </button>
        )}

        {/* Main area */}
        <div className="flex-1 min-w-0 relative">
          {/* Overview dashboard — shown when no session selected */}
          {activeSessionId === null && activePanel === null && (
            <div className="absolute inset-0 flex flex-col bg-[var(--bg-primary)]" style={{ zIndex: 1 }}>
              <OverviewDashboard
                workspaces={workspaces}
                sessionUsage={sessionUsage}
                onSelectSession={handleSelectSession}
                onNewSession={handleNewSession}
                youngestDescendantMap={youngestDescendantMap}
              />
            </div>
          )}

          {/* Content area */}
          <div className="absolute inset-0">
            <div className="absolute inset-0 flex flex-col">
              <div className="flex-1 min-h-0 relative">
              {/* Session panels — one per session, visibility-toggled */}
              {sessions.map((session) => (
                <SessionPanel
                  key={session.id}
                  session={session}
                  isActive={session.id === effectiveSessionId}
                  activePanel={activePanel}
                  markStopped={markStopped}
                  touchSession={touchSession}
                  setAgentBusy={setAgentBusy}
                  setAgentUsage={setAgentUsage}
                  setSessionDraft={setSessionDraft}
                  setSessionQuestion={setSessionQuestion}
                  updateClaudeSessionId={updateClaudeSessionId}
                  renameSession={renameSession}
                  markTitleGenerated={markTitleGenerated}
                  clearPendingPrompt={clearPendingPrompt}
                  restartSession={restartSession}
                  createSession={createSession}
                  currentModel={selectedModel}
                  onModelChange={handleModelChange}
                  activeModels={activeModels}
                  setChatInputHeight={setChatInputHeight}
                  onAvailableModels={session.provider === "opencode" ? handleAvailableModels : undefined}
                  onNavigateToSession={handleSelectSession}
                  updatePermissionMode={updatePermissionMode}
                  parentSession={parentSessionMap.get(session.id)}
                  childSessions={childSessionsMap.get(session.id)}
                  onOpenFile={handleOpenFile}
                />
              ))}

              {/* PRs panel */}
              <div
                className={`absolute inset-0 bg-[var(--bg-primary)] ${activePanel === "prs" ? "animate-slide-in-right" : ""}`}
                style={{
                  zIndex: activePanel === "prs" ? 2 : 0,
                  pointerEvents: activePanel === "prs" ? "auto" : "none",
                  visibility: activePanel === "prs" ? "visible" : "hidden",
                }}
              >
                <PRPanel
                  directory={panelDirectory}
                  isActive={activePanel === "prs"}
                  onResetRef={prPanelResetRef}
                  onSwitchToClaude={() => setActivePanel(null)}
                  onAskClaude={(prompt) => {
                    if (!activeSessionId) return;
                    const jsonLine = JSON.stringify({
                      type: "user",
                      message: { role: "user", content: prompt },
                    });
                    invoke("send_agent_message", { sessionId: activeSessionId, message: jsonLine }).catch(() => {});
                    setActivePanel(null);
                  }}
                />
              </div>

              {/* Shell panel — global view, not scoped to active workspace */}
              <div
                className={`absolute inset-0 bg-[var(--bg-primary)] flex flex-col ${activePanel === "shell" ? "animate-slide-in-right" : ""}`}
                style={{
                  zIndex: activePanel === "shell" ? 2 : 0,
                  pointerEvents: activePanel === "shell" ? "auto" : "none",
                  visibility: activePanel === "shell" ? "visible" : "hidden",
                }}
              >
                {shellTabs.length === 0 ? (
                  /* Empty state — workspace/worktree picker */
                  <div className="flex-1 flex flex-col items-center justify-center gap-3">
                    <div className="text-sm font-medium text-[var(--text-primary)]">Open a terminal</div>
                    <div className="w-full max-w-xs overflow-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
                      {(() => {
                        let flatIdx = -1;
                        return workspaces.map((ws) => {
                          const repoName = ws.directory.split("/").filter(Boolean).pop() || ws.directory;
                          return (
                            <div key={ws.id}>
                              <div className="px-3 py-1.5 text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider border-b border-[var(--border-subtle)]">{repoName}</div>
                              {ws.worktrees.map((wt) => {
                                flatIdx++;
                                const idx = flatIdx;
                                const wtName = worktreeName(wt.path);
                                return (
                                  <button
                                    key={wt.path}
                                    onClick={() => addShellTab(wt.path)}
                                    onMouseEnter={() => setShellPickerIndex(idx)}
                                    className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                                      idx === shellPickerIndex
                                        ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
                                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                                    }`}
                                  >
                                    {wtName}
                                  </button>
                                );
                              })}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Shell tab bar */}
                    <div className="flex items-center gap-0.5 px-2 py-0.5 border-b border-[var(--border-color)] flex-shrink-0">
                      {shellTabs.map((tab, i) => {
                        const isActive = tab.id === activeShellId;
                        const repoName = repoRootDir(tab.directory).split("/").filter(Boolean).pop() || tab.directory;
                        const wtName = worktreeName(tab.directory);
                        const label = wtName === "main" ? repoName : `${repoName} / ${wtName}`;
                        return (
                          <div key={tab.id} className="flex items-center group">
                            <button
                              onClick={() => setActiveShellId(tab.id)}
                              className={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-l transition-colors ${
                                isActive
                                  ? "text-[var(--text-primary)] bg-[var(--bg-tertiary)] font-medium"
                                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50"
                              }`}
                            >
                              <span
                                className="w-1.5 h-1.5 rounded-full shrink-0 opacity-70"
                                style={{ background: repoColor(tab.directory) }}
                              />
                              {label}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setShellTabs((prev) => {
                                  const remaining = prev.filter((t) => t.id !== tab.id);
                                  if (isActive) {
                                    if (remaining.length > 0) {
                                      setActiveShellId(remaining[Math.min(i, remaining.length - 1)].id);
                                    } else {
                                      setActiveShellId(null);
                                      setActivePanel(null);
                                    }
                                  }
                                  return remaining;
                                });
                              }}
                              className={`px-1 py-0.5 text-[11px] rounded-r transition-colors opacity-0 group-hover:opacity-100 ${
                                isActive
                                  ? "text-[var(--text-tertiary)] bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50"
                              }`}
                              title="Close shell"
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        );
                      })}
                      {/* "+" button with workspace/worktree picker dropdown */}
                      <div className="relative" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => setShowShellPicker((v) => !v)}
                          className="px-1.5 py-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
                          title="New shell tab"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                          </svg>
                        </button>
                        {showShellPicker && (
                          <div className="absolute top-full left-0 mt-1 z-50 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg min-w-[180px] max-h-64 overflow-auto py-1">
                            {(() => {
                              let flatIdx = -1;
                              return workspaces.map((ws) => {
                                const repoName = ws.directory.split("/").filter(Boolean).pop() || ws.directory;
                                return (
                                  <div key={ws.id}>
                                    <div className="px-3 py-1 text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">{repoName}</div>
                                    {ws.worktrees.map((wt) => {
                                      flatIdx++;
                                      const idx = flatIdx;
                                      const wtName = worktreeName(wt.path);
                                      return (
                                        <button
                                          key={wt.path}
                                          onClick={() => {
                                            setShowShellPicker(false);
                                            addShellTab(wt.path);
                                          }}
                                          onMouseEnter={() => setShellPickerIndex(idx)}
                                          className={`w-full text-left px-4 py-1.5 text-sm transition-colors ${
                                            idx === shellPickerIndex
                                              ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
                                              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                                          }`}
                                        >
                                          {wtName}
                                        </button>
                                      );
                                    })}
                                  </div>
                                );
                              });
                            })()}
                          </div>
                        )}
                      </div>
                    </div>
                    {/* Shell terminals — all mounted, visibility driven by activeShellId */}
                    <div className="flex-1 min-h-0 relative">
                      {shellTabs.map((tab) => {
                        const isTabActive = tab.id === activeShellId;
                        return (
                          <div
                            key={tab.id}
                            className="absolute inset-0"
                            style={{
                              zIndex: isTabActive ? 1 : 0,
                              pointerEvents: isTabActive ? "auto" : "none",
                              visibility: isTabActive ? "visible" : "hidden",
                            }}
                          >
                            <Terminal
                              sessionId={tab.id}
                              isActive={activePanel === "shell" && isTabActive}
                              onExit={() => {
                                setShellTabs((prev) => {
                                  const remaining = prev.filter((t) => t.id !== tab.id);
                                  if (tab.id === activeShellId) {
                                    if (remaining.length > 0) {
                                      setActiveShellId(remaining[0].id);
                                    } else {
                                      setActiveShellId(null);
                                      setActivePanel(null);
                                    }
                                  }
                                  return remaining;
                                });
                              }}
                              onTitleChange={() => {}}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
              </div>
            </div>

          </div>
        </div>

        {/* Context rail */}
        <div
          className="overflow-hidden shrink-0 relative"
          style={{ width: railOpen && activeSessionId ? railWidth : 0, transition: isResizingRail.current ? "none" : "width 200ms ease" }}
        >
          {/* Drag handle */}
          {railOpen && activeSessionId && (
            <div
              className="absolute left-0 top-0 bottom-0 w-1 z-10 cursor-col-resize hover:bg-[var(--accent)]/40 active:bg-[var(--accent)]/60 transition-colors"
              onMouseDown={(e) => {
                e.preventDefault();
                isResizingRail.current = true;
                const startX = e.clientX;
                const startWidth = railWidth;
                const onMove = (ev: MouseEvent) => {
                  const delta = startX - ev.clientX;
                  setRailWidth(Math.max(200, Math.min(700, startWidth + delta)));
                };
                const onUp = () => {
                  isResizingRail.current = false;
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
            />
          )}
          <div
            className="h-full"
            style={{
              width: railWidth,
              transform: railOpen && activeSessionId ? "translateX(0)" : `translateX(${railWidth}px)`,
              transition: isResizingRail.current ? "none" : "transform 150ms ease",
              willChange: "transform",
            }}
          >
            {activeSessionId && (
              <ContextRail
                directory={panelDirectory}
                sessionUsage={sessionUsage}
                activeSessionId={activeSessionId}
                defaultTab={railTab}
                onTabChange={setRailTab}
                selectedFile={selectedGitFile}
              />
            )}
          </div>
        </div>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dialog-backdrop animate-backdrop" onMouseDown={handleDirCancel}>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl w-[420px] shadow-[0_16px_48px_rgba(0,0,0,0.5)] ring-1 ring-white/[0.04] flex flex-col overflow-hidden animate-scale-in" onMouseDown={(e) => e.stopPropagation()}>
            {/* Search / path-entry input */}
            <div className="px-4 pt-4 pb-3">
              {!addDirMode ? (
                /* Search mode */
                <div className="relative">
                  <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-tertiary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input
                    autoFocus
                    value={searchFilter}
                    onChange={(e) => { setSearchFilter(e.target.value); setPreselectedDir(null); }}
                    onKeyDown={(e) => {
                      if (e.ctrlKey && (e.key === "n" || e.key === "p") && selectablePaths.length > 0) {
                        e.preventDefault();
                        const curIdx = preselectedDir ? selectablePaths.indexOf(preselectedDir) : -1;
                        let next: number;
                        if (curIdx === -1) {
                          next = e.key === "n" ? 0 : selectablePaths.length - 1;
                        } else {
                          next = e.key === "n"
                            ? (curIdx + 1) % selectablePaths.length
                            : (curIdx - 1 + selectablePaths.length) % selectablePaths.length;
                        }
                        setPreselectedDir(selectablePaths[next]);
                        return;
                      }
                      if (e.key === "Enter" && preselectedDir) {
                        quickCreate(preselectedDir);
                      } else if (e.key === "Escape") {
                        handleDirCancel();
                      }
                    }}
                    className="w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg pl-9 pr-10 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors"
                    placeholder="Search workspaces…"
                  />
                  {/* Add directory button */}
                  <button
                    onClick={() => { setAddDirMode(true); setDirInputDirty(false); setSuggestions([]); }}
                    title="Add directory"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                    </svg>
                  </button>
                </div>
              ) : (
                /* Add directory mode */
                <div className="relative">
                  <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-tertiary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.06-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
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
                          setAddDirMode(false);
                        }
                      }
                    }}
                    className="w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg pl-9 pr-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] font-mono transition-colors"
                    placeholder="Type a path…"
                  />
                </div>
              )}
            </div>

            {/* Autocomplete suggestions (add-dir mode only) */}
            {addDirMode && suggestions.length > 0 && dirInputDirty && (
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

            {/* Provider picker */}
            <div className="px-4 pb-2 flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                {AGENT_PROVIDERS.map((p) => {
                  const available = providerAvailability[p.id] !== false;
                  return (
                    <button
                      key={p.id}
                      onClick={() => available && setSelectedProvider(p.id)}
                      disabled={!available}
                      className={`px-2.5 py-1 text-[10px] font-medium rounded-md transition-colors ${
                        !available
                          ? "bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] opacity-50 cursor-not-allowed"
                          : selectedProvider === p.id
                            ? "bg-[var(--accent)] text-white"
                            : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      }`}
                      title={!available ? `${p.label} CLI not found` : undefined}
                    >
                      {p.label}{!available && " (not installed)"}
                    </button>
                  );
                })}
              </div>
              {providerAvailability[selectedProvider] === false && (
                <div className="text-[10px] text-[var(--text-tertiary)] px-0.5">
                  {selectedProvider === "claude-code"
                    ? "Install Claude Code: npm install -g @anthropic-ai/claude-code"
                    : "Install OpenCode: curl -fsSL https://opencode.ai/install | bash"}
                </div>
              )}
            </div>

            {/* Workspace tree + recent dirs */}
            {(filteredWorkspaces.length > 0 || filteredExtraRecentDirs.length > 0) && (
              <div ref={dirListRef} className="max-h-[340px] overflow-y-auto border-t border-[var(--border-color)]">
                {/* Workspace tree */}
                {filteredWorkspaces.map((ws) => {
                  const repoName = ws.directory.split("/").filter(Boolean).pop() || ws.directory;
                  const color = repoColor(ws.directory);

                  return (
                    <div key={ws.id} className="py-1">
                      {/* Repo header */}
                      <div className="flex items-center gap-2 px-4 pt-1.5 pb-1">
                        <svg className="w-3.5 h-3.5 shrink-0" style={{ color }} viewBox="0 0 16 16" fill="currentColor">
                          <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
                        </svg>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
                          {repoName}
                        </span>
                      </div>
                      {/* Worktree rows (merge in git worktrees that have no sessions) */}
                      {(() => {
                        const existingPaths = new Set(ws.worktrees.map((wt) => wt.path));
                        const gitWts = gitWorktreesByRepo.get(ws.directory) || [];
                        const sessionlessWts = gitWts
                          .filter((gwt) => !existingPaths.has(gwt.path))
                          .map((gwt) => ({
                            path: gwt.path,
                            branch: gwt.branch,
                            isMain: gwt.isMain,
                            sessions: [] as Session[],
                            lastActiveAt: 0,
                          }));
                        return [...ws.worktrees, ...sessionlessWts];
                      })().map((wt) => {
                        const isMain = wt.isMain;
                        const wtLabel = isMain ? "main" : wt.path.split("/").filter(Boolean).pop() || wt.path;
                        const branch = dialogBranches.get(wt.path) || "";
                        const sessionCount = wt.sessions.filter((s) => !s.archived).length;

                        return (
                          <button
                            key={wt.path}
                            data-path={wt.path}
                            onClick={() => quickCreate(wt.path)}
                            className={`w-full flex items-center gap-3 pl-8 pr-4 py-1.5 text-left transition-colors group ${
                              preselectedDir === wt.path
                                ? "bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]/30"
                                : "hover:bg-[var(--bg-hover)]"
                            }`}
                          >
                            <svg className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]" viewBox="0 0 16 16" fill="currentColor">
                              <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                            </svg>
                            <div className="min-w-0 flex-1">
                              <div className="text-xs text-[var(--text-primary)] truncate">
                                <span className="font-medium">{wtLabel}</span>
                                {branch && (
                                  <span className="text-[var(--text-tertiary)] font-normal ml-1">
                                    ({branch})
                                  </span>
                                )}
                              </div>
                            </div>
                            {preselectedDir === wt.path && (
                              <span className="text-[9px] text-[var(--accent)] font-medium shrink-0 opacity-70">
                                Enter
                              </span>
                            )}
                            {sessionCount > 0 && (
                              <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">
                                {sessionCount}
                              </span>
                            )}
                          </button>
                        );
                      })}
                      {/* New worktree action */}
                      <button
                        onClick={() => {
                          setShowDirDialog(false);
                          handleCreateWorktree(ws.directory);
                        }}
                        className="w-full flex items-center gap-3 pl-8 pr-4 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                      >
                        <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                        </svg>
                        <span className="text-[11px]">New worktree</span>
                      </button>
                    </div>
                  );
                })}

                {/* Extra recent dirs (not already a workspace) */}
                {filteredExtraRecentDirs.length > 0 && (
                  <div>
                    <div className="px-4 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                      Recent
                    </div>
                    {filteredExtraRecentDirs.map((d) => (
                      <button
                        key={d}
                        data-path={d}
                        onClick={() => quickCreate(d)}
                        className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors group ${
                          preselectedDir === d
                            ? "bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]/30"
                            : "hover:bg-[var(--bg-hover)]"
                        }`}
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
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border-color)]">
              <div className="flex items-center gap-1 bg-[var(--bg-tertiary)] rounded-md p-0.5">
                <button
                  onClick={() => { setPermissionMode("bypassPermissions"); setSkipPermissions(true); }}
                  className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                    permissionMode === "bypassPermissions"
                      ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  }`}
                >
                  Auto
                </button>
                <button
                  onClick={() => { setPermissionMode("plan"); setSkipPermissions(false); }}
                  className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                    permissionMode === "plan"
                      ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm"
                      : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                  }`}
                >
                  Plan
                </button>
              </div>
              <div className="flex gap-2">
                {addDirMode ? (
                  <>
                    <button
                      onClick={() => setAddDirMode(false)}
                      className="px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      Back
                    </button>
                    <button
                      onClick={handleDirConfirm}
                      disabled={creating}
                      className="px-4 py-1.5 text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md transition-colors font-medium"
                    >
                      {creating ? "Creating…" : "Create"}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleDirCancel}
                    className="px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Command palette */}
      <CommandPalette
        isOpen={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        sessions={sessions}
        workspaces={workspaces}
        activeSessionId={activeSessionId}
        youngestDescendantMap={youngestDescendantMap}
        onSelectSession={handleSelectSession}
        onCreateSession={handleNewSession}
        onToggleSidebar={() => {}} // sidebar always visible
        onOpenUsage={() => setShowUsagePanel(true)}
        onOpenPRs={() => togglePanel("prs")}
        onOpenShell={() => togglePanel("shell")}
      />

      {/* Worktree creation dialog */}
      {showWorktreeDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dialog-backdrop animate-backdrop" onMouseDown={() => setShowWorktreeDialog(false)}>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl w-[380px] shadow-[0_16px_48px_rgba(0,0,0,0.5)] ring-1 ring-white/[0.04] flex flex-col overflow-hidden animate-scale-in" onMouseDown={(e) => e.stopPropagation()}>
            <div className="px-4 pt-4 pb-2">
              <div className="text-sm font-medium text-[var(--text-primary)] mb-1">New Worktree</div>
              <div className="text-[11px] text-[var(--text-tertiary)] font-mono truncate mb-3">
                {worktreeRepoDir}
              </div>
              <input
                autoFocus
                value={worktreeBranch}
                onChange={(e) => setWorktreeBranch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleWorktreeConfirm();
                  if (e.key === "Escape") setShowWorktreeDialog(false);
                }}
                placeholder="Branch name…"
                className="w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] font-mono transition-colors"
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border-subtle)]">
              <button
                onClick={() => setShowWorktreeDialog(false)}
                className="px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleWorktreeConfirm}
                disabled={creatingWorktree || !worktreeBranch.trim()}
                className="px-4 py-1.5 text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md transition-colors font-medium"
              >
                {creatingWorktree ? "Creating…" : "Create Worktree"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
