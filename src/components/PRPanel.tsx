import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "../lib/bridge";
import { openUrl } from "../lib/bridge";
import type { PullRequest, PullRequestsResult, GitStatusResult } from "../types";
import { useSessionContext } from "../contexts/SessionContext";
import PRReviewView from "./PRReviewView";
import { Spinner } from "./ui/spinner";

interface PRPanelProps {
  directory: string;
  workspaces?: Array<{ id: string; directory: string }>;
  isActive?: boolean;
  onResetRef?: React.RefObject<(() => void) | null>;
  onSwitchToClaude?: () => void;
  initialPrNumber?: number;
  initialPrKey?: number;
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
      <span className="px-2 py-0.5 text-[10px] bg-[var(--text-tertiary)]/10 text-[var(--text-tertiary)] border-2 border-[var(--text-tertiary)]/15">
        Draft
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 text-[10px] bg-[var(--success)]/15 text-[var(--success)] border-2 border-[var(--success)]/25">
      Open
    </span>
  );
}

function ChecksIndicator({ pr }: { pr: PullRequest }) {
  if (pr.checksTotal === 0) return null;

  const allPass = pr.checksFailing === 0 && pr.checksPending === 0;
  const hasFail = pr.checksFailing > 0;

  const colorClass = hasFail
    ? "text-[var(--danger)]"
    : allPass
    ? "text-[var(--success)]"
    : "text-[var(--status-waiting)]";

  const bgClass = hasFail
    ? "bg-[var(--danger)]/10 border-[var(--danger)]/20"
    : allPass
    ? "bg-[var(--success)]/10 border-[var(--success)]/20"
    : "bg-[var(--status-waiting)]/10 border-[var(--status-waiting)]/20";

  const CheckIcon = hasFail ? (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  ) : allPass ? (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6l3 3 5-5" />
    </svg>
  ) : (
    <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor">
      <circle cx="4" cy="4" r="3" />
    </svg>
  );

  return (
    <span className={`relative group/checks flex items-center gap-1 px-1.5 py-0.5 text-[10px] border-2 ${bgClass} ${colorClass} cursor-default`}>
      {CheckIcon}
      {pr.checksPassing}/{pr.checksTotal}
      <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover/checks:block min-w-[200px] max-w-[300px] max-h-[300px] overflow-y-auto bg-[var(--bg-primary)] border-2 border-[var(--border-color)] shadow-lg p-2 text-[10px]">
        <div className="text-[var(--text-secondary)] font-semibold mb-1.5">
          Checks: {pr.checksPassing} passed, {pr.checksFailing} failed{pr.checksPending > 0 ? `, ${pr.checksPending} pending` : ""}
        </div>
        {pr.checks.map((check, i) => (
          <div key={i} className="flex items-center gap-1.5 py-0.5">
            <span className={
              check.status === "pass" ? "text-[var(--success)]" :
              check.status === "fail" ? "text-[var(--danger)]" :
              "text-[var(--status-waiting)]"
            }>
              {check.status === "pass" ? (
                <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6l3 3 5-5" /></svg>
              ) : check.status === "fail" ? (
                <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6" /></svg>
              ) : (
                <svg width="7" height="7" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="3" /></svg>
              )}
            </span>
            <span className="text-[var(--text-primary)] truncate">{check.name}</span>
          </div>
        ))}
      </div>
    </span>
  );
}

