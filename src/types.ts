export type AgentProvider = "claude-code" | "opencode";

export interface ModelOption {
  id: string;
  name: string;
  desc: string;
  free?: boolean;
}

export const AGENT_PROVIDERS: { id: AgentProvider; label: string; models: ModelOption[]; defaultModel: string }[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    defaultModel: "claude-opus-4-6",
    models: [
      { id: "claude-opus-4-6", name: "Opus 4.6", desc: "Most capable for complex work" },
      { id: "claude-sonnet-4-6", name: "Sonnet 4.6", desc: "Best for everyday tasks" },
      { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", desc: "Fastest for quick answers" },
    ],
  },
  {
    id: "opencode",
    label: "Open Code",
    defaultModel: "",
    models: [], // populated dynamically via fetch_opencode_models
  },
];

export function modelsForProvider(provider: AgentProvider): ModelOption[] {
  return AGENT_PROVIDERS.find((p) => p.id === provider)?.models ?? [];
}

export function defaultModelForProvider(provider: AgentProvider): string {
  return AGENT_PROVIDERS.find((p) => p.id === provider)?.defaultModel ?? "";
}

export interface Session {
  id: string;
  name: string;
  status: "running" | "stopped" | "starting";
  createdAt: number;
  lastActiveAt: number;
  lastMessageAt: number; // updated only when user sends a message (for sidebar sort)
  directory: string;
  provider: AgentProvider;
  model?: string; // model ID used for this session
  homeDirectory?: string; // original directory before switching to a worktree
  claudeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
  permissionMode?: "bypassPermissions" | "plan";
  activeTime?: number; // cumulative ms of running time
  hasTitleBeenGenerated?: boolean; // true if a smart title has been generated
  pendingPrompt?: string; // auto-sent on bridge_ready (e.g. PR review)
  planContent?: string; // plan markdown shown as pinned block (from plan-mode fork)
  exitCode?: number; // last process exit code (non-zero = error)
  hasDraft?: boolean; // true when user has typed text in the input but not sent it
  hasQuestion?: boolean; // true when the agent called AskUserQuestion and is waiting for an answer
  parentSessionId?: string; // ID of parent session (set when forked from plan mode)
}

/** The directory where the session's JSONL was created (homeDirectory if the
 *  session was moved to a worktree, otherwise the current directory). */
export function jsonlDirectory(session: Session): string {
  return session.homeDirectory ?? session.directory;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  contextTokens: number;
  isBusy: boolean;
}

export interface GitFileEntry {
  path: string;
  status: string; // "M", "A", "D", "??", "MM", etc.
  staged: boolean;
}

export interface GitStatusResult {
  branch: string;
  files: GitFileEntry[];
  isGitRepo: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  headRefName: string;
  author: string;
  authorAvatar: string;
  hasMyApproval: boolean;
  hasMyComment: boolean;
  checksTotal: number;
  checksPassing: number;
  checksFailing: number;
  checksPending: number;
  checks: CheckInfo[];
}

export interface CheckInfo {
  name: string;
  status: "pass" | "fail" | "pending";
}

export interface PullRequestsResult {
  reviewRequested: PullRequest[];
  myPrs: PullRequest[];
  ghAvailable: boolean;
  error: string | null;
}

// Phase 2: Branch Comparison
export interface BranchDiffFile {
  path: string;
  status: string;
}

export interface BranchDiffResult {
  files: BranchDiffFile[];
}

export interface BranchCommit {
  hash: string;
  short_hash: string;
  author_email: string;
  author_name: string;
  subject: string;
  is_mine: boolean;
  files: BranchDiffFile[];
}

export interface BranchCommitsResult {
  commits: BranchCommit[];
  user_email: string;
}

// Phase 3: PR Review
export interface PrFileEntry {
  path: string;
  status: "A" | "M" | "D" | "R";
}

export interface PrDiffResult {
  files: PrFileEntry[];
  fullDiff: string;
}

export interface PrComment {
  id: number;
  path: string;
  line: number;
  body: string;
  bodyHtml: string;
  user: string;
  createdAt: string;
}

export interface Worktree {
  path: string;        // absolute path (e.g. /repo/.worktrees/feat-x, or /repo for main)
  branch: string;      // current branch name
  isMain: boolean;     // is this the main working tree?
  sessions: Session[]; // sessions in this worktree, sorted by lastActiveAt desc
  lastActiveAt: number;
}

export interface Workspace {
  id: string;           // repo root path
  directory: string;    // repo root path
  worktrees: Worktree[];// including main worktree
  lastActiveAt: number;
}
