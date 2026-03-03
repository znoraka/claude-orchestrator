export interface Session {
  id: string;
  name: string;
  status: "running" | "stopped" | "starting";
  createdAt: number;
  lastActiveAt: number;
  directory: string;
  claudeSessionId?: string;
  dangerouslySkipPermissions?: boolean;
  activeTime?: number; // cumulative ms of running time
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
}

export interface PullRequestsResult {
  reviewRequested: PullRequest[];
  myPrs: PullRequest[];
  ghAvailable: boolean;
  error: string | null;
}
