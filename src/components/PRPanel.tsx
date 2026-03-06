import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PullRequest, PullRequestsResult, GitStatusResult } from "../types";
import { useSessionContext } from "../contexts/SessionContext";
import PRReviewView from "./PRReviewView";

interface PRPanelProps {
  directory: string;
  isActive?: boolean;
  onResetRef?: React.RefObject<(() => void) | null>;
  onAskClaude?: (prompt: string) => void;
  onSwitchToClaude?: () => void;
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function StatusPill({ pr }: { pr: PullRequest }) {
  if (pr.isDraft) {
    return (
      <span className="px-1.5 py-0.5 text-[10px] rounded bg-gray-700 text-gray-300">
        Draft
      </span>
    );
  }
  return (
    <span className="px-1.5 py-0.5 text-[10px] rounded bg-green-900/50 text-green-400">
      Open
    </span>
  );
}

function ChecksIndicator({ pr }: { pr: PullRequest }) {
  if (pr.checksTotal === 0) return null;

  const allPass = pr.checksFailing === 0 && pr.checksPending === 0;
  const hasFail = pr.checksFailing > 0;

  const color = hasFail
    ? "text-red-400"
    : allPass
    ? "text-green-400"
    : "text-yellow-400";

  const bgColor = hasFail
    ? "bg-red-900/50"
    : allPass
    ? "bg-green-900/50"
    : "bg-yellow-900/50";

  const icon = hasFail ? "✕" : allPass ? "✓" : "●";

  return (
    <span className={`relative group/checks px-1.5 py-0.5 text-[10px] rounded ${bgColor} ${color} cursor-default`}>
      {icon} {pr.checksPassing}/{pr.checksTotal}
      <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover/checks:block min-w-[200px] max-w-[300px] max-h-[300px] overflow-y-auto bg-[var(--bg-primary)] border border-[var(--border-color)] rounded shadow-lg p-2 text-[10px]">
        <div className="text-[var(--text-secondary)] font-semibold mb-1.5">
          Checks: {pr.checksPassing} passed, {pr.checksFailing} failed{pr.checksPending > 0 ? `, ${pr.checksPending} pending` : ""}
        </div>
        {pr.checks.map((check, i) => (
          <div key={i} className="flex items-center gap-1.5 py-0.5">
            <span className={
              check.status === "pass" ? "text-green-400" :
              check.status === "fail" ? "text-red-400" :
              "text-yellow-400"
            }>
              {check.status === "pass" ? "✓" : check.status === "fail" ? "✕" : "●"}
            </span>
            <span className="text-[var(--text-primary)] truncate">{check.name}</span>
          </div>
        ))}
      </div>
    </span>
  );
}

function PRRow({
  pr,
  currentBranch,
  directory,
  onBranchChanged,
  onReviewPR,
  onClaudeReview,
}: {
  pr: PullRequest;
  currentBranch: string;
  directory: string;
  onBranchChanged: () => void;
  onReviewPR: (pr: PullRequest) => void;
  onClaudeReview: (prNumber: number, headRefName: string) => void;
}) {
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const isCurrent = currentBranch === pr.headRefName;

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleCheckout = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setCheckoutLoading(true);
    try {
      await invoke<string>("checkout_pr", { directory, prNumber: pr.number });
      onBranchChanged();
      showToast(`Checked out #${pr.number}`);
    } catch (err) {
      showToast(`Error: ${err}`);
    } finally {
      setCheckoutLoading(false);
    }
  };

