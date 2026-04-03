import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "../../../lib/bridge";

// ── Shared branch cache (per directory, survives across component instances) ──
const branchCache = new Map<string, string>();
const branchListeners = new Set<() => void>();
let branchSnapshot = 0; // bump to notify subscribers

function subscribeBranch(cb: () => void) {
  branchListeners.add(cb);
  return () => branchListeners.delete(cb);
}

function setCachedBranch(dir: string, branch: string) {
  if (branchCache.get(dir) === branch) return;
  branchCache.set(dir, branch);
  branchSnapshot++;
  branchListeners.forEach((cb) => cb());
}

function fetchBranchForDir(dir: string) {
  invoke<{ branch: string; files: unknown[]; isGitRepo: boolean }>("get_git_status", { directory: dir })
    .then((r) => { if (r.isGitRepo) setCachedBranch(dir, r.branch); })
    .catch(() => {});
}

function useCachedBranch(dir: string | undefined): string {
  // Subscribe to cache changes
  const branch = useSyncExternalStore(
    subscribeBranch,
    () => (dir ? branchCache.get(dir) || "" : ""),
  );
  // Fetch on first access and poll every 10s to stay in sync
  useEffect(() => {
    if (!dir) return;
    fetchBranchForDir(dir);
    const interval = setInterval(() => fetchBranchForDir(dir), 10_000);
    return () => clearInterval(interval);
  }, [dir]);
  return branch;
}

// ── Shared sync status cache ──
interface SyncStatus { ahead: number; behind: number; hasRemote: boolean }
const syncCache = new Map<string, SyncStatus>();
const syncListeners = new Set<() => void>();
let syncSnapshot = 0;

function subscribeSync(cb: () => void) {
  syncListeners.add(cb);
  return () => syncListeners.delete(cb);
}
function setCachedSync(dir: string, s: SyncStatus) {
  const prev = syncCache.get(dir);
  if (prev && prev.ahead === s.ahead && prev.behind === s.behind && prev.hasRemote === s.hasRemote) return;
  syncCache.set(dir, s);
  syncSnapshot++;
  syncListeners.forEach((cb) => cb());
}
function fetchSyncForDir(dir: string) {
  invoke<SyncStatus>("git_sync_status", { directory: dir })
    .then((s) => setCachedSync(dir, s))
    .catch(() => {});
}
function useSyncStatus(dir: string | undefined): SyncStatus | null {
  const status = useSyncExternalStore(
    subscribeSync,
    () => (dir ? syncCache.get(dir) ?? null : null),
  );
  useEffect(() => {
    if (!dir) return;
    fetchSyncForDir(dir);
    const interval = setInterval(() => fetchSyncForDir(dir), 30_000);
    return () => clearInterval(interval);
  }, [dir]);
  return status;
}
import { AttachmentStrip } from "./AttachmentStrip";
import { SlashMenu } from "./SlashMenu";
import { FileMenu } from "./FileMenu";
import { PillBar } from "./PillBar";
import { InlineQuestionComposer } from "./InlineQuestionComposer";
import { InlinePermissionComposer } from "./InlinePermissionComposer";
import type { AgentProvider, ModelOption } from "../../../types";
import type { AskQuestion, FileReference } from "../types";
import type { ImageAttachment, PastedFile } from "../hooks/useAttachments";

