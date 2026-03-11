import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import DiffViewer from "./DiffViewer";
import type { DiffMode } from "./DiffViewer";
import FileIcon from "./FileIcon";
import type { PrComment, PrFileEntry } from "../types";

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
  onBack: () => void;
  onAskClaude?: (prompt: string) => void;
  onClaudeReview?: (prNumber: number, headRefName: string) => void;
}

export default function PRReviewView({ directory, prNumber, prTitle, prUrl, headRefName, onBack, onAskClaude, onClaudeReview }: PRReviewViewProps) {
  const [files, setFiles] = useState<PrFileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [fileDiff, setFileDiff] = useState("");
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [diffMode, setDiffMode] = useState<DiffMode>(
    () => (localStorage.getItem("git-diff-mode") as DiffMode) || "unified"
  );

  const [commentLine, setCommentLine] = useState<number | null>(null);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());

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

  useEffect(() => {
    loadComments();
  }, [loadComments]);

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

  const handleAskClaude = useCallback(() => {
    if (!onAskClaude || !selectedFile) return;
    const context = fileDiff
      ? `Please review this diff for ${selectedFile} in PR #${prNumber}:\n\n\`\`\`diff\n${fileDiff.slice(0, 4000)}\n\`\`\``
      : `Please review the changes in ${selectedFile} for PR #${prNumber}`;
    onAskClaude(context);
  }, [onAskClaude, selectedFile, fileDiff, prNumber]);

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
          onClick={() => { setSelectedFile(file.path); setCommentLine(null); }}
          className={`w-full text-left py-1 pr-2 text-xs font-mono flex items-center gap-1.5 rounded-lg transition-colors cursor-pointer ${
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
            className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center cursor-pointer transition-all ${
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
          className="w-full text-left py-1 pr-2 text-xs flex items-center gap-1.5 rounded-lg transition-colors cursor-pointer text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
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
  }, [collapsedDirs, comments, selectedFile, viewedFiles, toggleDir, toggleViewed, setSelectedFile, setCommentLine]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--text-tertiary)]">
        <svg className="animate-spin h-5 w-5 opacity-40" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-xs">Loading PR diff…</span>
      </div>
    );
  }

  const progressPct = files.length > 0 ? (viewedFiles.size / files.length) * 100 : 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 pl-3 pr-10 py-2 border-b border-[var(--border-color)] flex-shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors px-2 py-1 rounded-lg hover:bg-[var(--bg-tertiary)] flex-shrink-0"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Pull Requests
        </button>
        <div className="w-px h-4 bg-[var(--border-color)] flex-shrink-0" />
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="text-[11px] font-mono font-semibold text-[var(--accent)] flex-shrink-0">#{prNumber}</span>
          <span className="text-xs text-[var(--text-primary)] truncate font-semibold">{prTitle}</span>
        </div>

        {/* Right side controls */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Progress bar */}
          {files.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-[var(--text-tertiary)] tabular-nums whitespace-nowrap">
                {viewedFiles.size}/{files.length}
              </span>
              <div className="w-14 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
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
            className="p-1.5 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Open on GitHub"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </button>

          {onAskClaude && selectedFile && (
            <button
              onClick={handleAskClaude}
              className="text-[11px] font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors px-2 py-1 rounded-lg hover:bg-[var(--accent)]/10"
            >
              Ask Claude
            </button>
          )}

          {onClaudeReview && (
            <button
              onClick={() => onClaudeReview(prNumber, headRefName)}
              className="p-1.5 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-colors"
              title="Claude review in new session"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
            </button>
          )}

          <button
            onClick={() => {
              const next = diffMode === "unified" ? "split" : "unified";
              setDiffMode(next);
              localStorage.setItem("git-diff-mode", next);
            }}
            className="text-[11px] font-medium text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-2 py-1 rounded-lg hover:bg-[var(--bg-tertiary)]"
          >
            {diffMode === "unified" ? "Split" : "Unified"}
          </button>
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

          {/* Diff viewer */}
          <div className="flex-1 w-0 flex flex-col bg-[var(--bg-primary)]">
            <div className="flex-1 overflow-auto">
              {diffLoading ? (
                <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] gap-2">
                  <svg className="animate-spin h-4 w-4 opacity-50" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-sm">Loading diff…</span>
                </div>
              ) : selectedFile ? (
                <DiffViewer
                  diff={fileDiff}
                  mode={diffMode}
                  filePath={selectedFile}
                  searchQuery=""
                  currentMatch={0}
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
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--text-tertiary)]">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-25">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="text-sm">Select a file to review</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
