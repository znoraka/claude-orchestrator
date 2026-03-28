// Plan mode test comment
import { useRef, useState, useEffect, useMemo, useCallback, memo, startTransition } from "react";
import { invoke, isTauri } from "./lib/bridge";
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
import { repoRootDir, normalizeDir } from "./utils/workspaces";
import NewSessionPanel from "./components/NewSessionPanel";
import type { VirtualSessionState } from "./components/NewSessionPanel";
import { useWorktreeBranches } from "./hooks/useWorktreeBranches";
import { useShellProcessStatus } from "./hooks/useShellProcessStatus";
import { defaultModelForProvider, jsonlDirectory, modelsForProvider, type AgentProvider, type ModelOption, type Session } from "./types";
import CommandPalette from "./components/CommandPalette";
import { useUpdater } from "./hooks/useUpdater";
import { useToast } from "./components/Toast";
import ActivityBar from "./components/ActivityBar";
import TitleBar from "./components/TitleBar";
import { useMobileLayout } from "./hooks/useMobileLayout";
import CommitModal from "./components/CommitModal";
import FileDiffModal from "./components/FileDiffModal";
import { Spinner } from "./components/ui/spinner";
import OverviewDashboard from "./components/OverviewDashboard";
import ContextRail from "./components/ContextRail";
import { useSessionLive } from "./contexts/SessionContext";
import { useBridgeConnection } from "./hooks/useBridgeConnection";
import PullToRefresh from "./components/PullToRefresh";
import { useNavigate, useRouterState } from "@tanstack/react-router";

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
  createTerminalSession,
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
  providerAvailability,
  onProviderChange,
  onStartPendingSession,
  onOpenPRPanel,
  onChangedFiles,
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
  createTerminalSession: (directory: string, name?: string) => Promise<string>;
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
  providerAvailability: Record<string, boolean>;
  onProviderChange: (provider: AgentProvider) => void;
  onStartPendingSession: (provider: AgentProvider, model: string) => Promise<void>;
  onOpenPRPanel?: (prNumber: number) => void;
  onChangedFiles?: (files: Map<string, import("./components/chat/types").ChangedFile[]>) => void;
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

  const handleCreateTerminal = useCallback((directory: string, command?: string) => {
    createTerminalSession(directory).then((newId) => {
      if (command) {
        setTimeout(() => {
          invoke("write_to_pty", { sessionId: newId, data: command + "\r" }).catch(console.error);
        }, 400);
      }
    }).catch(console.error);
  }, [createTerminalSession]);

  const isTerminal = session.sessionType === "terminal";

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
        {isTerminal ? (
          <Terminal
            sessionId={session.id}
            isActive={isVisible}
            onExit={handleExit}
            onActivity={handleActivity}
          />
        ) : (
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
            providerAvailability={providerAvailability}
            onProviderChange={onProviderChange}
            onStartPendingSession={onStartPendingSession}
            onCreateTerminal={handleCreateTerminal}
            onOpenPRPanel={onOpenPRPanel}
            onChangedFiles={onChangedFiles}
          />
        )}
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
    youngestDescendantMap,
    selectSession,
    createSession,
    createTerminalSession,
    startPendingSession,
    updateSessionModel,
    updateSessionProvider,
    createWorktree,
    archiveSession,
    unarchiveSession,
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
  const bridgeState = useBridgeConnection();

  // Track terminal sessions with running commands for sidebar visibility
  const terminalShellTabs = useMemo(
    () => sessions
      .filter((s) => s.sessionType === "terminal" && s.status !== "stopped")
      .map((s) => ({ id: s.id, directory: s.directory })),
    [sessions]
  );
  const { busySessionIds: terminalBusyIds, foregroundCommands: terminalCommands } = useShellProcessStatus(terminalShellTabs);

  // Show disconnected overlay after 5s of failed connection
  const [showDisconnected, setShowDisconnected] = useState(false);
  useEffect(() => {
    if (bridgeState === "connected") {
      setShowDisconnected(false);
      return;
    }
    const t = setTimeout(() => setShowDisconnected(true), 5000);
    return () => clearTimeout(t);
  }, [bridgeState]);

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
  const [showSettings, setShowSettings] = useState(false);
  const [externalAccess, setExternalAccess] = useState<boolean | null>(null);

  // Load external access setting on mount
  useEffect(() => {
    invoke<boolean>("get_external_access", {}).then(setExternalAccess).catch(() => setExternalAccess(false));
  }, []);

  const handleToggleExternalAccess = useCallback(async (enabled: boolean) => {
    await invoke("set_external_access", { enabled });
    setExternalAccess(enabled);
  }, []);
  const [editorFilePath, setEditorFilePath] = useState<string | undefined>();
  const [showDirDialog, setShowDirDialog] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showCommitModal, setShowCommitModal] = useState(false);
  const [showEditorDropdown, setShowEditorDropdown] = useState(false);
  const [dirInput, setDirInput] = useState(() =>
    localStorage.getItem("claude-orchestrator-last-dir") || "~"
  );
  const [recentDirs, setRecentDirs] = useState<string[]>(loadRecentDirs);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [permissionMode, setPermissionMode] = useState<"bypassPermissions" | "plan">("bypassPermissions");
  const [creating, setCreating] = useState(false);
  const [dirInputDirty, setDirInputDirty] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [addDirMode, setAddDirMode] = useState(false);
  // Track exact last-used session directory (including worktree paths)
  const [preselectedDir, setPreselectedDir] = useState<string | null>(null);

  // ── Virtual sessions (per-worktree draft compose views) ─────────
  const [virtualSessions, setVirtualSessions] = useState<Map<string, VirtualSessionState>>(new Map());
  const [activeVirtualDir, setActiveVirtualDir] = useState<string | null>(null);

  const [, setChatInputHeight] = useState(0);

  // ── Responsive layout ────────────────────────────────────────────
  const isMobile = useMobileLayout();

  // ── Router-based navigation ──────────────────────────────────────
  const navigate = useNavigate();
  const { location } = useRouterState();
  const activePanel: "prs" | null = useMemo(() => {
    const path = location.pathname;
    if (path.endsWith("/prs")) return "prs";
    return null;
  }, [location.pathname]);

  const navigateToPanel = useCallback(
    (panel: "prs" | null) => {
      if (panel === null) {
        if (activeSessionId) {
          navigate({ to: "/session/$sessionId", params: { sessionId: activeSessionId } });
        } else {
          navigate({ to: "/" });
        }
      } else if (activeSessionId) {
        navigate({ to: "/session/$sessionId/prs", params: { sessionId: activeSessionId } });
      }
    },
    [navigate, activeSessionId]
  );

  // Sync URL → context for back/forward navigation
  useEffect(() => {
    const pathname = location.pathname;
    const match = pathname.match(/^\/session\/([^/]+)/);
    if (match) {
      const routeSessionId = decodeURIComponent(match[1]);
      if (routeSessionId !== activeSessionId) {
        startTransition(() => selectSession(routeSessionId));
      }
    } else if (pathname === "/" && activeSessionId) {
      startTransition(() => selectSession(null as unknown as string));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // ── New layout state ─────────────────────────────────────────────
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() => {
    try { return JSON.parse(localStorage.getItem("ui:drawerOpen") ?? "true"); } catch { return true; }
  });
  const [railOpen, setRailOpen] = useState<boolean>(() => {
    try { return JSON.parse(localStorage.getItem("ui:railOpen") ?? "false"); } catch { return false; }
  });
  const [railTab, setRailTab] = useState<"git" | "cost" | "turns">(() => {
    return (localStorage.getItem("ui:railTab") as "git" | "cost" | "turns") ?? "git";
  });
  const [railWidth, setRailWidth] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem("ui:railWidth") ?? "320", 10);
    return isNaN(saved) ? 320 : saved;
  });
  const isResizingRail = useRef(false);
  const railContainerRef = useRef<HTMLDivElement>(null);
  const railInnerRef = useRef<HTMLDivElement>(null);
  const railWidthDuringDrag = useRef<number>(320);
  const rafId = useRef<number | null>(null);

  // ── Model picker (per-provider, persisted) ──────────────────
  const [modelByProvider, setModelByProvider] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("claude-orchestrator-models") || "{}");
    } catch { return {}; }
  });

  const [selectedGitFile, setSelectedGitFile] = useState<{ path: string; seq: number; diff?: string } | undefined>();
  const fileSelectionSeqRef = useRef(0);
  const [fileDiffModal, setFileDiffModal] = useState<{ path: string; diff: string } | null>(null);
  const handleOpenFile = useCallback((filePath: string, diff?: string) => {
    if (diff !== undefined) {
      setFileDiffModal({ path: filePath, diff });
    } else {
      setSelectedGitFile({ path: filePath, seq: ++fileSelectionSeqRef.current, diff });
      setRailOpen(true);
      setRailTab("git");
    }
  }, []);

  // Per-session changed files from agent turns (keyed by session id → result id → files)
  const [sessionChangedFiles, setSessionChangedFiles] = useState<Map<string, Map<string, import("./components/chat/types").ChangedFile[]>>>(new Map());
  const handleChangedFilesCallbacks = useRef<Map<string, (files: Map<string, import("./components/chat/types").ChangedFile[]>) => void>>(new Map());
  const getChangedFilesCallback = useCallback((sessionId: string) => {
    let cb = handleChangedFilesCallbacks.current.get(sessionId);
    if (!cb) {
      cb = (files: Map<string, import("./components/chat/types").ChangedFile[]>) => {
        setSessionChangedFiles((prev) => {
          const next = new Map(prev);
          next.set(sessionId, files);
          return next;
        });
      };
      handleChangedFilesCallbacks.current.set(sessionId, cb);
    }
    return cb;
  }, []);

  const handleModelChange = useCallback((modelId: string) => {
    const provider: AgentProvider = sessions.find((s) => s.id === activeSessionId)?.provider || "claude-code";
    setModelByProvider((prev) => {
      const next = { ...prev, [provider]: modelId };
      localStorage.setItem("claude-orchestrator-models", JSON.stringify(next));
      return next;
    });
    if (activeSessionId) updateSessionModel(activeSessionId, modelId);
    // Send set_model to the active session's agent
    if (activeSessionId) {
      const msg = JSON.stringify({ type: "set_model", model: modelId });
      invoke("send_agent_message", { sessionId: activeSessionId, message: msg }).catch(() => {});
    }
  }, [activeSessionId, sessions, updateSessionModel]);

  const handleProviderChange = useCallback((sessionId: string, provider: AgentProvider) => {
    updateSessionProvider(sessionId, provider);
  }, [updateSessionProvider]);

  const handleStartPendingSession = useCallback(async (sessionId: string, provider: AgentProvider, model: string) => {
    await startPendingSession(sessionId, provider, model || undefined);
  }, [startPendingSession]);

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

  // ── Dynamic Codex models (fetched at startup) ─────────────────
  const [codexModels, setCodexModels] = useState<ModelOption[]>([]);

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

  useEffect(() => {
    invoke<string>("fetch_codex_models").then((json) => {
      try {
        const models: ModelOption[] = JSON.parse(json);
        if (models.length > 0) {
          setCodexModels(models);
          setModelByProvider((prev) => {
            if (prev["codex"]) return prev;
            const next = { ...prev, codex: models[0].id };
            localStorage.setItem("claude-orchestrator-models", JSON.stringify(next));
            return next;
          });
        }
      } catch {}
    }).catch(() => {});
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
    if (activeProvider === "codex" && codexModels.length > 0) {
      return codexModels;
    }
    return modelsForProvider(activeProvider);
  }, [activeProvider, opencodeModels, codexModels]);

  const virtualActiveModels = useMemo(() => {
    const virtualProvider = activeVirtualDir
      ? virtualSessions.get(activeVirtualDir)?.provider
      : undefined;
    if (!virtualProvider) return activeModels;
    if (virtualProvider === "opencode" && opencodeModels.length > 0) {
      const free = opencodeModels.filter((m) => m.free);
      const paid = opencodeModels.filter((m) => !m.free);
      return [
        ...free.map((m) => ({ id: `${m.providerID}/${m.id}`, name: m.name, desc: "Free", free: true as const })),
        ...paid.map((m) => ({ id: `${m.providerID}/${m.id}`, name: m.name, desc: `$${m.costIn}/${m.costOut} per MTok`, free: false as const })),
      ];
    }
    if (virtualProvider === "codex" && codexModels.length > 0) return codexModels;
    return modelsForProvider(virtualProvider);
  }, [activeVirtualDir, virtualSessions, opencodeModels, codexModels, activeModels]);
  const selectedModel = modelByProvider[activeProvider] || (
    activeProvider === "opencode" && activeModels.length > 0
      ? activeModels[0].id // first free model
      : defaultModelForProvider(activeProvider)
  );

  const panelDirectory = activeSession?.directory ?? "~";

  const titleBarSessionTitle = useMemo(() => {
    if (!activeSession) return undefined;
    return activeSession.name || activeSession.directory?.split("/").filter(Boolean).pop() || undefined;
  }, [activeSession]);

  const totalCostToday = useMemo(
    () => [...sessionUsage.values()].reduce((sum, u) => sum + (u.costUsd ?? 0), 0),
    [sessionUsage]
  );
  const unreadCount = unreadSessions?.size ?? 0;

  // Lazy mounting: track which sessions have ever been viewed so we don't
  // mount all session panels on startup. Running/starting sessions are always
  // mounted so they never miss IPC events even before first view.
  const everMountedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (effectiveSessionId) everMountedRef.current.add(effectiveSessionId);
  }, [effectiveSessionId]);


  const suggestionsRef = useRef<HTMLDivElement>(null);
  const dirListRef = useRef<HTMLDivElement>(null);

  // Ref to notify PRPanel to reset to list view
  const prPanelResetRef = useRef<(() => void) | null>(null);

  // PR number to open directly in the PR panel (set when clicking "Open in PR Panel" from chat)
  // Uses {number, key} so re-clicking the same PR still triggers the effect
  const [openPrRequest, setOpenPrRequest] = useState<{ number: number; key: number } | undefined>(undefined);

  const togglePanel = (panel: "prs") => {
    if (activePanel === panel) {
      // Already on this panel — reset internal state (e.g. PR review → PR list)
      if (panel === "prs") prPanelResetRef.current?.();
      return;
    }
    navigateToPanel(panel);
  };

  // Branch info for all worktrees across all workspaces (shared hook, polls every 10s)
  const { branches: dialogBranches, byRepo: gitWorktreesByRepo } = useWorktreeBranches(workspaces);

  // Cmd+N to open new session dialog, Cmd+G/P to toggle panels
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't fire app shortcuts when a modal is already open
      const anyModalOpen = showDirDialog || showCommandPalette;

      if (e.key === "Escape") {
        if (activeVirtualDir) {
          e.preventDefault();
          setActiveVirtualDir(null);
          return;
        }
        return;
      }

      if (e.metaKey && e.key === "n") {
        e.preventDefault();
        if (anyModalOpen) return;
        // If virtual panel is already showing, open the picker to choose a different directory
        if (activeVirtualDir) {
          setDirInput(localStorage.getItem("claude-orchestrator-last-dir") || "~");
          setPreselectedDir(localStorage.getItem("claude-orchestrator-last-session-dir") || null);
          setRecentDirs(loadRecentDirs());
          setSearchFilter("");
          setAddDirMode(false);
          setShowDirDialog(true);
          return;
        }
        const activeSession = sessions.find(s => s.id === activeSessionId);
        if (activeSession) {
          const dir = normalizeDir(activeSession.directory);
          if (!virtualSessions.has(dir)) {
            setVirtualSessions(prev => {
              const next = new Map(prev);
              next.set(dir, {
                directory: dir,
                draftText: "",
                provider: activeSession.provider ?? "claude-code",
                model: selectedModel,
                permissionMode,
                reasoningEffort: "medium",
                images: [],
                pastedFiles: [],
              });
              return next;
            });
          }
          setActiveVirtualDir(dir);
          navigateToPanel(null);
          return;
        }
        // No active session — show dir picker
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
      if (e.metaKey && e.key === "j") {
        e.preventDefault();
        navigateToPanel(null);
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
  }, [activePanel, panelDirectory, showDirDialog, showCommandPalette, activeSessionId, sessions, virtualSessions, selectedModel, permissionMode, activeVirtualDir]);

  // Wrap deleteSession for consistent handling
  const handleDeleteSession = async (id: string) => {
    await deleteSession(id);
  };

  const handleCommitClick = useCallback(async () => {
    try {
      const commands = await invoke<{ name: string }[]>("list_slash_commands", {
        directory: panelDirectory,
      });
      if (commands.some((cmd) => cmd.name === "commit")) {
        window.dispatchEvent(new CustomEvent("orchestrator-commit"));
      } else {
        setShowCommitModal(true);
      }
    } catch {
      setShowCommitModal(true);
    }
  }, [panelDirectory]);

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
      navigateToPanel(null);
    } catch (err) {
      console.error("Failed to create worktree:", err);
    } finally {
      setCreatingWorktree(false);
    }
  };


  // Sidebar uses workspaces directly — each workspace is one directory
  const sidebarWorkspaces = workspaces;

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

  // Scroll selected item into view when navigating with Cmd+N/P
  useEffect(() => {
    if (!preselectedDir || !dirListRef.current) return;
    const el = dirListRef.current.querySelector(`[data-path="${CSS.escape(preselectedDir)}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [preselectedDir]);

  const handleDirConfirm = async () => {
    const dir = dirInput.trim();
    if (!dir || creating) return;
    setCreating(true);
    const rootDir = repoRootDir(dir);
    localStorage.setItem("claude-orchestrator-last-dir", rootDir);
    localStorage.setItem("claude-orchestrator-last-session-dir", dir);
    saveRecentDir(rootDir);
    setShowDirDialog(false);
    const normalized = normalizeDir(dir);
    setVirtualSessions(prev => {
      if (prev.has(normalized)) return prev;
      const next = new Map(prev);
      next.set(normalized, { directory: normalized, draftText: "", provider: "claude-code", model: selectedModel, permissionMode, reasoningEffort: "medium", images: [], pastedFiles: [] });
      return next;
    });
    setActiveVirtualDir(normalized);
    navigateToPanel(null);
    setCreating(false);
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

  const quickCreate = (dir: string) => {
    if (creating) return;
    // Save the repo root as last-dir so worktrees are always listed from the main repo
    const rootDir = repoRootDir(dir);
    localStorage.setItem("claude-orchestrator-last-dir", rootDir);
    localStorage.setItem("claude-orchestrator-last-session-dir", dir);
    saveRecentDir(rootDir);
    setShowDirDialog(false);
    const normalized = normalizeDir(dir);
    setVirtualSessions(prev => {
      if (prev.has(normalized)) return prev;
      const next = new Map(prev);
      next.set(normalized, { directory: normalized, draftText: "", provider: "claude-code", model: selectedModel, permissionMode, reasoningEffort: "medium", images: [], pastedFiles: [] });
      return next;
    });
    setActiveVirtualDir(normalized);
    navigateToPanel(null);
  };

  const handleSelectSession = (id: string) => {
    navigate({ to: "/session/$sessionId", params: { sessionId: id } });
    startTransition(() => {
      selectSession(id);
      setActiveVirtualDir(null);
      if (isMobile) setDrawerOpen(false);
    });
  };

  const handleVirtualSessionSend = useCallback(async (
    text: string,
    provider: import("./types").AgentProvider,
    model: string,
    pMode: "bypassPermissions" | "plan",
    images?: Array<{ id: string; data: string; mediaType: string; name: string }>,
    files?: Array<{ id: string; name: string; content: string; mimeType: string }>
  ) => {
    if (!activeVirtualDir) return;
    const dir = activeVirtualDir;
    // > command — create a terminal instead of an agent session
    if (text.startsWith(">")) {
      const command = text.slice(1).trim();
      setActiveVirtualDir(null);
      setVirtualSessions(prev => { const next = new Map(prev); next.delete(dir); return next; });
      createTerminalSession(dir).then((newId) => {
        if (command) {
          setTimeout(() => {
            invoke("write_to_pty", { sessionId: newId, data: command + "\r" }).catch(console.error);
          }, 400);
        }
      }).catch(console.error);
      return;
    }
    await createSession(undefined, dir, skipPermissions, undefined, text, provider, model, pMode, undefined, undefined, images, files);
    setActiveVirtualDir(null);
    setVirtualSessions(prev => { const next = new Map(prev); next.delete(dir); return next; });
    navigateToPanel(null);
  }, [activeVirtualDir, createSession, createTerminalSession, skipPermissions]);

  return (
    <PullToRefresh>
    <div className="flex flex-col h-screen w-screen bg-[var(--bg-primary)]">
      {showDisconnected && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl p-8 max-w-sm mx-4 text-center">
            <Spinner className="w-10 h-10" color="var(--text-primary)" />
            <div className="text-sm font-medium text-[var(--text-primary)]">Cannot connect to server</div>
            <div className="text-xs text-[var(--text-secondary)] leading-relaxed">
              {!isTauri && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1"
                ? "Make sure External Access is enabled in Settings on the host machine."
                : "Make sure the orchestrator server is running."}
            </div>
            <button
              className="text-xs px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      )}
      {update && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss(); }}>
          <div
            className="flex flex-col bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl w-[calc(100vw-2rem)] max-w-[360px]"
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
      <TitleBar sessionTitle={titleBarSessionTitle}>
        {/* New Session */}
        <button className="tb-pill" onClick={handleNewSession} data-no-drag title="New Session (⌘N)">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
            <path d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>

        {/* Open in Editor — split button with editor picker */}
        <div className="tb-split" data-no-drag style={{ position: "relative" }}>
          <button
            className="tb-split-main"
            onClick={() => {
              const editor = localStorage.getItem("claude-orchestrator-editor-command") || "code";
              if (panelDirectory) invoke("open_in_editor", { editor, filePath: panelDirectory });
            }}
            title="Open in editor (⌘E)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
            </svg>
          </button>
          <div className="tb-split-sep" />
          <button
            className="tb-split-chev"
            onClick={() => setShowEditorDropdown((v) => !v)}
            title="Choose editor"
          >
            <svg width="9" height="9" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 1l4 4 4-4" />
            </svg>
          </button>
          {showEditorDropdown && (
            <div className="tb-dropdown" onMouseLeave={() => setShowEditorDropdown(false)}>
              {[
                { label: "VS Code", cmd: "code" },
                { label: "Cursor", cmd: "app:Cursor" },
                { label: "Windsurf", cmd: "app:Windsurf" },
                { label: "Zed", cmd: "app:Zed" },
              ].map(({ label, cmd }) => (
                <button
                  key={cmd}
                  className="tb-dropdown-item"
                  onClick={() => {
                    localStorage.setItem("claude-orchestrator-editor-command", cmd);
                    if (panelDirectory) invoke("open_in_editor", { editor: cmd, filePath: panelDirectory });
                    setShowEditorDropdown(false);
                  }}
                >
                  {label}
                  {(localStorage.getItem("claude-orchestrator-editor-command") || "code") === cmd && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" style={{ marginLeft: "auto", color: "var(--accent)" }}>
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Commit, push & PR — split button */}
        <div className="tb-split" data-no-drag>
          <button
            className="tb-split-main"
            onClick={handleCommitClick}
            title="Commit & Push"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.303 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.797 24 17.3 24 12c0-6.63-5.37-12-12-12z"/>
            </svg>
          </button>
          <div className="tb-split-sep" />
          <button
            className="tb-split-chev"
            onClick={handleCommitClick}
            title="Commit options"
          >
            <svg width="9" height="9" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 1l4 4 4-4" />
            </svg>
          </button>
        </div>

        {/* Usage / Cost */}
        <button className="tb-pill" onClick={() => setShowUsagePanel(true)} data-no-drag title="Usage stats">
          {totalCostToday >= 0.01
            ? `$${totalCostToday.toFixed(2)}`
            : totalCostToday > 0
            ? "<$0.01"
            : "$0.00"}
        </button>

        {/* Settings */}
        <button className="tb-pill" onClick={() => setShowSettings(true)} data-no-drag title="Settings">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        {/* Context Rail toggle */}
        {activeSessionId && (
          <button
            className="tb-pill"
            onClick={() => setRailOpen((v) => !v)}
            data-no-drag
            title={railOpen ? "Hide context rail (⌘\\)" : "Show context rail (⌘\\)"}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              {railOpen
                ? <path d="M9 18l6-6-6-6" />
                : <path d="M15 18l-6-6 6-6" />
              }
            </svg>
          </button>
        )}
      </TitleBar>
      <CommitModal
        directory={panelDirectory}
        onClose={() => setShowCommitModal(false)}
        visible={showCommitModal}
      />
      {fileDiffModal && (
        <FileDiffModal
          path={fileDiffModal.path}
          diff={fileDiffModal.diff}
          onClose={() => setFileDiffModal(null)}
        />
      )}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}>
          <div
            className="flex flex-col bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl w-[calc(100vw-2rem)] max-w-[380px]"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-[var(--border-color)]">
              <div className="text-sm font-semibold text-[var(--text-primary)]">Settings</div>
            </div>
            <div className="px-5 py-4 flex flex-col gap-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <div className="text-sm text-[var(--text-primary)]">Allow external connections</div>
                  <div className="text-xs text-[var(--text-secondary)]">
                    Allow other devices on your local network to connect to this server.
                  </div>
                </div>
                <button
                  onClick={() => handleToggleExternalAccess(!externalAccess)}
                  className={`relative shrink-0 w-10 h-6 rounded-full transition-colors duration-200 focus:outline-none ${externalAccess ? "bg-[var(--accent)]" : "bg-[var(--bg-tertiary)]"}`}
                  role="switch"
                  aria-checked={externalAccess ?? false}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${externalAccess ? "translate-x-4" : "translate-x-0"}`}
                  />
                </button>
              </div>
            </div>
            <div className="flex justify-end px-5 py-3 border-t border-[var(--border-color)]">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-1.5 text-sm font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="flex flex-1 min-h-0 relative">
        {/* Activity bar — desktop only (mobile uses bottom nav below) */}
        {!isMobile && (
          <ActivityBar
            activeView={activeSessionId === null ? "overview" : "session"}
            drawerOpen={drawerOpen}
            activePanel={activePanel}
            unreadCount={unreadCount}
            onOverview={() => {
              navigate({ to: "/" });
              startTransition(() => selectSession(null as unknown as string));
            }}
            onToggleSidebar={() => setDrawerOpen((v) => !v)}
            onSessionsClick={() => {
              if (activeSessionId === null) {
                const last = sessions.slice().sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0];
                if (last) {
                  navigate({ to: "/session/$sessionId", params: { sessionId: last.id } });
                  startTransition(() => selectSession(last.id));
                }
              } else {
                navigate({ to: "/session/$sessionId", params: { sessionId: activeSessionId } });
              }
            }}
            onTogglePRs={() => togglePanel("prs")}
          />
        )}

        {/* Mobile drawer backdrop */}
        {isMobile && drawerOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setDrawerOpen(false)}
          />
        )}

        {/* Session drawer */}
        <div
          className="overflow-hidden shrink-0 transition-all duration-200 h-full"
          style={isMobile ? {
            position: "fixed",
            left: 0,
            top: 0,
            bottom: 0,
            zIndex: 50,
            width: "min(320px, 85vw)",
            transform: drawerOpen ? "translateX(0)" : "translateX(-100%)",
            transition: "transform 200ms ease",
            background: "var(--drawer-bg)",
            borderRight: "1px solid var(--border-subtle)",
          } : {
            width: drawerOpen ? 320 : 0,
            background: "var(--drawer-bg)",
            borderRight: drawerOpen ? "1px solid var(--border-subtle)" : "none",
          }}
        >
          <div style={{ width: "min(320px, 85vw)", height: "100%" }}>
            <Sidebar
              workspaces={sidebarWorkspaces}
              activeSessionId={activeSessionId}
              onSelectSession={handleSelectSession}
              onCreateSession={handleNewSession}
              onRenameSession={renameSession}
              onDeleteSession={handleDeleteSession}
              onArchiveSession={archiveSession}
              onUnarchiveSession={unarchiveSession}
              youngestDescendantMap={youngestDescendantMap}
              terminalBusyIds={terminalBusyIds}
              terminalCommands={terminalCommands}
            />
          </div>
        </div>

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
              {/* Session panels — lazily mounted on first view, or proactively for running sessions */}
              {sessions
                .filter((s) =>
                  everMountedRef.current.has(s.id) ||
                  s.id === effectiveSessionId ||
                  s.status === "running" ||
                  s.status === "starting"
                )
                .map((session) => (
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
                  createTerminalSession={createTerminalSession}
                  currentModel={session.model ?? selectedModel}
                  onModelChange={handleModelChange}
                  activeModels={activeModels}
                  setChatInputHeight={setChatInputHeight}
                  onAvailableModels={session.provider === "opencode" ? handleAvailableModels : undefined}
                  onNavigateToSession={handleSelectSession}
                  updatePermissionMode={updatePermissionMode}
                  parentSession={parentSessionMap.get(session.id)}
                  childSessions={childSessionsMap.get(session.id)}
                  onOpenFile={handleOpenFile}
                  providerAvailability={providerAvailability}
                  onProviderChange={(provider) => handleProviderChange(session.id, provider)}
                  onStartPendingSession={(provider, model) => handleStartPendingSession(session.id, provider, model)}
                  onOpenPRPanel={(prNumber) => { setOpenPrRequest({ number: prNumber, key: Date.now() }); navigateToPanel("prs"); }}
                  onChangedFiles={getChangedFilesCallback(session.id)}
                />
              ))}

              {/* Virtual session compose panel */}
              {activeVirtualDir && virtualSessions.has(activeVirtualDir) && (
                <div className="absolute inset-0 z-10 bg-[var(--bg-primary)]">
                  <NewSessionPanel
                    virtualSession={virtualSessions.get(activeVirtualDir)!}
                    isActive={activePanel === null}
                    activeModels={virtualActiveModels}
                    providerAvailability={providerAvailability}
                    onSend={handleVirtualSessionSend}
                    onDraftChange={(dir, text) => setVirtualSessions(prev => {
                      const e = prev.get(dir); if (!e) return prev;
                      const next = new Map(prev); next.set(dir, { ...e, draftText: text }); return next;
                    })}
                    onProviderChange={(dir, provider) => {
                      let models: ModelOption[];
                      if (provider === "opencode" && opencodeModels.length > 0) {
                        const free = opencodeModels.filter(m => m.free);
                        const paid = opencodeModels.filter(m => !m.free);
                        models = [
                          ...free.map(m => ({ id: `${m.providerID}/${m.id}`, name: m.name, desc: "Free", free: true as const })),
                          ...paid.map(m => ({ id: `${m.providerID}/${m.id}`, name: m.name, desc: `$${m.costIn}/${m.costOut} per MTok`, free: false as const })),
                        ];
                      } else if (provider === "codex" && codexModels.length > 0) {
                        models = codexModels;
                      } else {
                        models = modelsForProvider(provider);
                      }
                      const newModel = models[0]?.id ?? "";
                      setVirtualSessions(prev => {
                        const e = prev.get(dir); if (!e) return prev;
                        const next = new Map(prev);
                        next.set(dir, { ...e, provider, model: newModel });
                        return next;
                      });
                    }}
                    onModelChange={(dir, model) => setVirtualSessions(prev => {
                      const e = prev.get(dir); if (!e) return prev;
                      const next = new Map(prev); next.set(dir, { ...e, model }); return next;
                    })}
                    onPermissionModeChange={(dir, mode) => setVirtualSessions(prev => {
                      const e = prev.get(dir); if (!e) return prev;
                      const next = new Map(prev); next.set(dir, { ...e, permissionMode: mode }); return next;
                    })}
                    onReasoningEffortChange={(dir, effort) => setVirtualSessions(prev => {
                      const e = prev.get(dir); if (!e) return prev;
                      const next = new Map(prev); next.set(dir, { ...e, reasoningEffort: effort }); return next;
                    })}
                    onAttachmentsChange={(dir, images, pastedFiles) => setVirtualSessions(prev => {
                      const e = prev.get(dir); if (!e) return prev;
                      const next = new Map(prev); next.set(dir, { ...e, images, pastedFiles }); return next;
                    })}
                    onCursorChange={(dir, start, end) => setVirtualSessions(prev => {
                      const e = prev.get(dir); if (!e) return prev;
                      const next = new Map(prev); next.set(dir, { ...e, selectionStart: start, selectionEnd: end }); return next;
                    })}
                    onDismiss={() => setActiveVirtualDir(null)}
                    onCreateTerminal={(dir, command) => {
                      createTerminalSession(dir).then((newId) => {
                        if (command) {
                          setTimeout(() => {
                            invoke("write_to_pty", { sessionId: newId, data: command + "\r" }).catch(console.error);
                          }, 400);
                        }
                      }).catch(console.error);
                    }}
                  />
                </div>
              )}

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
                  onSwitchToClaude={() => navigateToPanel(null)}
                  initialPrNumber={openPrRequest?.number}
                  initialPrKey={openPrRequest?.key}
                  onAskClaude={(prompt) => {
                    if (!activeSessionId) return;
                    const jsonLine = JSON.stringify({
                      type: "user",
                      message: { role: "user", content: prompt },
                    });
                    invoke("send_agent_message", { sessionId: activeSessionId, message: jsonLine }).catch(() => {});
                    navigateToPanel(null);
                  }}
                />
              </div>

              </div>
            </div>

          </div>
        </div>

        {/* Context rail — desktop only */}
        <div
          ref={railContainerRef}
          className="overflow-hidden shrink-0 relative"
          style={{ width: railOpen && activeSessionId && !isMobile ? railWidth : 0 }}
        >
          {/* Drag handle */}
          {railOpen && activeSessionId && (
            <div
              className="absolute left-0 top-0 bottom-0 w-1 z-10 cursor-col-resize hover:bg-[var(--accent)]/40 active:bg-[var(--accent)]/60 transition-colors"
              onMouseDown={(e) => {
                e.preventDefault();
                isResizingRail.current = true;
                railWidthDuringDrag.current = railWidth;
                const startX = e.clientX;
                const startWidth = railWidth;
                if (railContainerRef.current) railContainerRef.current.style.transition = "none";
                if (railInnerRef.current) railInnerRef.current.style.transition = "none";
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
                const onMove = (ev: MouseEvent) => {
                  const delta = startX - ev.clientX;
                  const newWidth = Math.max(200, Math.min(700, startWidth + delta));
                  railWidthDuringDrag.current = newWidth;
                  if (rafId.current !== null) return;
                  rafId.current = requestAnimationFrame(() => {
                    rafId.current = null;
                    const w = railWidthDuringDrag.current;
                    if (railContainerRef.current) railContainerRef.current.style.width = `${w}px`;
                    if (railInnerRef.current) railInnerRef.current.style.width = `${w}px`;
                  });
                };
                const onUp = () => {
                  isResizingRail.current = false;
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                  document.body.style.cursor = "";
                  document.body.style.userSelect = "";
                  if (rafId.current !== null) {
                    cancelAnimationFrame(rafId.current);
                    rafId.current = null;
                  }
                  setRailWidth(railWidthDuringDrag.current);
                  if (railContainerRef.current) railContainerRef.current.style.transition = "";
                  if (railInnerRef.current) railInnerRef.current.style.transition = "";
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
            />
          )}
          <div
            ref={railInnerRef}
            className="h-full"
            style={{
              width: railWidth,
              transform: railOpen && activeSessionId ? "translateX(0)" : `translateX(${railWidth}px)`,
              transition: "transform 150ms ease",
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
                turnChangedFiles={activeSessionId ? sessionChangedFiles.get(activeSessionId) : undefined}
                onOpenFile={handleOpenFile}
              />
            )}
          </div>
        </div>
      </div>

      {/* Mobile bottom navigation bar */}
      {isMobile && (
        <ActivityBar
          isMobile
          activeView={activeSessionId === null ? "overview" : "session"}
          drawerOpen={drawerOpen}
          activePanel={activePanel}
          unreadCount={unreadCount}
          onOverview={() => {
            navigate({ to: "/" });
            startTransition(() => selectSession(null as unknown as string));
            setDrawerOpen(false);
          }}
          onToggleSidebar={() => setDrawerOpen((v) => !v)}
          onSessionsClick={() => {
            setDrawerOpen(false);
            if (activeSessionId === null) {
              const last = sessions.slice().sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0];
              if (last) {
                navigate({ to: "/session/$sessionId", params: { sessionId: last.id } });
                startTransition(() => selectSession(last.id));
              }
            } else {
              navigate({ to: "/session/$sessionId", params: { sessionId: activeSessionId } });
            }
          }}
          onTogglePRs={() => { togglePanel("prs"); setDrawerOpen(false); }}
        />
      )}

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
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl w-[calc(100vw-2rem)] max-w-[420px] shadow-[0_16px_48px_rgba(0,0,0,0.5)] ring-1 ring-white/[0.04] flex flex-col overflow-hidden animate-scale-in" onMouseDown={(e) => e.stopPropagation()}>
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

      {/* Command palette — conditionally mounted so no DOM cost when closed */}
      {showCommandPalette && (
        <CommandPalette
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
        />
      )}

      {/* Worktree creation dialog */}
      {showWorktreeDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dialog-backdrop animate-backdrop" onMouseDown={() => setShowWorktreeDialog(false)}>
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl w-[calc(100vw-2rem)] max-w-[380px] shadow-[0_16px_48px_rgba(0,0,0,0.5)] ring-1 ring-white/[0.04] flex flex-col overflow-hidden animate-scale-in" onMouseDown={(e) => e.stopPropagation()}>
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
    </PullToRefresh>
  );
}