interface ChatInputProps {
  inputText: string;
  setInputText: (text: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  inputAreaRef: React.RefObject<HTMLDivElement | null>;

  images: ImageAttachment[];
  pastedFiles: PastedFile[];
  fileReferences: FileReference[];
  onRemoveImage: (id: string) => void;
  onRemovePastedFile: (id: string) => void;
  onRemoveFileRef: (path: string) => void;
  onViewFileRef: (ref: FileReference) => void;
  onPaste: (e: React.ClipboardEvent) => void;

  isGenerating: boolean;
  onSend: () => void;
  onAbort: () => void;

  pendingQuestion: { blockId: string; questions: AskQuestion[] } | null;
  pendingPermission: { toolName: string; input: Record<string, unknown> } | null;
  onAnswerQuestion: (answer: Record<string, string>) => void;
  onAllowPermission: () => void;
  onDenyPermission: () => void;
  onAllowInNew: () => void;
  onPlanFeedback: (text: string) => void;

  editingMessageId: string | null;
  onCancelEdit: () => void;

  sessionDir?: string;
  sessionStatus?: string;
  sessionProvider?: AgentProvider;
  sessionPermissionMode?: string;
  currentModel: string;
  activeModels: ModelOption[];
  openPill: "provider" | "model" | "mode" | "effort" | null;
  setOpenPill: (pill: "provider" | "model" | "mode" | "effort" | null) => void;
  modelSearchTerm: string;
  setModelSearchTerm: (term: string) => void;
  filteredModels: ModelOption[];
  reasoningEffort: "low" | "medium" | "high";
  setReasoningEffort: (effort: "low" | "medium" | "high") => void;
  onModelChange?: (modelId: string) => void;
  onPermissionModeChange?: (mode: "bypassPermissions" | "plan") => void;
  onProviderChange?: (provider: AgentProvider) => void;
  providerAvailability?: Record<string, boolean>;
  targetSessionId: string;
  pillRowRef: React.RefObject<HTMLDivElement | null>;
  modelSearchRef: React.RefObject<HTMLInputElement | null>;

  // Autocomplete
  showFileMenu: boolean;
  fileSuggestions: string[];
  fileMenuIndex: number;
  setFileMenuIndex: (i: number) => void;
  fileMenuRef: React.RefObject<HTMLDivElement | null>;
  onSelectFile: (path: string) => void;

  showSlashMenu: boolean;
  filteredSlashCommands: Array<{ name: string; description: string; source: string }>;
  slashMenuIndex: number;
  setSlashMenuIndex: (i: number) => void;
  slashMenuRef: React.RefObject<HTMLDivElement | null>;
  onSelectSlashCommand: (cmd: { name: string }) => void;

  onShowFilePicker: () => void;

  handleKeyDown: (e: React.KeyboardEvent) => void;
  onInputHeightChange?: (height: number) => void;
  footerHint?: React.ReactNode;
  onCreateTerminal?: () => void;
}

export function ChatInput({
  inputText, setInputText, inputRef, inputAreaRef,
  images, pastedFiles, fileReferences,
  onRemoveImage, onRemovePastedFile, onRemoveFileRef, onViewFileRef, onPaste,
  isGenerating, onSend, onAbort,
  pendingQuestion, pendingPermission,
  onAnswerQuestion, onAllowPermission, onDenyPermission, onAllowInNew, onPlanFeedback,
  editingMessageId, onCancelEdit,
  sessionDir, sessionStatus, sessionProvider, sessionPermissionMode,
  currentModel, activeModels,
  openPill, setOpenPill, modelSearchTerm, setModelSearchTerm, filteredModels,
  reasoningEffort, setReasoningEffort,
  onModelChange, onPermissionModeChange, onProviderChange, providerAvailability,
  targetSessionId, pillRowRef, modelSearchRef,
  showFileMenu, fileSuggestions, fileMenuIndex, setFileMenuIndex, fileMenuRef, onSelectFile,
  showSlashMenu, filteredSlashCommands, slashMenuIndex, setSlashMenuIndex, slashMenuRef, onSelectSlashCommand,
  onShowFilePicker,
  handleKeyDown, onInputHeightChange, onCreateTerminal, footerHint,
}: ChatInputProps) {

  const canSend = !!(inputText.trim() || images.length > 0 || fileReferences.length > 0 || pastedFiles.length > 0);
  const isShellPrefix = inputText.startsWith(">");

  const activeBranch = useCachedBranch(sessionDir);
  const syncStatus = useSyncStatus(sessionDir);
  const [isPulling, setIsPulling] = useState(false);
  const [isPushingSync, setIsPushingSync] = useState(false);

  const handlePull = async () => {
    if (!sessionDir || isPulling) return;
    setIsPulling(true);
    try {
      await invoke("git_pull", { directory: sessionDir });
      fetchBranchForDir(sessionDir);
      fetchSyncForDir(sessionDir);
    } catch (e) {
      console.error("git pull failed:", e);
    } finally {
      setIsPulling(false);
    }
  };

  const handlePush = async () => {
    if (!sessionDir || isPushingSync) return;
    setIsPushingSync(true);
    try {
      await invoke("git_push_only", { directory: sessionDir });
      fetchSyncForDir(sessionDir);
    } catch (e) {
      console.error("git push failed:", e);
    } finally {
      setIsPushingSync(false);
    }
  };

  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchSearch, setBranchSearch] = useState("");
  const branchDropdownRef = useRef<HTMLDivElement | null>(null);
  const branchSearchRef = useRef<HTMLInputElement | null>(null);

