import { useRef, useState, useEffect, useCallback } from "react";
import type { AgentProvider, ModelOption } from "../types";
import { useAttachments } from "./chat/hooks/useAttachments";
import type { ImageAttachment, PastedFile } from "./chat/hooks/useAttachments";
import { useInputAutocomplete } from "./chat/hooks/useInputAutocomplete";
import { ChatInput } from "./chat/input/ChatInput";

export interface VirtualSessionState {
  directory: string;
  draftText: string;
  provider: AgentProvider;
  model: string;
  permissionMode: "bypassPermissions" | "plan";
  reasoningEffort: "low" | "medium" | "high";
  images: ImageAttachment[];
  pastedFiles: PastedFile[];
  selectionStart?: number;
  selectionEnd?: number;
}

interface NewSessionPanelProps {
  virtualSession: VirtualSessionState;
  isActive: boolean;
  activeModels: ModelOption[];
  providerAvailability?: Record<string, boolean>;
  onSend: (
    text: string,
    provider: AgentProvider,
    model: string,
    permissionMode: "bypassPermissions" | "plan",
    images: ImageAttachment[],
    files: PastedFile[]
  ) => Promise<void>;
  onDraftChange: (dir: string, text: string) => void;
  onProviderChange: (dir: string, provider: AgentProvider) => void;
  onModelChange: (dir: string, model: string) => void;
  onPermissionModeChange: (dir: string, mode: "bypassPermissions" | "plan") => void;
  onReasoningEffortChange: (dir: string, effort: "low" | "medium" | "high") => void;
  onAttachmentsChange: (dir: string, images: ImageAttachment[], pastedFiles: PastedFile[]) => void;
  onCursorChange: (dir: string, start: number, end: number) => void;
  onDismiss: () => void;
  onCreateTerminal?: (directory: string, command?: string) => void;
}