function PRCard({
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
    <div className="relative px-3">
      <div
        className={`group/card border-2 px-3 py-2.5 ${
          isCurrent
            ? "border-[var(--accent-color)]/40 bg-[var(--accent-color)]/5"
            : "border-[var(--card-border)] bg-[var(--card-bg)] hover:border-[var(--border-color)]"
        }`}
        style={isCurrent ? { borderLeftWidth: 3, borderLeftColor: "var(--accent-color)" } : undefined}
      >
        {/* Title */}
        <div
          onClick={() => openUrl(pr.url)}
          className="text-sm font-medium text-[var(--text-primary)] leading-snug mb-1.5 cursor-pointer hover:text-[var(--text-secondary)]"
        >
          {pr.title}
        </div>

        {/* Badges + meta row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <StatusPill pr={pr} />
            <ChecksIndicator pr={pr} />
            {isCurrent && (
              <span className="px-2 py-0.5 text-[10px] bg-[var(--accent-color)]/20 text-[var(--accent-color)] border-2 border-[var(--accent-color)]/30">
                current
              </span>
            )}
            {pr.hasMyApproval && (
              <span className="px-2 py-0.5 text-[10px] bg-blue-500/20 text-blue-400 border-2 border-blue-500/30">
                approved
              </span>
            )}
            {pr.hasMyComment && (
              <span className="px-2 py-0.5 text-[10px] bg-[var(--status-waiting)]/15 text-[var(--status-waiting)] border-2 border-[var(--status-waiting)]/25">
                commented
              </span>
            )}
            <span className="text-[10px] text-[var(--text-tertiary)] truncate">
              #{pr.number} · {pr.author} · {relativeTime(pr.updatedAt)}
            </span>
          </div>

          {/* Actions — appear on hover, pinned to right */}
          <div className="flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 flex-shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); onReviewPR(pr); }}
              className="p-1 hover:bg-white/5 text-[var(--text-tertiary)] hover:text-[var(--accent-color)]"
              title="Review PR diff"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onClaudeReview(pr.number, pr.headRefName); }}
              className="p-1 hover:bg-white/5 text-[var(--text-tertiary)] hover:text-[var(--accent-color)]"
              title="Claude review in new session"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
            </button>
            <button
              onClick={handleCheckout}
              disabled={checkoutLoading || isCurrent}
              className="p-1 hover:bg-white/5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-default"
              title={isCurrent ? "Already on this branch" : "Checkout branch"}
            >
              {checkoutLoading ? (
                <Spinner className="w-3 h-3" />
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="16 3 21 3 21 8" />
                  <line x1="4" y1="20" x2="21" y2="3" />
                  <polyline points="21 16 21 21 16 21" />
                  <line x1="15" y1="15" x2="21" y2="21" />
                </svg>
              )}
            </button>
            <button
              onClick={handleWorktree}
              disabled={worktreeLoading}
              className="p-1 hover:bg-white/5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30"
              title="Checkout in worktree"
            >
              {worktreeLoading ? (
                <Spinner className="w-3 h-3" />
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      {toast && (
        <div className="absolute right-5 top-2 z-10 px-2 py-1 text-[10px] bg-[var(--bg-secondary)] border-2 border-[var(--border-color)] shadow-lg text-[var(--text-secondary)] max-w-[200px] truncate">
          {toast}
        </div>
      )}
    </div>
  );
}

// Per-workspace data cache so tabs don't lose state on switch
interface WorkspaceCache {
  result: PullRequestsResult | null;
  loading: boolean;
  currentBranch: string;
  hasFetched: boolean;
  reviewingPr: PullRequest | null;
  searchQuery: string;
}

function defaultCache(): WorkspaceCache {
  return { result: null, loading: true, currentBranch: "", hasFetched: false, reviewingPr: null, searchQuery: "" };
}

