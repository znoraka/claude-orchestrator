import { invoke } from "../../../lib/bridge";
import { AGENT_PROVIDERS } from "../../../types";
import type { AgentProvider, ModelOption } from "../../../types";

interface PillBarProps {
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
  isGenerating: boolean;
  onAbort: () => void;
  canSend: boolean;
  onSend: () => void;
}

export function PillBar({
  sessionStatus, sessionProvider, sessionPermissionMode,
  currentModel, activeModels, currentBranch,
  openPill, setOpenPill, modelSearchTerm, setModelSearchTerm, filteredModels,
  reasoningEffort, setReasoningEffort,
  onModelChange, onPermissionModeChange, onProviderChange, providerAvailability,
  targetSessionId, pillRowRef, modelSearchRef,
  isGenerating, onAbort, canSend, onSend,
}: PillBarProps) {
  return (
    <div className="flex items-center gap-1.5 px-3 pb-3 border-t border-[var(--border-subtle)] pt-2.5">
      <div ref={pillRowRef} className="flex items-center gap-1.5 flex-1 min-w-0">
        {/* Provider pill — only for pending sessions */}
        {sessionStatus === "pending" && (
          <div className="relative">
            <button
              onClick={() => setOpenPill(openPill === "provider" ? null : "provider")}
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              {AGENT_PROVIDERS.find((p) => p.id === sessionProvider)?.label ?? "Provider"}
              <svg className="w-2.5 h-2.5 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
            </button>
            {openPill === "provider" && (
              <div className="absolute bottom-full mb-1 left-0 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg z-50 min-w-[160px]">
                {AGENT_PROVIDERS.map((p) => {
                  const available = providerAvailability?.[p.id] !== false;
                  return (
                    <button
                      key={p.id}
                      disabled={!available}
                      className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors rounded-md ${sessionProvider === p.id ? "bg-[var(--accent)]/15 text-[var(--text-primary)]" : available ? "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]" : "text-[var(--text-tertiary)] opacity-40 cursor-not-allowed"}`}
                      onMouseDown={(e) => { e.preventDefault(); if (available) { onProviderChange?.(p.id); setOpenPill(null); } }}
                    >
                      {p.label}
                      {!available && <span className="ml-1 text-[10px]">not installed</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Model pill */}
        <div className="relative">
          <button
            onClick={() => setOpenPill(openPill === "model" ? null : "model")}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            {activeModels.find((m) => m.id === currentModel)?.name ?? currentModel?.split("/").pop() ?? "Model"}
            <svg className="w-2.5 h-2.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
          </button>
          {openPill === "model" && (
            <div className="absolute bottom-full mb-1 left-0 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg z-50 min-w-[200px] max-h-[300px] overflow-hidden flex flex-col">
              <div className="p-2 border-b border-[var(--border-color)]">
                <input
                  ref={modelSearchRef}
                  type="text"
                  value={modelSearchTerm}
                  onChange={(e) => setModelSearchTerm(e.target.value)}
                  placeholder="Search models..."
                  className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-2 py-1 text-[11px] outline-none focus:border-[var(--accent)]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && filteredModels.length > 0) { onModelChange?.(filteredModels[0].id); setOpenPill(null); }
                    if (e.key === "Escape") setOpenPill(null);
                  }}
                />
              </div>
              <div className="overflow-y-auto flex-1">
                {filteredModels.length === 0 ? (
                  <div className="px-3 py-2 text-[10px] text-[var(--text-tertiary)] italic">No models found</div>
                ) : (
                  filteredModels.map((model) => (
                    <button
                      key={model.id}
                      className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${currentModel === model.id ? "bg-[var(--accent)]/15 text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"}`}
                      onMouseDown={(e) => { e.preventDefault(); onModelChange?.(model.id); setOpenPill(null); }}
                    >
                      <div className="font-medium">{model.name}</div>
                      {model.desc && <div className="text-[10px] text-[var(--text-tertiary)]">{model.desc}</div>}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Mode toggle */}
        <button
          onClick={async () => {
            const newMode = sessionPermissionMode === "bypassPermissions" ? "plan" : "bypassPermissions";
            onPermissionModeChange?.(newMode);
            try {
              const msg = JSON.stringify({ type: "set_permission_mode", permissionMode: newMode });
              await invoke("send_agent_message", { sessionId: targetSessionId, message: msg });
            } catch { }
          }}
          className="px-2 py-0.5 text-[11px] rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          {sessionPermissionMode === "bypassPermissions" ? "Chat" : "Plan"}
        </button>

        {/* Effort pill */}
        <div className="relative">
          <button
            onClick={() => setOpenPill(openPill === "effort" ? null : "effort")}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            {reasoningEffort === "low" ? "Low" : reasoningEffort === "medium" ? "Medium" : "High"}
            <svg className="w-2.5 h-2.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
          </button>
          {openPill === "effort" && (
            <div className="absolute bottom-full mb-1 left-0 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg z-50 min-w-[100px]">
              {(["low", "medium", "high"] as const).map((level) => (
                <button
                  key={level}
                  className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${reasoningEffort === level ? "bg-[var(--accent)]/15 text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"}`}
                  onMouseDown={async (e) => {
                    e.preventDefault();
                    setReasoningEffort(level);
                    try {
                      const msg = JSON.stringify({ type: "set_reasoning_effort", effort: level });
                      await invoke("send_agent_message", { sessionId: targetSessionId, message: msg });
                    } catch { }
                    setOpenPill(null);
                  }}
                >
                  {level === "low" ? "Low" : level === "medium" ? "Medium" : "High"}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Branch info */}
        {currentBranch && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--text-tertiary)]">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            {currentBranch}
          </span>
        )}
      </div>

      {/* Stop / Send */}
      {isGenerating && (
        <button onClick={onAbort} className="ml-auto px-3 py-1.5 bg-red-500/15 hover:bg-red-500/25 text-red-400 rounded-lg text-sm font-medium transition-colors shrink-0 border border-red-500/20">Stop</button>
      )}
      <button
        onClick={onSend}
        disabled={!canSend}
        className={`${isGenerating ? "" : "ml-auto"} px-3 py-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-35 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-all duration-150 shrink-0 shadow-[0_0_12px_rgba(124,91,240,0.2)]`}
      >
        {isGenerating ? "Queue" : "Send"}
      </button>
    </div>
  );
}