export default function NewSessionPanel({
  virtualSession,
  isActive,
  activeModels,
  providerAvailability,
  onSend,
  onDraftChange,
  onProviderChange,
  onModelChange,
  onPermissionModeChange,
  onReasoningEffortChange,
  onAttachmentsChange,
  onCursorChange,
  onDismiss,
  onCreateTerminal,
}: NewSessionPanelProps) {
  const { directory, draftText, provider, model, permissionMode, reasoningEffort } = virtualSession;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const pillRowRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const [openPill, setOpenPill] = useState<"provider" | "model" | "mode" | "effort" | null>(null);
  const [modelSearchTerm, setModelSearchTerm] = useState("");
  const [sending, setSending] = useState(false);

  // Attachments (images, files, drag-and-drop)
  const { images, setImages, pastedFiles, setPastedFiles, handlePaste, removeImage, removePastedFile } = useAttachments(isActive, textareaRef);

  // Restore saved attachments on mount
  useEffect(() => {
    if (virtualSession.images?.length) setImages(virtualSession.images);
    if (virtualSession.pastedFiles?.length) setPastedFiles(virtualSession.pastedFiles);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track cursor position in a ref to avoid re-renders; save to parent on unmount
  const cursorRef = useRef({ start: virtualSession.selectionStart ?? draftText.length, end: virtualSession.selectionEnd ?? draftText.length });
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;
  const onAttachmentsChangeRef = useRef(onAttachmentsChange);
  onAttachmentsChangeRef.current = onAttachmentsChange;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const pastedFilesRef = useRef(pastedFiles);
  pastedFilesRef.current = pastedFiles;
  const directoryRef = useRef(directory);
  directoryRef.current = directory;

  useEffect(() => {
    return () => {
      onCursorChangeRef.current(directoryRef.current, cursorRef.current.start, cursorRef.current.end);
      onAttachmentsChangeRef.current(directoryRef.current, imagesRef.current, pastedFilesRef.current);
    };
  }, []);

  // Auto-focus when panel becomes active
  useEffect(() => {
    if (isActive && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(cursorRef.current.start, cursorRef.current.end);
    }
  }, [isActive]);

  // Auto-focus input when typing anywhere (matches AgentChat behavior)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || textareaRef.current === document.activeElement ||
        (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA"))) return;
      textareaRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const filteredModels = activeModels.filter((m) =>
    !modelSearchTerm || m.name.toLowerCase().includes(modelSearchTerm.toLowerCase()) || m.id.toLowerCase().includes(modelSearchTerm.toLowerCase())
  );

  const handleSend = useCallback(async () => {
    const text = draftText.trim();
    if ((!text && images.length === 0 && pastedFiles.length === 0) || sending) return;
    setSending(true);
    try {
      await onSend(text, provider, model, permissionMode, images, pastedFiles);
    } finally {
      setSending(false);
    }
  }, [draftText, sending, onSend, provider, model, permissionMode, images, pastedFiles]);

  // Track cursor on textarea changes
  const handleSetInputText = (text: string) => {
    if (textareaRef.current) {
      cursorRef.current = { start: textareaRef.current.selectionStart, end: textareaRef.current.selectionEnd };
    }
    onDraftChange(directory, text);
  };

  const {
    fileSuggestions, setFileSuggestions,
    fileMenuIndex, setFileMenuIndex, fileMenuRef,
    showFileMenu, selectFile,
    slashMenuIndex, setSlashMenuIndex, slashMenuRef,
    showSlashMenu, filteredSlashCommands, selectSlashCommand,
  } = useInputAutocomplete(draftText, handleSetInputText, directory, textareaRef);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (showFileMenu) {
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); setFileMenuIndex((i) => Math.min(i + 1, fileSuggestions.length - 1)); return; }
      if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); setFileMenuIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); selectFile(fileSuggestions[fileMenuIndex]); return; }
      if (e.key === "Escape") { e.preventDefault(); setFileSuggestions([]); return; }
    }
    if (showSlashMenu && filteredSlashCommands.length > 0) {
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); setSlashMenuIndex((i) => Math.min(i + 1, filteredSlashCommands.length - 1)); return; }
      if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); setSlashMenuIndex((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const cmd = filteredSlashCommands[slashMenuIndex];
        if (e.key === "Enter" && filteredSlashCommands.length === 1) { handleSetInputText(""); handleSend(); }
        else selectSlashCommand(cmd);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); handleSetInputText(""); return; }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onDismiss();
      return;
    }
    if (e.key === "Tab") { e.preventDefault(); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [showFileMenu, fileSuggestions, fileMenuIndex, setFileMenuIndex, selectFile, setFileSuggestions,
      showSlashMenu, filteredSlashCommands, slashMenuIndex, setSlashMenuIndex, selectSlashCommand,
      handleSend, handleSetInputText, onDismiss]);

  const dirLabel = directory.split("/").filter(Boolean).pop() || directory;

  return (
    <div className="absolute inset-0 flex flex-col bg-[var(--bg-primary)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-subtle)]">
        <span className="text-xs text-[var(--text-tertiary)]">New session in</span>
        <span className="text-xs font-medium text-[var(--text-secondary)] font-mono">{dirLabel}</span>
      </div>

      {/* Compose area */}
      <div className="flex-1 min-h-0 flex flex-col justify-end">
        <ChatInput
          inputText={draftText}
          setInputText={handleSetInputText}
          inputRef={textareaRef}
          inputAreaRef={inputAreaRef}
          images={images}
          pastedFiles={pastedFiles}
          fileReferences={[]}
          onRemoveImage={removeImage}
          onRemovePastedFile={removePastedFile}
          onRemoveFileRef={() => {}}
          onViewFileRef={() => {}}
          onPaste={handlePaste}
          isGenerating={sending}
          onSend={handleSend}
          onAbort={() => {}}
          pendingQuestion={null}
          pendingPermission={null}
          onAnswerQuestion={() => {}}
          onAllowPermission={() => {}}
          onDenyPermission={() => {}}
          onAllowInNew={() => {}}
          onPlanFeedback={() => {}}
          editingMessageId={null}
          onCancelEdit={() => {}}
          sessionDir={directory}
          sessionStatus="pending"
          sessionProvider={provider}
          sessionPermissionMode={permissionMode}
          currentModel={model}
          activeModels={activeModels}
          currentBranch={undefined}
          openPill={openPill}
          setOpenPill={setOpenPill}
          modelSearchTerm={modelSearchTerm}
          setModelSearchTerm={setModelSearchTerm}
          filteredModels={filteredModels}
          reasoningEffort={reasoningEffort}
          setReasoningEffort={(effort) => onReasoningEffortChange(directory, effort)}
          onModelChange={(id) => onModelChange(directory, id)}
          onPermissionModeChange={(mode) => onPermissionModeChange(directory, mode)}
          onProviderChange={(p) => onProviderChange(directory, p)}
          providerAvailability={providerAvailability}
          targetSessionId=""
          pillRowRef={pillRowRef}
          modelSearchRef={modelSearchRef}
          showFileMenu={showFileMenu}
          fileSuggestions={fileSuggestions}
          fileMenuIndex={fileMenuIndex}
          setFileMenuIndex={setFileMenuIndex}
          fileMenuRef={fileMenuRef}
          onSelectFile={selectFile}
          showSlashMenu={showSlashMenu}
          filteredSlashCommands={filteredSlashCommands}
          slashMenuIndex={slashMenuIndex}
          setSlashMenuIndex={setSlashMenuIndex}
          slashMenuRef={slashMenuRef}
          onSelectSlashCommand={selectSlashCommand}
          onShowFilePicker={() => {}}
          handleKeyDown={handleKeyDown}
          onCreateTerminal={onCreateTerminal ? () => onCreateTerminal(directory) : undefined}
        />
        <p className="pb-4 text-[11px] text-[var(--text-tertiary)] text-center">
          Press <kbd className="px-1 py-0.5 rounded bg-[var(--bg-tertiary)] font-mono text-[10px]">Esc</kbd> to go back · <kbd className="px-1 py-0.5 rounded bg-[var(--bg-tertiary)] font-mono text-[10px]">Enter</kbd> to send
        </p>
      </div>
    </div>
  );
}
