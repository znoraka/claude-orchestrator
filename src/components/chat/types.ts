import type { AgentProvider, ModelOption, Session, SessionUsage } from "../../types";
import type { FileReference } from "../FilePickerModal";

export interface AgentChatProps {
  sessionId: string;
  isActive: boolean;
  onExit: (exitCode?: number) => void;
  onActivity: () => void;
  onBusyChange?: (isBusy: boolean) => void;
  onUsageUpdate?: (usage: SessionUsage) => void;
  onDraftChange?: (hasDraft: boolean) => void;
  onQuestionChange?: (hasQuestion: boolean) => void;
  onClaudeSessionId?: (claudeSessionId: string) => void;
  session?: Session;
  onResume?: () => Promise<void> | void;
  onFork?: (systemPrompt: string) => void;
  onForkWithPrompt?: (systemPrompt: string, pendingPrompt: string, planContent?: string) => Promise<string>;
  currentModel?: string;
  onModelChange?: (modelId: string) => void;
  activeModels?: ModelOption[];
  onInputHeightChange?: (height: number) => void;
  onEditFile?: (filePath: string, line?: number) => void;
  onOpenFile?: (filePath: string, diff: string) => void;
  onAvailableModels?: (models: Array<{ id: string; providerID: string; name: string; free: boolean; costIn: number; costOut: number }>) => void;
  onRename?: (name: string) => void;
  onMarkTitleGenerated?: () => void;
  onClearPendingPrompt?: () => void;
  onNavigateToSession?: (sessionId: string) => void;
  onPermissionModeChange?: (mode: "bypassPermissions" | "plan") => void;
  parentSession?: { id: string; name: string; claudeSessionId?: string; directory?: string } | null;
  childSessions?: Array<{ id: string; name: string; claudeSessionId?: string; directory?: string; status: string }>;
  providerAvailability?: Record<string, boolean>;
  onProviderChange?: (provider: AgentProvider) => void;
  onStartPendingSession?: (provider: AgentProvider, model: string) => Promise<void>;
}

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type: string; media_type?: string; data?: string; url?: string; path?: string };
  thinking?: string;
}

export interface ChatMessage {
  id: string;
  type: "user" | "assistant" | "system" | "result" | "error";
  content: ContentBlock[];
  timestamp: number;
  isStreaming?: boolean;
  costUsd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  durationMs?: number;
  forkSessionId?: string;
  forkSessionName?: string;
  isParentMessage?: boolean;
}

export interface ToolGroup {
  toolUse: ContentBlock;
  toolResult?: ContentBlock;
  blockId: string;
}

export interface GroupedBlocks {
  items: Array<{ type: "content"; block: ContentBlock } | { type: "toolGroup"; group: ToolGroup }>;
}

export type ToolsSegmentItem =
  | { type: "tool"; group: ToolGroup }
  | { type: "thinking"; block: ContentBlock };

export interface ToolBundle {
  id: string;
  groups: ToolGroup[];
  lastGroup: ToolGroup;
  toolCounts: Record<string, number>;
  allDone: boolean;
  anyError: boolean;
}

export type BundledItem =
  | { type: "content"; block: ContentBlock }
  | { type: "toolGroup"; group: ToolGroup }
  | { type: "toolBundle"; bundle: ToolBundle };

export interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  diff: string;
}

export type { FileReference };