  const handleWorktree = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setWorktreeLoading(true);
    try {
      const path = await invoke<string>("checkout_pr_worktree", {
        directory,
        prNumber: pr.number,
        headRefName: pr.headRefName,
      });
      showToast(`Worktree: ${path}`);
    } catch (err) {
      showToast(`Error: ${err}`);
    } finally {
      setWorktreeLoading(false);
    }
  };

  return (
    <div className="relative">
      <div
        onClick={() => openUrl(pr.url)}
        className={`w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors flex items-start gap-2.5 group cursor-pointer ${
          isCurrent ? "bg-[var(--accent)]/5 border-l-2 border-[var(--accent)]" : ""
        }`}
      >
        <img
          src={pr.authorAvatar}
          alt={pr.author}
          className="w-5 h-5 rounded-full mt-0.5 flex-shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] text-[var(--text-tertiary)] font-mono truncate">
              #{pr.number}
            </span>
            <StatusPill pr={pr} />
            <ChecksIndicator pr={pr} />
            {isCurrent && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--accent)]/20 text-[var(--accent)]">
                current
              </span>
            )}
            {pr.hasMyApproval && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-green-900/50 text-green-400">
                approved
              </span>
            )}
            {pr.hasMyComment && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-yellow-900/50 text-yellow-400">
                commented
              </span>
            )}
          </div>
          <div className="text-[var(--text-primary)] truncate">{pr.title}</div>
          <div className="text-[10px] text-[var(--text-tertiary)] mt-0.5 flex items-center gap-1.5">
            <span>{pr.author} &middot; {relativeTime(pr.updatedAt)}</span>
            <span className="font-mono opacity-60">{pr.headRefName}</span>
          </div>
        </div>
        {/* Action buttons */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-1">
          <button
            onClick={(e) => { e.stopPropagation(); onReviewPR(pr); }}
            className="p-1 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)] hover:text-[var(--accent)] disabled:opacity-30"
            title="Review PR diff"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M8.5.75a.75.75 0 00-1.5 0v1.5h-1a.75.75 0 000 1.5h1v1.5a.75.75 0 001.5 0v-1.5h1a.75.75 0 000-1.5h-1V.75zM2 6.854v6.396c0 .414.336.75.75.75h10.5a.75.75 0 00.75-.75V6.854a.353.353 0 00-.354-.354H2.354a.353.353 0 00-.354.354zM.5 6.854c0-.747.606-1.354 1.354-1.354h12.292c.748 0 1.354.607 1.354 1.354v6.396A2.25 2.25 0 0113.25 15.5H2.75A2.25 2.25 0 01.5 13.25V6.854z" />
            </svg>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onClaudeReview(pr.number, pr.headRefName); }}
            className="p-1 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)] hover:text-[var(--accent)] disabled:opacity-30"
            title="Claude review in new session"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1.5 2.75a.25.25 0 01.25-.25h8.5a.25.25 0 01.25.25v5.5a.25.25 0 01-.25.25h-3.5a.75.75 0 00-.53.22L3.5 11.44V9.25a.75.75 0 00-.75-.75h-1a.25.25 0 01-.25-.25v-5.5zM1.75 1A1.75 1.75 0 000 2.75v5.5C0 9.216.784 10 1.75 10H2v1.543a1.457 1.457 0 002.487 1.03L7.061 10h3.189A1.75 1.75 0 0012 8.25v-5.5A1.75 1.75 0 0010.25 1h-8.5zM14.5 4.75a.25.25 0 00-.25-.25h-.5a.75.75 0 110-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0114.25 12H14v1.543a1.457 1.457 0 01-2.487 1.03L9.22 12.28a.75.75 0 111.06-1.06l2.22 2.22v-2.19a.75.75 0 01.75-.75h1a.25.25 0 00.25-.25v-5.5z" />
            </svg>
          </button>
          <button
            onClick={handleCheckout}
            disabled={checkoutLoading || isCurrent}
            className="p-1 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-default"
            title={isCurrent ? "Already on this branch" : "Checkout branch"}
          >
            {checkoutLoading ? (
              <span className="text-[10px]">...</span>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5.22 14.78a.75.75 0 001.06-1.06L4.56 12h8.69a.75.75 0 000-1.5H4.56l1.72-1.72a.75.75 0 00-1.06-1.06l-3 3a.75.75 0 000 1.06l3 3zM10.78 1.22a.75.75 0 00-1.06 1.06L11.44 4H2.75a.75.75 0 000 1.5h8.69l-1.72 1.72a.75.75 0 101.06 1.06l3-3a.75.75 0 000-1.06l-3-3z" />
              </svg>
            )}
          </button>
          <button
            onClick={handleWorktree}
            disabled={worktreeLoading}
            className="p-1 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30"
            title="Checkout in worktree"
          >
            {worktreeLoading ? (
              <span className="text-[10px]">...</span>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path fillRule="evenodd" d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75zM1.5 2.75a.25.25 0 01.25-.25H5c.09 0 .176.04.232.107l.952 1.269c.381.508.982.804 1.616.804h6.45a.25.25 0 01.25.25v8.5a.25.25 0 01-.25.25H1.75a.25.25 0 01-.25-.25V2.75z" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {toast && (
        <div className="absolute right-2 top-1 z-10 px-2 py-1 text-[10px] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded shadow-lg text-[var(--text-secondary)] max-w-[200px] truncate">
          {toast}
        </div>
      )}
    </div>
  );
}