  const openBranchDropdown = async () => {
    if (!sessionDir) return;
    setBranchSearch("");
    try {
      const list = await invoke<string[]>("list_branches", { directory: sessionDir });
      setBranches(list);
    } catch {
      setBranches([]);
    }
    setBranchDropdownOpen(true);
    setTimeout(() => branchSearchRef.current?.focus(), 50);
  };

  const closeBranchDropdown = () => {
    setBranchDropdownOpen(false);
    setBranchSearch("");
  };

  const switchBranch = async (branch: string) => {
    if (!sessionDir) return;
    closeBranchDropdown();
    try {
      await invoke("switch_branch", { directory: sessionDir, branch });
      setCachedBranch(sessionDir, branch);
    } catch (e) {
      console.error("Failed to switch branch:", e);
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    if (!branchDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        closeBranchDropdown();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [branchDropdownOpen]);

  // Auto-resize textarea when inputText changes (handles paste, edit, programmatic changes)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [inputText]);

  // Report height changes
  useEffect(() => {
    const el = inputAreaRef.current;
    if (!el || !onInputHeightChange) return;
    const ro = new ResizeObserver(() => onInputHeightChange(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onInputHeightChange]);

  return (
    <div className="chat-input-area px-6 pb-5 pt-2 relative flex justify-center" ref={inputAreaRef}>
      <div className="w-full max-w-[720px] flex flex-col gap-2">
        {/* Editing indicator */}
        {editingMessageId && (
          <div className="flex items-center gap-2 mb-2 px-1 py-1.5 text-xs text-[var(--accent)] bg-[var(--accent)]/10">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
            <span className="flex-1">Editing message — send to replace</span>
            <button onClick={onCancelEdit} className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">Cancel</button>
          </div>
        )}

        {/* Question banner — shown above input, not replacing it */}
        {pendingQuestion && !editingMessageId && (
          <div className="border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3">
            <div className="text-[10px] font-semibold text-[var(--accent)] uppercase tracking-wide mb-1.5">Agent is asking</div>
            <InlineQuestionComposer questions={pendingQuestion.questions} onAnswer={onAnswerQuestion} />
          </div>
        )}

        {/* Plan banner — shown above input like question banner */}
        {pendingPermission?.toolName === "ExitPlanMode" && !editingMessageId && (
          <div className="border border-[var(--warning-border,var(--border-color))] bg-[var(--bg-secondary)] p-3">
            <InlinePermissionComposer
              permission={pendingPermission}
              onAllow={onAllowPermission}
              onDeny={onDenyPermission}
              onAllowInNew={onAllowInNew}
              onFeedback={onPlanFeedback}
            />
          </div>
        )}

        {/* Non-plan permission replaces input; plan mode keeps input visible */}
        {pendingPermission && pendingPermission.toolName !== "ExitPlanMode" && !editingMessageId ? (
          <div className="border border-[var(--warning-border,var(--border-color))] bg-[var(--bg-secondary)] p-3">
            <InlinePermissionComposer
              permission={pendingPermission}
              onAllow={onAllowPermission}
              onDeny={onDenyPermission}
              onAllowInNew={onAllowInNew}
              onFeedback={onPlanFeedback}
            />
          </div>
        ) : (
          <>
            {/* Attachments */}
            <AttachmentStrip
              fileReferences={fileReferences}
              images={images}
              pastedFiles={pastedFiles}
              onRemoveFileRef={onRemoveFileRef}
              onRemoveImage={onRemoveImage}
              onRemovePastedFile={onRemovePastedFile}
              onViewFileRef={onViewFileRef}
            />

            {/* Hero input card */}
            <div className={`chat-input-card relative border bg-[var(--bg-secondary)] shadow-[0_2px_16px_rgba(0,0,0,0.25)] ${isShellPrefix ? "border-[var(--green,#3fb950)]/50 shadow-[0_0_0_3px_rgba(63,185,80,0.08)]" : "border-[var(--border-color)] focus-within:border-[var(--accent)]/50 focus-within:shadow-[0_0_0_3px_rgba(124,91,240,0.08)]"}`}>
              {showFileMenu && fileSuggestions.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 pb-2">
                  <FileMenu
                    suggestions={fileSuggestions}
                    activeIndex={fileMenuIndex}
                    menuRef={fileMenuRef}
                    onHover={setFileMenuIndex}
                    onSelect={onSelectFile}
                  />
                </div>
              )}
              {showSlashMenu && filteredSlashCommands.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 pb-2">
                  <SlashMenu
                    commands={filteredSlashCommands}
                    activeIndex={slashMenuIndex}
                    menuRef={slashMenuRef}
                    onHover={setSlashMenuIndex}
                    onSelect={onSelectSlashCommand}
                  />
                </div>
              )}
              {/* Shell mode indicator */}
              {isShellPrefix && (
                <div className="flex items-center gap-1.5 px-3 pt-2 pb-0 text-[10px] font-medium text-[#3fb950] uppercase tracking-wide">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  Shell
                </div>
              )}
              {/* Textarea row */}
              <div className="flex items-end">
                {sessionDir && (
                  <button
                    onClick={onShowFilePicker}
                    className="p-3 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] shrink-0 self-center"
                    title="Attach file (⌘O)"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>
                  </button>
                )}
                <textarea
                  ref={inputRef}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={onPaste}
                  placeholder={pendingQuestion ? "Reply to answer…" : pendingPermission?.toolName === "ExitPlanMode" ? "Suggest changes to the plan…" : "Type a message, @, / or >"}
                  rows={1}
                  className="flex-1 resize-none bg-transparent border-none px-3 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none max-h-40 overflow-y-auto"
                  style={{ minHeight: "44px" }}
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = "auto";
                    target.style.height = `${Math.min(target.scrollHeight, 160)}px`;
                  }}
                />
              </div>
              {/* Bottom bar */}
              <PillBar
                sessionStatus={sessionStatus}
                sessionProvider={sessionProvider}
                sessionPermissionMode={sessionPermissionMode}
                currentModel={currentModel}
                activeModels={activeModels}
                openPill={openPill}
                setOpenPill={setOpenPill}
                modelSearchTerm={modelSearchTerm}
                setModelSearchTerm={setModelSearchTerm}
                filteredModels={filteredModels}
                reasoningEffort={reasoningEffort}
                setReasoningEffort={setReasoningEffort}
                onModelChange={onModelChange}
                onPermissionModeChange={onPermissionModeChange}
                onProviderChange={onProviderChange}
                providerAvailability={providerAvailability}
                targetSessionId={targetSessionId}
                pillRowRef={pillRowRef}
                modelSearchRef={modelSearchRef}
                isGenerating={isGenerating}
                onAbort={onAbort}
                canSend={canSend}
                onSend={onSend}
                onCreateTerminal={onCreateTerminal}
              />
            </div>

            {/* Footer row: branch selector + sync buttons + optional hint */}
            {(activeBranch || footerHint) && (
              <div className="flex items-center justify-between">
                {activeBranch ? (
                  <div className="flex items-center gap-1">
                  <div className="relative" ref={branchDropdownRef}>
                    <button
                      onClick={openBranchDropdown}
                      className="flex items-center gap-1 px-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
                      </svg>
                      {activeBranch}
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-50">
                        <path d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                      </svg>
                    </button>
                    {branchDropdownOpen && (
                      <div className="absolute bottom-full mb-1 left-0 bg-[var(--bg-secondary)] border border-[var(--border-color)] shadow-[4px_4px_0px_rgba(255,255,255,0.06)] z-50 min-w-[220px] max-h-[280px] flex flex-col">
                        <input
                          ref={branchSearchRef}
                          value={branchSearch}
                          onChange={(e) => setBranchSearch(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") closeBranchDropdown();
                            if (e.key === "Enter") {
                              const filtered = branches.filter((b) => b.toLowerCase().includes(branchSearch.toLowerCase()));
                              if (filtered.length === 1) switchBranch(filtered[0]);
                            }
                          }}
                          placeholder="Search branches…"
                          className="w-full px-3 py-2 text-[11px] bg-transparent border-b border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
                        />
                        <div className="overflow-y-auto flex-1">
                          {branches
                            .filter((b) => b.toLowerCase().includes(branchSearch.toLowerCase()))
                            .map((branch) => (
                              <button
                                key={branch}
                                onMouseDown={(e) => { e.preventDefault(); switchBranch(branch); }}
                                className={`w-full text-left px-3 py-1.5 text-[11px] flex items-center gap-1.5 ${branch === activeBranch ? "text-[var(--accent)]" : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"}`}
                              >
                                {branch === activeBranch && (
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                )}
                                <span className={`truncate ${branch === activeBranch ? "" : "ml-[14px]"}`}>{branch}</span>
                              </button>
                            ))}
                          {branches.filter((b) => b.toLowerCase().includes(branchSearch.toLowerCase())).length === 0 && (
                            <div className="px-3 py-2 text-[10px] text-[var(--text-tertiary)] italic">No branches found</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Pull/push buttons with ahead/behind counts */}
                  {syncStatus?.hasRemote && (
                    <div className="flex items-center gap-0.5">
                      {syncStatus.behind > 0 && (
                        <button
                          onClick={handlePull}
                          disabled={isPulling}
                          title={`Pull ${syncStatus.behind} incoming commit${syncStatus.behind !== 1 ? "s" : ""}`}
                          className="flex items-center gap-0.5 px-1 py-0.5 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] disabled:opacity-50"
                        >
                          {isPulling ? (
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                          ) : (
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
                          )}
                          <span>{syncStatus.behind}</span>
                        </button>
                      )}
                      {syncStatus.ahead > 0 && (
                        <button
                          onClick={handlePush}
                          disabled={isPushingSync}
                          title={`Push ${syncStatus.ahead} outgoing commit${syncStatus.ahead !== 1 ? "s" : ""}`}
                          className="flex items-center gap-0.5 px-1 py-0.5 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] disabled:opacity-50"
                        >
                          {isPushingSync ? (
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                          ) : (
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                          )}
                          <span>{syncStatus.ahead}</span>
                        </button>
                      )}
                      {syncStatus.behind === 0 && syncStatus.ahead === 0 && (
                        <span className="px-1 text-[10px] text-[var(--text-tertiary)] opacity-40">synced</span>
                      )}
                    </div>
                  )}
                  </div>
                ) : <div />}
                {footerHint}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
