export interface Session {
  id: string;
  name: string;
  status: "running" | "stopped" | "starting";
  createdAt: number;
  lastActiveAt: number;
  directory: string;
  homeDirectory?: string; // original directory before switching to a worktree
  claudeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
  activeTime?: number; // cumulative ms of running time
  hasTitleBeenGenerated?: boolean; // true if a smart title has been generated
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
export interface PrDiffResult {
  files: string[];
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