export default function PRPanel({ directory, isActive, onAskClaude, onResetRef, onSwitchToClaude }: PRPanelProps) {
  const { createSession, sessions } = useSessionContext();
  const [result, setResult] = useState<PullRequestsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentBranch, setCurrentBranch] = useState("");
  const [reviewingPr, setReviewingPr] = useState<PullRequest | null>(null);

  // Expose reset function to parent via ref
  useEffect(() => {
    if (onResetRef) {
      onResetRef.current = () => setReviewingPr(null);
      return () => { onResetRef.current = null; };
    }
  }, [onResetRef]);

  const handleClaudeReview = useCallback(async (prNumber: number, headRefName: string) => {
    // Check if a worktree already exists for this PR's branch
    let sessionDir = directory;
    try {
      const worktrees = await invoke<Array<{ path: string; branch: string; isMain: boolean }>>(
        "list_worktrees",
        { directory }
      );
      const match = worktrees.find((wt) => wt.branch === headRefName);
      if (match) {
        sessionDir = match.path;
      } else {
        // Default to the main worktree directory, not the current workspace
        const main = worktrees.find((wt) => wt.isMain);
        if (main) sessionDir = main.path;
      }
    } catch {
      // Fall back to base directory
    }

    // Inherit permission mode from existing sessions in this workspace
    const skipPerms = sessions.some(
      (s) => s.directory === directory && s.dangerouslySkipPermissions
    );
    // Inject PR context as a hidden system prompt so it doesn't clutter the terminal
    const prSystemPrompt =
      `You are reviewing PR #${prNumber} (branch: ${headRefName}). ` +
      `If the user asks you to make changes or implement something, you MUST first ask if they want to continue in a new worktree for this PR branch. ` +
      `Do NOT skip this question even if you have dangerous permissions. ` +
      `If they say yes, use the checkout_pr_worktree MCP tool with directory="${sessionDir}", pr_number=${prNumber}, branch="${headRefName}", then cd into the resulting path.`;
    // pendingPrompt will be auto-sent by AgentChat once the bridge is ready
    await createSession(`Review PR #${prNumber}`, sessionDir, skipPerms, prSystemPrompt, `Review PR #${prNumber}`);
    onSwitchToClaude?.();
  }, [createSession, directory, sessions, onSwitchToClaude]);

  const handleReviewPR = useCallback((pr: PullRequest) => {
    setReviewingPr(pr);
  }, []);

  const fetchBranch = useCallback(async () => {
    try {
      const status = await invoke<GitStatusResult>("get_git_status", { directory });
      setCurrentBranch(status.branch);
    } catch {
      setCurrentBranch("");
    }
  }, [directory]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await invoke<PullRequestsResult>("get_pull_requests", { directory });
      setResult(data);
    } catch (e) {
      setResult({
        reviewRequested: [],
        myPrs: [],
        ghAvailable: false,
        error: String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [directory]);

  const hasFetched = useRef(false);

  useEffect(() => {
    if (isActive && !hasFetched.current) {
      hasFetched.current = true;
      refresh();
      fetchBranch();
    }
  }, [isActive, refresh, fetchBranch]);

  // Auto-refresh every 5 minutes when active
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      refresh();
      fetchBranch();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [isActive, refresh, fetchBranch]);

  // PR Review Mode
  if (reviewingPr) {
    return (
      <PRReviewView
        directory={directory}
        prNumber={reviewingPr.number}
        prTitle={reviewingPr.title}
        prUrl={reviewingPr.url}
        headRefName={reviewingPr.headRefName}
        onBack={() => setReviewingPr(null)}
        onAskClaude={onAskClaude}
        onClaudeReview={handleClaudeReview}
      />
    );
  }

  if (loading && !result) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
        Loading pull requests...
      </div>
    );
  }

  if (result && !result.ghAvailable) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center px-6">
          <div className="text-[var(--text-tertiary)] text-sm mb-2">
            {result.error || "GitHub CLI not available"}
          </div>
          <div className="text-[var(--text-tertiary)] text-xs">
            Install from{" "}
            <button
              onClick={() => openUrl("https://cli.github.com")}
              className="text-[var(--accent)] hover:underline"
            >
              cli.github.com
            </button>
          </div>
        </div>
      </div>
    );
  }

  const totalCount =
    (result?.reviewRequested.length ?? 0) + (result?.myPrs.length ?? 0);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border-color)] flex-shrink-0">
        <span className="text-xs text-[var(--text-secondary)]">
          Pull Requests
        </span>
        <span className="text-[10px] text-[var(--text-tertiary)]">
          {totalCount} open
        </span>
        <div className="ml-auto">
          <button
            onClick={() => { refresh(); fetchBranch(); }}
            className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-1.5 py-0.5 rounded hover:bg-[var(--bg-tertiary)]"
            title="Refresh"
          >
            {loading ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      {totalCount === 0 ? (
        <div className="flex items-center justify-center flex-1 text-[var(--text-tertiary)] text-sm">
          No open pull requests
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {result!.myPrs.length > 0 && (
            <div className="py-1">
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] px-3 py-1.5 font-semibold">
                My Pull Requests ({result!.myPrs.length})
              </div>
              {result!.myPrs.map((pr) => (
                <PRRow
                  key={`my-${pr.url}`}
                  pr={pr}
                  currentBranch={currentBranch}
                  directory={directory}
                  onBranchChanged={fetchBranch}
                  onReviewPR={handleReviewPR}
                  onClaudeReview={handleClaudeReview}
                />
              ))}
            </div>
          )}
          {result!.myPrs.length > 0 && result!.reviewRequested.length > 0 && (
            <div className="mx-3 border-t border-[var(--border-color)]" />
          )}
          {result!.reviewRequested.length > 0 && (
            <div className="py-1">
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] px-3 py-1.5 font-semibold">
                Review Requested ({result!.reviewRequested.length})
              </div>
              {result!.reviewRequested.map((pr) => (
                <PRRow
                  key={`review-${pr.url}`}
                  pr={pr}
                  currentBranch={currentBranch}
                  directory={directory}
                  onBranchChanged={fetchBranch}
                  onReviewPR={handleReviewPR}
                  onClaudeReview={handleClaudeReview}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
