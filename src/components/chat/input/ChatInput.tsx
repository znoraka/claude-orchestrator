import { useEffect } from "react";
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
  currentBranch?: string;
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
  currentModel, activeModels, currentBranch,
  openPill, setOpenPill, modelSearchTerm, setModelSearchTerm, filteredModels,
  reasoningEffort, setReasoningEffort,
  onModelChange, onPermissionModeChange, onProviderChange, providerAvailability,
  targetSessionId, pillRowRef, modelSearchRef,
  showFileMenu, fileSuggestions, fileMenuIndex, setFileMenuIndex, fileMenuRef, onSelectFile,
  showSlashMenu, filteredSlashCommands, slashMenuIndex, setSlashMenuIndex, slashMenuRef, onSelectSlashCommand,
  onShowFilePicker,
  handleKeyDown, onInputHeightChange,
}: ChatInputProps) {

  const canSend = !!(inputText.trim() || images.length > 0 || fileReferences.length > 0 || pastedFiles.length > 0);

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
          <div className="flex items-center gap-2 mb-2 px-1 py-1.5 text-xs text-[var(--accent)] bg-[var(--accent)]/10 rounded-lg">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
            <span className="flex-1">Editing message — send to replace</span>
            <button onClick={onCancelEdit} className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors">Cancel</button>
          </div>
        )}

        {/* Question / Permission / Normal input */}
        {pendingQuestion && !editingMessageId ? (
          <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3">
            <div className="text-[10px] font-semibold text-[var(--accent)] uppercase tracking-wide mb-1.5">Agent is asking</div>
            <InlineQuestionComposer questions={pendingQuestion.questions} onAnswer={onAnswerQuestion} />
          </div>
        ) : pendingPermission && !editingMessageId ? (
          <div className="rounded-lg border border-[var(--warning-border,var(--border-color))] bg-[var(--bg-secondary)] p-3">
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
            <div className="chat-input-card relative rounded-2xl border border-[var(--border-color)] bg-[var(--bg-secondary)] focus-within:border-[var(--accent)]/50 focus-within:shadow-[0_0_0_3px_rgba(124,91,240,0.08)] transition-all duration-200 shadow-[0_2px_16px_rgba(0,0,0,0.25)]">
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
              {/* Textarea row */}
              <div className="flex items-end">
                {sessionDir && (
                  <button
                    onClick={onShowFilePicker}
                    className="p-3 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors shrink-0 self-center"
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
                  placeholder="Message…"
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
                currentBranch={currentBranch}
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
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
