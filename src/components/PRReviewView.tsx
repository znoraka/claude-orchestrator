import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import DiffViewer from "./DiffViewer";
import type { DiffMode } from "./DiffViewer";
import FileIcon from "./FileIcon";
import type { PrComment } from "../types";

interface PRReviewViewProps {
  directory: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  onBack: () => void;
  onAskClaude?: (prompt: string) => void;
  onClaudeReview?: (prNumber: number) => void;
}

export default function PRReviewView({ directory, prNumber, prTitle, prUrl, onBack, onAskClaude, onClaudeReview }: PRReviewViewProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState("");
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [diffMode, setDiffMode] = useState<DiffMode>(
    () => (localStorage.getItem("git-diff-mode") as DiffMode) || "unified"
  );

  // Inline comment state
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
    // Sync to GitHub in the background
    invoke("set_pr_file_viewed", { directory, prNumber, path: file, viewed: willBeViewed })
      .catch((e) => console.error("Failed to sync viewed state:", e));
  }, [directory, prNumber, viewedFiles]);

  // Fetch viewed state from GitHub
  useEffect(() => {
    invoke<string[]>("get_pr_viewed_files", { directory, prNumber })
      .then((viewed) => setViewedFiles(new Set(viewed)))
      .catch((e) => console.error("Failed to fetch viewed files:", e));
  }, [directory, prNumber]);

  // Load PR files
  useEffect(() => {
    setLoading(true);
    invoke<{ files: string[]; fullDiff: string }>("get_pr_diff", { directory, prNumber })
      .then((result) => {
        setFiles(result.files);
        if (result.files.length > 0) setSelectedFile(result.files[0]);
      })
      .catch((e) => console.error("Failed to load PR diff:", e))
      .finally(() => setLoading(false));
  }, [directory, prNumber]);

  // Load comments
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

  // Load file diff
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

  // Comments for current file
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
        Loading PR diff...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border-color)] flex-shrink-0">
        <button
          onClick={onBack}
          className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-1.5 py-0.5 rounded hover:bg-[var(--bg-tertiary)]"
        >
          Back
        </button>
        <span className="text-xs text-[var(--text-secondary)] truncate">
          <span className="font-mono text-[var(--text-tertiary)]">#{prNumber}</span>
          {" "}{prTitle}
        </span>
        <span className="text-[10px] text-[var(--text-tertiary)]">
          {viewedFiles.size}/{files.length} viewed
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => openUrl(prUrl)}
            className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-1.5 py-0.5 rounded hover:bg-[var(--bg-tertiary)] flex items-center gap-1"
            title="Open on GitHub"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            GitHub
          </button>
          {onAskClaude && selectedFile && (
            <button
              onClick={handleAskClaude}
              className="text-[10px] text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors px-1.5 py-0.5 rounded hover:bg-[var(--accent)]/10"
            >
              Ask Claude
            </button>
          )}
          {onClaudeReview && (
            <button
              onClick={() => onClaudeReview(prNumber)}
              className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors px-1.5 py-0.5 rounded hover:bg-[var(--bg-tertiary)] flex items-center gap-1"
              title="Claude review in new session"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.5 2.75a.25.25 0 01.25-.25h8.5a.25.25 0 01.25.25v5.5a.25.25 0 01-.25.25h-3.5a.75.75 0 00-.53.22L3.5 11.44V9.25a.75.75 0 00-.75-.75h-1a.25.25 0 01-.25-.25v-5.5zM1.75 1A1.75 1.75 0 000 2.75v5.5C0 9.216.784 10 1.75 10H2v1.543a1.457 1.457 0 002.487 1.03L7.061 10h3.189A1.75 1.75 0 0012 8.25v-5.5A1.75 1.75 0 0010.25 1h-8.5zM14.5 4.75a.25.25 0 00-.25-.25h-.5a.75.75 0 110-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0114.25 12H14v1.543a1.457 1.457 0 01-2.487 1.03L9.22 12.28a.75.75 0 111.06-1.06l2.22 2.22v-2.19a.75.75 0 01.75-.75h1a.25.25 0 00.25-.25v-5.5z" />
              </svg>
              Review
            </button>
          )}
          <button
            onClick={() => {
              const next = diffMode === "unified" ? "split" : "unified";
              setDiffMode(next);
              localStorage.setItem("git-diff-mode", next);
            }}
            className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-1.5 py-0.5 rounded hover:bg-[var(--bg-tertiary)]"
          >
            {diffMode === "unified" ? "Split" : "Unified"}
          </button>
        </div>
      </div>

      {files.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-[var(--text-tertiary)] text-sm">
          No files changed
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* File list */}
          <div className="w-64 flex-shrink-0 border-r border-[var(--border-color)] overflow-y-auto py-2">
            {files.map((file) => {
              const commentCount = comments.filter((c) => c.path === file).length;
              const isViewed = viewedFiles.has(file);
              const isSelected = selectedFile === file;
              return (
                <div
                  key={file}
                  onClick={() => { setSelectedFile(file); setCommentLine(null); }}
                  className={`w-full text-left px-2 py-1 text-xs font-mono flex items-center gap-1.5 rounded transition-colors cursor-pointer ${
                    isSelected
                      ? "bg-[var(--accent)] text-white"
                      : isViewed
                        ? "text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                        : "text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  }`}
                  title={file}
                >
                  <span
                    role="checkbox"
                    aria-checked={isViewed}
                    onClick={(e) => { e.stopPropagation(); toggleViewed(file); }}
                    className={`flex-shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center cursor-pointer transition-all ${
                      isViewed
                        ? isSelected
                          ? "bg-white/90 border-white/90"
                          : "bg-green-500 border-green-500"
                        : isSelected
                          ? "border-white/50 hover:border-white/80"
                          : "border-[var(--text-tertiary)] hover:border-[var(--text-secondary)]"
                    }`}
                    title="Mark as viewed"
                  >
                    {isViewed && (
                      <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke={isSelected ? "var(--accent)" : "white"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 6l3 3 5-5" />
                      </svg>
                    )}
                  </span>
                  <FileIcon filename={file} />
                  <span className={`truncate flex-1 ${isViewed && !isSelected ? "line-through opacity-60" : ""}`} dir="rtl">
                    <bdi>{file}</bdi>
                  </span>
                  {commentCount > 0 && (
                    <span className={`text-[10px] flex-shrink-0 ${
                      isSelected ? "text-white/70" : "text-yellow-400"
                    }`}>
                      {commentCount}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Diff viewer with inline comments */}
          <div className="flex-1 w-0 flex flex-col bg-[var(--bg-primary)]">
            <div className="flex-1 overflow-auto">
              {diffLoading ? (
                <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Loading diff...
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
                <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
                  Select a file to review
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
