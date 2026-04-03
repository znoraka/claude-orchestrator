import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "../lib/bridge";
import { openUrl } from "../lib/bridge";
import FileDiffModal from "./FileDiffModal";
import { Spinner } from "./ui/spinner";
import FileIcon from "./FileIcon";
import type { BlameLine, PrComment, PrFileEntry, PrIssueComment } from "../types";

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

// Tree node for the file tree
interface FileTreeNode {
  name: string;
  path: string;
  children: FileTreeNode[];
  file?: PrFileEntry;
}

function buildFileTree(files: PrFileEntry[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;
    let pathSoFar = "";
    for (let i = 0; i < parts.length; i++) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${parts[i]}` : parts[i];
      const isLast = i === parts.length - 1;
      let existing = current.find((n) => n.name === parts[i] && (isLast ? !!n.file : !n.file));
      if (!existing) {
        existing = {
          name: parts[i],
          path: pathSoFar,
          children: [],
          ...(isLast ? { file } : {}),
        };
        current.push(existing);
      }
      current = existing.children;
    }
  }
  function collapse(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes.map((node) => {
      node.children = collapse(node.children);
      if (!node.file && node.children.length === 1 && !node.children[0].file) {
        const child = node.children[0];
        return { ...child, name: `${node.name}/${child.name}` };
      }
      return node;
    });
  }
  return collapse(root);
}

// Colored dot per file status
const STATUS_DOT: Record<string, string> = {
  A: "bg-[var(--success)]",
  M: "bg-[var(--status-waiting)]",
  D: "bg-[var(--danger)]",
  R: "bg-blue-400",
};

const STATUS_LABEL: Record<string, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
};

interface PRReviewViewProps {
  directory: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  headRefName: string;
  currentBranch?: string;
  onBack: () => void;
  onBranchChanged?: () => void;
  onClaudeReview?: (prNumber: number, headRefName: string) => void;
}

export default function PRReviewView({ directory, prNumber, prTitle, prUrl, headRefName, currentBranch, onBack, onBranchChanged, onClaudeReview }: PRReviewViewProps) {
  const [files, setFiles] = useState<PrFileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [fileDiff, setFileDiff] = useState("");
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [diffModalFile, setDiffModalFile] = useState<string | null>(null);

  const [commentLine, setCommentLine] = useState<number | null>(null);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const [blameLines, setBlameLines] = useState<BlameLine[]>([]);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [issueComments, setIssueComments] = useState<PrIssueComment[]>([]);
  const [newComment, setNewComment] = useState("");
  const [postingGeneral, setPostingGeneral] = useState(false);
  const [prBodyHtml, setPrBodyHtml] = useState<string>("");

  const isCurrent = currentBranch === headRefName;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleCheckout = useCallback(async () => {
    setCheckoutLoading(true);
    try {
      await invoke<string>("checkout_pr", { directory, prNumber });
      onBranchChanged?.();
      showToast(`Checked out #${prNumber}`);
    } catch (err) {
      showToast(`Error: ${err}`);
    } finally {
      setCheckoutLoading(false);
    }
  }, [directory, prNumber, onBranchChanged, showToast]);

  const handleWorktree = useCallback(async () => {
    setWorktreeLoading(true);
    try {
      const path = await invoke<string>("checkout_pr_worktree", {
        directory,
        prNumber,
        headRefName,
      });
      showToast(`Worktree: ${path}`);
    } catch (err) {
      showToast(`Error: ${err}`);
    } finally {
      setWorktreeLoading(false);
    }
  }, [directory, prNumber, headRefName, showToast]);

  const toggleViewed = useCallback((file: string) => {
    const willBeViewed = !viewedFiles.has(file);
    setViewedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file); else next.add(file);
      return next;
    });
    invoke("set_pr_file_viewed", { directory, prNumber, path: file, viewed: willBeViewed })
      .catch((e) => console.error("Failed to sync viewed state:", e));
  }, [directory, prNumber, viewedFiles]);

  useEffect(() => {
    invoke<string[]>("get_pr_viewed_files", { directory, prNumber })
      .then((viewed) => setViewedFiles(new Set(viewed)))
      .catch((e) => console.error("Failed to fetch viewed files:", e));
  }, [directory, prNumber]);

  useEffect(() => {
    setLoading(true);
    invoke<{ files: PrFileEntry[]; fullDiff: string }>("get_pr_diff", { directory, prNumber })
      .then((result) => {
        setFiles(result.files);
        if (result.files.length > 0) setSelectedFile(result.files[0].path);
      })
      .catch((e) => console.error("Failed to load PR diff:", e))
      .finally(() => setLoading(false));
  }, [directory, prNumber]);

  const loadComments = useCallback(async () => {
    try {
      const result = await invoke<PrComment[]>("get_pr_comments", { directory, prNumber });
      setComments(result);
    } catch (e) {
      console.error("Failed to load comments:", e);
    }
  }, [directory, prNumber]);

  const loadIssueComments = useCallback(async () => {
    try {
      const result = await invoke<PrIssueComment[]>("get_pr_issue_comments", { directory, prNumber });
      setIssueComments(result);
    } catch (e) {
      console.error("Failed to load issue comments:", e);
    }
  }, [directory, prNumber]);

  useEffect(() => {
    loadComments();
    loadIssueComments();
    invoke<string>("get_pr_body", { directory, prNumber })
      .then(setPrBodyHtml)
      .catch(() => {});
  }, [loadComments, loadIssueComments, directory, prNumber]);

  useEffect(() => {
    if (!selectedFile) {
      setFileDiff("");
      return;
    }
    setDiffLoading(true);
    invoke<string>("get_pr_file_diff", { directory, prNumber, filePath: selectedFile })
      .then(setFileDiff)
      .catch((e) => setFileDiff(`Error: ${e}`))
      .finally(() => setDiffLoading(false));
  }, [selectedFile, directory, prNumber]);

  useEffect(() => {
    if (!selectedFile) return;
    setBlameLines([]);
    invoke<BlameLine[]>("git_blame_pr_file", { directory, prNumber, filePath: selectedFile })
      .then(setBlameLines)
      .catch(() => {/* blame is optional */});
  }, [selectedFile, directory, prNumber]);

  const blameMap = useMemo(() => {
    if (blameLines.length === 0) return undefined;
    const m = new Map<number, BlameLine>();
    for (const b of blameLines) m.set(b.line, b);
    return m;
  }, [blameLines]);

  const fileComments = useMemo(
    () => comments.filter((c) => c.path === selectedFile),
    [comments, selectedFile]
  );

  const handleLineClick = useCallback((lineNumber: number) => {
    setCommentLine(lineNumber);
    setCommentText("");
  }, []);

  const handlePostComment = useCallback(async () => {
    if (!commentText.trim() || !selectedFile || commentLine === null || posting) return;
    setPosting(true);
    try {
      await invoke("post_pr_comment", {
        directory,
        prNumber,
        body: commentText.trim(),
        path: selectedFile,
        line: commentLine,
      });
      setCommentText("");
      setCommentLine(null);
      loadComments();
    } catch (e) {
      console.error("Failed to post comment:", e);
    } finally {
      setPosting(false);
    }
  }, [directory, prNumber, selectedFile, commentLine, commentText, posting, loadComments]);

  const handlePostGeneralComment = useCallback(async () => {
    if (!newComment.trim() || postingGeneral) return;
    setPostingGeneral(true);
    try {
      await invoke("post_pr_issue_comment", {
        directory,
        prNumber,
        body: newComment.trim(),
      });
      setNewComment("");
      loadIssueComments();
      loadComments();
    } catch (e) {
      console.error("Failed to post comment:", e);
      showToast(`Error posting comment: ${e}`);
    } finally {
      setPostingGeneral(false);
    }
  }, [directory, prNumber, newComment, postingGeneral, loadIssueComments, loadComments, showToast]);


  const selectedIndex = useMemo(() => files.findIndex((f) => f.path === selectedFile), [files, selectedFile]);

  const navigateFile = useCallback((delta: number) => {
    const next = files[selectedIndex + delta];
    if (next) {
      setSelectedFile(next.path);
      setDiffModalFile(next.path);
      setCommentLine(null);
      setBlameLines([]);
    }
  }, [files, selectedIndex]);

  const fileTree = useMemo(() => buildFileTree(files), [files]);

  const toggleDir = useCallback((dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath); else next.add(dirPath);
      return next;
    });
  }, []);

  const renderTreeNode = useCallback((node: FileTreeNode, depth: number) => {
    if (node.file) {
      const file = node.file;
      const commentCount = comments.filter((c) => c.path === file.path).length;
      const isViewed = viewedFiles.has(file.path);
      const isSelected = selectedFile === file.path;
      const dotColor = STATUS_DOT[file.status] || "bg-[var(--text-tertiary)]";
      const statusLabel = STATUS_LABEL[file.status] || file.status;

      return (
        <div
          key={file.path}
          onClick={() => { setSelectedFile(file.path); setDiffModalFile(file.path); setCommentLine(null); setBlameLines([]); }}
          className={`w-full text-left py-1 pr-2 text-xs font-mono flex items-center gap-1.5 cursor-pointer ${
            isSelected
              ? "bg-[var(--accent)] text-white"
              : isViewed
                ? "text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                : "text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          title={file.path}
        >
          <span
            role="checkbox"
            aria-checked={isViewed}
            onClick={(e) => { e.stopPropagation(); toggleViewed(file.path); }}
            className={`flex-shrink-0 w-4 h-4 border-2 flex items-center justify-center cursor-pointer ${
              isViewed
                ? isSelected
                  ? "bg-white/90 border-white/90"
                  : "bg-[var(--success)] border-[var(--success)]"
                : isSelected
                  ? "border-white/50 hover:border-white/80"
                  : "border-[var(--text-tertiary)]/50 hover:border-[var(--text-secondary)]"
            }`}
            title="Mark as viewed"
          >
            {isViewed && (
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke={isSelected ? "var(--accent)" : "white"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 6l3 3 5-5" />
              </svg>
            )}
          </span>
          <FileIcon filename={file.path} />
          <span className={`truncate flex-1 ${isViewed && !isSelected ? "line-through opacity-50" : ""}`}>
            {node.name}
          </span>
          {commentCount > 0 && (
            <span className={`text-[10px] flex-shrink-0 tabular-nums ${isSelected ? "text-white/70" : "text-[var(--status-waiting)]"}`}>
              {commentCount}
            </span>
          )}
          {/* Colored dot instead of letter, with tooltip */}
          <span
            className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${isSelected ? "bg-white/70" : dotColor}`}
            title={statusLabel}
          />
        </div>
      );
    }

    // Directory node
    const isCollapsed = collapsedDirs.has(node.path);
    return (
      <div key={node.path}>
        <div
          onClick={() => toggleDir(node.path)}
          className="w-full text-left py-1 pr-2 text-xs flex items-center gap-1.5 cursor-pointer text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`flex-shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0 opacity-40">
            {isCollapsed ? (
              <path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z" />
            ) : (
              <path d="M.513 1.513A1.75 1.75 0 011.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 00.2.1h6.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25V2.75c0-.464.184-.91.513-1.237z" />
            )}
          </svg>
          <span className="truncate font-medium text-xs">{node.name}</span>
        </div>
        {!isCollapsed && node.children.map((child) => renderTreeNode(child, depth + 1))}
      </div>
    );
  }, [collapsedDirs, comments, selectedFile, viewedFiles, toggleDir, toggleViewed, setSelectedFile, setDiffModalFile, setCommentLine]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--text-tertiary)]">
        <Spinner className="w-5 h-5" />
        <span className="text-xs">Loading PR diff…</span>
      </div>
    );
  }

  const progressPct = files.length > 0 ? (viewedFiles.size / files.length) * 100 : 0;

  return (
    <div className="flex flex-col h-full relative">
      {toast && (
        <div className="absolute right-12 top-2 z-10 px-2 py-1 text-[10px] bg-[var(--bg-secondary)] border-2 border-[var(--border-color)] shadow-lg text-[var(--text-secondary)] max-w-[220px] truncate">
          {toast}
        </div>
      )}
      {/* Header */}
      <div className="flex items-center gap-2 pl-3 pr-10 py-2 border-b border-[var(--border-color)] flex-shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-2 py-1 hover:bg-[var(--bg-tertiary)] flex-shrink-0"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Pull Requests
        </button>
        <div className="w-px h-4 bg-[var(--border-color)] flex-shrink-0" />
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-[11px] font-mono font-bold text-[var(--accent)] flex-shrink-0">#{prNumber}</span>
          <span className="text-xs text-[var(--text-primary)] truncate font-bold uppercase tracking-wider">{prTitle}</span>
        </div>

        {/* Right side controls */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Progress bar */}
          {files.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-[var(--text-tertiary)] tabular-nums whitespace-nowrap">
                {viewedFiles.size}/{files.length}
              </span>
              <div className="w-14 h-1.5 bg-[var(--bg-tertiary)] overflow-hidden">
                <div
                  className="h-full"
                  style={{
                    width: `${progressPct}%`,
                    background: progressPct === 100 ? "var(--success)" : "var(--accent)",
                  }}
                />
              </div>
            </div>
          )}

          <div className="w-px h-3.5 bg-[var(--border-color)]" />

          <button
            onClick={() => openUrl(prUrl)}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            title="Open on GitHub"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </button>

          <button
            onClick={handleCheckout}
            disabled={checkoutLoading || isCurrent}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30 disabled:cursor-default"
            title={isCurrent ? "Already on this branch" : `Checkout ${headRefName}`}
          >
            {checkoutLoading ? (
              <Spinner className="w-3.5 h-3.5" />
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
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-30"
            title="Checkout in worktree"
          >
            {worktreeLoading ? (
              <Spinner className="w-3.5 h-3.5" />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
            )}
          </button>


          {onClaudeReview && (
            <button
              onClick={() => onClaudeReview(prNumber, headRefName)}
              className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
              title="Claude review in new session"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
            </button>
          )}

        </div>
      </div>

      {files.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-[var(--text-tertiary)]">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-25">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span className="text-xs font-medium">No files changed</span>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* File tree */}
          <div className="w-72 flex-shrink-0 border-r border-[var(--border-color)] overflow-y-auto py-2 px-1.5" style={{ background: "var(--drawer-bg)" }}>
            {fileTree.map((node) => renderTreeNode(node, 0))}
          </div>

          {/* Discussion panel — always visible */}
          <div className="flex-1 min-w-0 flex flex-col" style={{ background: "var(--drawer-bg)" }}>
            <div className="px-3 py-2 border-b border-[var(--border-color)] flex items-center justify-between flex-shrink-0">
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">
                Discussion
              </span>
              <div className="flex items-center gap-2">
                {(issueComments.length + comments.length) > 0 && (
                  <span className="text-[10px] text-[var(--text-tertiary)] tabular-nums">
                    {issueComments.length + comments.length} comments
                  </span>
                )}
                <button
                  onClick={() => { loadComments(); loadIssueComments(); }}
                  className="p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  title="Refresh comments"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {/* PR description */}
              {prBodyHtml && (
                <div className="px-4 py-3 border-b border-[var(--border-color)]">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">Description</div>
                  <div
                    className="text-[12px] text-[var(--text-secondary)] leading-relaxed prose-comment"
                    dangerouslySetInnerHTML={{ __html: prBodyHtml }}
                  />
                </div>
              )}

              {issueComments.length === 0 && comments.length === 0 && !prBodyHtml ? (
                <div className="flex flex-col items-center justify-center h-32 gap-2 text-[var(--text-tertiary)]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-25">
                    <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
                  </svg>
                  <span className="text-[11px]">No comments yet</span>
                </div>
              ) : (
                <div className="flex flex-col">
                  {issueComments.map((c) => (
                    <div key={`issue-${c.id}`} className="px-4 py-3 border-b border-[var(--border-subtle)]">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="text-[11px] font-semibold text-[var(--text-primary)]">{c.user}</span>
                        <span className="text-[10px] text-[var(--text-tertiary)]">{relativeTime(c.createdAt)}</span>
                      </div>
                      <div
                        className="text-[12px] text-[var(--text-secondary)] leading-relaxed prose-comment"
                        dangerouslySetInnerHTML={{ __html: c.bodyHtml }}
                      />
                    </div>
                  ))}

                  {comments.length > 0 && (
                    <>
                      {issueComments.length > 0 && (
                        <div className="px-4 py-1.5 bg-[var(--bg-tertiary)]">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Review Comments</span>
                        </div>
                      )}
                      {comments.map((c) => (
                        <div
                          key={`review-${c.id}`}
                          className="px-4 py-3 border-b border-[var(--border-subtle)] cursor-pointer hover:bg-[var(--bg-tertiary)]"
                          onClick={() => { setSelectedFile(c.path); setDiffModalFile(c.path); setCommentLine(null); setBlameLines([]); }}
                        >
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="text-[11px] font-semibold text-[var(--text-primary)]">{c.user}</span>
                            <span className="text-[10px] text-[var(--text-tertiary)]">{relativeTime(c.createdAt)}</span>
                          </div>
                          <div className="text-[10px] text-[var(--accent)] font-mono mb-1 truncate">
                            {c.path}{c.line > 0 ? `:${c.line}` : ""}
                          </div>
                          <div
                            className="text-[12px] text-[var(--text-secondary)] leading-relaxed prose-comment"
                            dangerouslySetInnerHTML={{ __html: c.bodyHtml }}
                          />
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* New general comment input */}
            <div className="border-t border-[var(--border-color)] p-3 flex-shrink-0">
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handlePostGeneralComment();
                  }
                }}
                placeholder="Add a comment…"
                rows={3}
                className="w-full bg-[var(--bg-secondary)] border-2 border-[var(--border-color)] px-2.5 py-2 text-[12px] text-[var(--text-primary)] placeholder-[var(--text-tertiary)] outline-none focus:border-[var(--accent)]/50 resize-none font-mono"
              />
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[10px] text-[var(--text-tertiary)]">
                  {/Mac|iPhone|iPad/.test(navigator.userAgent) ? "Cmd" : "Ctrl"}+Enter to send
                </span>
                <button
                  onClick={handlePostGeneralComment}
                  disabled={!newComment.trim() || postingGeneral}
                  className="px-3 py-1 text-[11px] font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-default"
                >
                  {postingGeneral ? "Posting…" : "Comment"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Diff modal */}
      {diffModalFile && (
        <FileDiffModal
          path={diffModalFile}
          diff={fileDiff}
          diffLoading={diffLoading}
          onClose={() => { setDiffModalFile(null); setCommentLine(null); setCommentText(""); }}
          blameMap={blameMap}
          onLineClick={handleLineClick}
          inlineComments={{
            comments: fileComments,
            commentLine,
            commentText,
            onCommentTextChange: setCommentText,
            onPostComment: handlePostComment,
            onCancelComment: () => { setCommentLine(null); setCommentText(""); },
            posting,
          }}
          isViewed={viewedFiles.has(diffModalFile)}
          onToggleViewed={() => toggleViewed(diffModalFile)}
          hasPrev={selectedIndex > 0}
          hasNext={selectedIndex < files.length - 1}
          onPrevFile={() => navigateFile(-1)}
          onNextFile={() => navigateFile(1)}
        />
      )}
    </div>
  );
}