export default function PRPanel({ directory, workspaces, isActive, onResetRef, onSwitchToClaude: _onSwitchToClaude, initialPrNumber, initialPrKey }: PRPanelProps) {
  const { createSession, sessions } = useSessionContext();

  // Selected directory is independent of the active workspace — users switch via tabs
  const [selectedDirectory, setSelectedDirectory] = useState(directory);

  // Cache per-workspace data so switching tabs is instant and state is preserved
  const cacheRef = useRef<Map<string, WorkspaceCache>>(new Map());

  const getCache = (dir: string): WorkspaceCache => {
    if (!cacheRef.current.has(dir)) {
      cacheRef.current.set(dir, defaultCache());
    }
    return cacheRef.current.get(dir)!;
  };

  // Force re-render when cache changes
  const [, forceUpdate] = useState(0);
  const rerender = () => forceUpdate(n => n + 1);

  const cache = getCache(selectedDirectory);

  // Expose reset function to parent via ref
  useEffect(() => {
    if (onResetRef) {
      onResetRef.current = () => {
        getCache(selectedDirectory).reviewingPr = null;
        rerender();
      };
      return () => { onResetRef.current = null; };
    }
  }, [onResetRef, selectedDirectory]);

  const handleClaudeReview = useCallback(async (prNumber: number, headRefName: string) => {
    const dir = selectedDirectory;
    let sessionDir = dir;
    try {
      const worktrees = await invoke<Array<{ path: string; branch: string; isMain: boolean }>>(
        "list_worktrees",
        { directory: dir }
      );
      const match = worktrees.find((wt) => wt.branch === headRefName);
      if (match) {
        sessionDir = match.path;
      } else {
        const main = worktrees.find((wt) => wt.isMain);
        if (main) sessionDir = main.path;
      }
    } catch {
      // Fall back to base directory
    }

    const skipPerms = sessions.some(
      (s) => s.directory === dir && s.dangerouslySkipPermissions
    );
    const prSystemPrompt =
      `You are reviewing PR #${prNumber} (branch: ${headRefName}). ` +
      `IMPORTANT: Do NOT post any review comments, approvals, or change requests to GitHub without explicit user confirmation first. Always show the review content and ask for consent before submitting. ` +
      `If the user asks you to make changes or implement something, you MUST first ask if they want to continue in a new worktree for this PR branch. ` +
      `Do NOT skip this question even if you have dangerous permissions. ` +
      `If they say yes, use the checkout_pr_worktree MCP tool with directory="${sessionDir}", pr_number=${prNumber}, branch="${headRefName}", then cd into the resulting path.`;
    await createSession(`Review PR #${prNumber}`, sessionDir, skipPerms, prSystemPrompt, `/review ${prNumber}`);
  }, [createSession, selectedDirectory, sessions]);

  const handleReviewPR = useCallback((pr: PullRequest) => {
    getCache(selectedDirectory).reviewingPr = pr;
    rerender();
  }, [selectedDirectory]);

  const fetchBranch = useCallback(async (dir: string) => {
    try {
      const status = await invoke<GitStatusResult>("get_git_status", { directory: dir });
      getCache(dir).currentBranch = status.branch;
      rerender();
    } catch {
      getCache(dir).currentBranch = "";
      rerender();
    }
  }, []);

  const refresh = useCallback(async (dir: string) => {
    getCache(dir).loading = true;
    rerender();
    try {
      const data = await invoke<PullRequestsResult>("get_pull_requests", { directory: dir });
      getCache(dir).result = data;
    } catch (e) {
      getCache(dir).result = {
        reviewRequested: [],
        myPrs: [],
        ghAvailable: false,
        error: String(e),
      };
    } finally {
      getCache(dir).loading = false;
      rerender();
    }
  }, []);

  // Fetch on activation or when selected directory changes (if not yet fetched)
  useEffect(() => {
    if (isActive && !getCache(selectedDirectory).hasFetched) {
      getCache(selectedDirectory).hasFetched = true;
      refresh(selectedDirectory);
      fetchBranch(selectedDirectory);
    }
  }, [isActive, selectedDirectory]);

  // Periodic refresh
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      refresh(selectedDirectory);
      fetchBranch(selectedDirectory);
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [isActive, selectedDirectory]);

  // When a PR open is requested from outside, switch to the correct workspace tab
  const lastOpenedPrKeyRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!initialPrNumber || !initialPrKey) return;
    if (lastOpenedPrKeyRef.current === initialPrKey) return;
    // Switch to the workspace that requested the PR
    if (selectedDirectory !== directory) {
      setSelectedDirectory(directory);
    }
  }, [initialPrNumber, initialPrKey, directory]);

  // Auto-open the specific PR once that workspace's data is loaded
  useEffect(() => {
    if (!initialPrNumber || !initialPrKey || !cache.result) return;
    if (lastOpenedPrKeyRef.current === initialPrKey) return;
    const allPrs = [...(cache.result.myPrs ?? []), ...(cache.result.reviewRequested ?? [])];
    const pr = allPrs.find((p) => p.number === initialPrNumber);
    if (pr) {
      lastOpenedPrKeyRef.current = initialPrKey;
      getCache(selectedDirectory).reviewingPr = pr;
      rerender();
    }
  }, [initialPrNumber, initialPrKey, cache.result]);

  // Workspace tabs (only show when there are multiple workspaces)
  const tabWorkspaces = workspaces && workspaces.length > 1 ? workspaces : null;

  const setSearchQuery = (q: string) => {
    getCache(selectedDirectory).searchQuery = q;
    rerender();
  };

  const { result, loading, currentBranch, reviewingPr, searchQuery } = cache;

  if (reviewingPr) {
    return (
      <div className="flex flex-col h-full">
        {tabWorkspaces && (
          <WorkspaceTabs
            workspaces={tabWorkspaces}
            selectedDirectory={selectedDirectory}
            onSelect={setSelectedDirectory}
          />
        )}
        <div className="flex-1 min-h-0">
          <PRReviewView
            directory={selectedDirectory}
            prNumber={reviewingPr.number}
            prTitle={reviewingPr.title}
            prUrl={reviewingPr.url}
            headRefName={reviewingPr.headRefName}
            currentBranch={currentBranch}
            onBack={() => { getCache(selectedDirectory).reviewingPr = null; rerender(); }}
            onBranchChanged={() => fetchBranch(selectedDirectory)}
            onClaudeReview={handleClaudeReview}
          />
        </div>
      </div>
    );
  }

  if (loading && !result) {
    return (
      <div className="flex flex-col h-full">
        {tabWorkspaces && (
          <WorkspaceTabs
            workspaces={tabWorkspaces}
            selectedDirectory={selectedDirectory}
            onSelect={setSelectedDirectory}
          />
        )}
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-[var(--text-tertiary)]">
          <Spinner className="w-5 h-5" />
          <span className="text-xs text-[var(--text-tertiary)]">Loading pull requests…</span>
        </div>
      </div>
    );
  }

  if (result && !result.ghAvailable) {
    return (
      <div className="flex flex-col h-full">
        {tabWorkspaces && (
          <WorkspaceTabs
            workspaces={tabWorkspaces}
            selectedDirectory={selectedDirectory}
            onSelect={setSelectedDirectory}
          />
        )}
        <div className="flex flex-col items-center justify-center flex-1 gap-4 text-[var(--text-tertiary)] px-6">
          <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor" className="opacity-25">
            <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          <div className="text-center">
            <div className="text-xs text-[var(--text-secondary)] mb-2 font-medium">
              {result.error || "GitHub CLI not available"}
            </div>
            <button
              onClick={() => openUrl("https://cli.github.com")}
              className="text-[11px] text-[var(--accent-color)] hover:text-[var(--accent-hover)] hover:underline"
            >
              Install GitHub CLI
            </button>
          </div>
        </div>
      </div>
    );
  }

  const filterPRs = (prs: PullRequest[]) => {
    if (!searchQuery.trim()) return prs;
    const q = searchQuery.toLowerCase();
    return prs.filter(
      (pr) =>
        pr.title.toLowerCase().includes(q) ||
        String(pr.number).includes(q) ||
        pr.author.toLowerCase().includes(q) ||
        pr.headRefName.toLowerCase().includes(q)
    );
  };

  const filteredMyPrs = filterPRs(result?.myPrs ?? []);
  const filteredReviewRequested = filterPRs(result?.reviewRequested ?? []);
  const totalCount =
    (result?.reviewRequested.length ?? 0) + (result?.myPrs.length ?? 0);
  const filteredCount = filteredMyPrs.length + filteredReviewRequested.length;

  return (
    <div className="flex flex-col h-full">
      {tabWorkspaces && (
        <WorkspaceTabs
          workspaces={tabWorkspaces}
          selectedDirectory={selectedDirectory}
          onSelect={setSelectedDirectory}
        />
      )}

      {/* Header */}
      <div className="flex items-center gap-2.5 pl-4 pr-10 py-3 border-b border-[var(--border-color)] flex-shrink-0">
        <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-primary)]">Pull Requests</span>
        {totalCount > 0 && (
          <span className="px-2 py-0.5 text-[10px] font-semibold bg-[var(--accent-color)]/15 text-[var(--accent-color)] border-2 border-[var(--accent-color)]/25 tabular-nums">
            {searchQuery.trim() ? `${filteredCount}/${totalCount}` : totalCount}
          </span>
        )}
        <div className="ml-auto">
          <button
            onClick={() => { refresh(selectedDirectory); fetchBranch(selectedDirectory); }}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            title="Refresh"
          >
            {loading ? (
              <Spinner className="w-4 h-4" />
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {totalCount > 0 && (
        <div className="px-3 py-2 border-b border-[var(--border-color)] flex-shrink-0">
          <div className="relative">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search pull requests…"
              className="w-full bg-[var(--bg-secondary)] border-2 border-[var(--border-color)] pl-8 pr-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-tertiary)] outline-none focus:border-[var(--accent-color)]/50"
            />
          </div>
        </div>
      )}

      {totalCount === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-[var(--text-tertiary)] px-6">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-25">
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M13 6h3a2 2 0 012 2v7" />
            <line x1="6" y1="9" x2="6" y2="21" />
          </svg>
          <span className="text-xs font-medium">No open pull requests</span>
        </div>
      ) : filteredCount === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-[var(--text-tertiary)]">
          <span className="text-xs">No PRs match your search</span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {filteredMyPrs.length > 0 && (
            <div>
              <div className="px-4 pt-4 pb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">
                My Pull Requests ({filteredMyPrs.length})
              </div>
              <div className="flex flex-col gap-3">
                {filteredMyPrs.map((pr) => (
                  <PRCard
                    key={`my-${pr.url}`}
                    pr={pr}
                    currentBranch={currentBranch}
                    directory={selectedDirectory}
                    onBranchChanged={() => fetchBranch(selectedDirectory)}
                    onReviewPR={handleReviewPR}
                    onClaudeReview={handleClaudeReview}
                  />
                ))}
              </div>
            </div>
          )}
          {filteredMyPrs.length > 0 && filteredReviewRequested.length > 0 && (
            <div className="mx-4 my-2 border-t border-[var(--border-subtle)]" />
          )}
          {filteredReviewRequested.length > 0 && (
            <div>
              <div className="px-4 pt-2 pb-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">
                Review Requested ({filteredReviewRequested.length})
              </div>
              <div className="flex flex-col gap-3">
                {filteredReviewRequested.map((pr) => (
                  <PRCard
                    key={`review-${pr.url}`}
                    pr={pr}
                    currentBranch={currentBranch}
                    directory={selectedDirectory}
                    onBranchChanged={() => fetchBranch(selectedDirectory)}
                    onReviewPR={handleReviewPR}
                    onClaudeReview={handleClaudeReview}
                  />
                ))}
              </div>
            </div>
          )}
          <div className="h-3" />
        </div>
      )}
    </div>
  );
}

function WorkspaceTabs({
  workspaces,
  selectedDirectory,
  onSelect,
}: {
  workspaces: Array<{ id: string; directory: string }>;
  selectedDirectory: string;
  onSelect: (dir: string) => void;
}) {
  return (
    <div className="flex items-center gap-0 border-b border-[var(--border-color)] flex-shrink-0 overflow-x-auto scrollbar-none">
      {workspaces.map((ws) => {
        const name = ws.directory.split("/").filter(Boolean).pop() ?? ws.directory;
        const isActive = ws.directory === selectedDirectory;
        return (
          <button
            key={ws.id}
            onClick={() => onSelect(ws.directory)}
            title={ws.directory}
            className={`px-3 py-2 text-[11px] font-medium whitespace-nowrap border-b-2 transition-colors flex-shrink-0 ${
              isActive
                ? "border-[var(--accent-color)] text-[var(--accent-color)]"
                : "border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:border-[var(--border-color)]"
            }`}
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}
