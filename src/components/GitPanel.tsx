import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GitFileEntry, GitStatusResult, BranchCommit, BranchCommitsResult } from "../types";
import DiffViewer, { NewFileViewer, countMatches } from "./DiffViewer";
import FileIcon from "./FileIcon";
import type { DiffMode } from "./DiffViewer";

interface GitPanelProps {
  directory: string;
  isActive?: boolean;
  onEditFile?: (filePath: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  M: "text-yellow-400",
  A: "text-green-400",
  D: "text-red-400",
  R: "text-blue-400",
  C: "text-blue-400",
  "??": "text-gray-400",
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] || "text-gray-400";
}

// --- Main GitPanel ---

export default function GitPanel({ directory, isActive, onEditFile }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitFileEntry | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>(
    () => (localStorage.getItem("git-diff-mode") as DiffMode) || "unified"
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const diffContainerRef = useRef<HTMLDivElement>(null);

  // Branch Comparison state
  const [compareMode, setCompareMode] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState("");
  const [compareBranch, setCompareBranch] = useState("");

  // Detect if current branch is a feature branch (not master/main)
  const isFeatureBranch = status?.branch ? !["master", "main"].includes(status.branch) : false;
  const [selectedBranchFile, setSelectedBranchFile] = useState<string | null>(null);
  const [branchDiff, setBranchDiff] = useState("");
  const [branchCommits, setBranchCommits] = useState<BranchCommit[]>([]);
  const [collapsedCommits, setCollapsedCommits] = useState<Set<string>>(new Set());

  // Cmd+E opens selected file in editor
  useEffect(() => {
    if (!isActive || !onEditFile || !selectedFile) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "e") {
        e.preventDefault();
        onEditFile(selectedFile.path);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isActive, onEditFile, selectedFile]);

  // Total match count for current diff
  const totalMatches = useMemo(() => {
    if (!searchQuery || !diff) return 0;
    return countMatches(diff, searchQuery);
  }, [diff, searchQuery]);

  // Cmd+F to open search, Escape to close
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === "Escape" && searchOpen) {
        e.preventDefault();
        setSearchOpen(false);
        setSearchQuery("");
        setCurrentMatch(0);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isActive, searchOpen]);

  // Scroll current match into view
  useEffect(() => {
    if (!searchQuery || totalMatches === 0) return;
    const container = diffContainerRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-search-match="${currentMatch}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [currentMatch, searchQuery, totalMatches]);

  const navigateMatch = useCallback((direction: 1 | -1) => {
    if (totalMatches === 0) return;
    setCurrentMatch((prev) => (prev + direction + totalMatches) % totalMatches);
  }, [totalMatches]);

  // Branch Comparison handlers
  const loadBranches = useCallback(async () => {
    try {
      const result = await invoke<string[]>("list_branches", { directory });
      setBranches(result);
      // Pre-select base = main/master, compare = current branch
      const main = result.find((b) => b === "main" || b === "master") || result[0] || "";
      setBaseBranch(main);
      setCompareBranch(status?.branch || result[1] || "");
    } catch (e) {
      console.error("Failed to load branches:", e);
    }
  }, [directory, status?.branch]);

  // Fetch commits when entering compare mode
  const loadBranchCommits = useCallback(async () => {
    if (!baseBranch || !compareBranch) return;
    try {
      const result = await invoke<BranchCommitsResult>("get_branch_commits", { directory, base: baseBranch, compare: compareBranch });
      setBranchCommits(result.commits);
      const myFirst = result.commits.find((c) => c.is_mine);
      setSelectedBranchFile(myFirst?.files[0]?.path || null);
    } catch (e) {
      console.error("Failed to load branch commits:", e);
      setBranchCommits([]);
    }
  }, [directory, baseBranch, compareBranch]);

  useEffect(() => {
    if (compareMode && baseBranch && compareBranch) {
      loadBranchCommits();
    }
  }, [compareMode, baseBranch, compareBranch, loadBranchCommits]);


  useEffect(() => {
    if (!compareMode || !selectedBranchFile || !baseBranch || !compareBranch) {
      if (compareMode) setBranchDiff("");
      return;
    }
    invoke<string>("get_branch_file_diff", { directory, base: baseBranch, compare: compareBranch, filePath: selectedBranchFile })
      .then(setBranchDiff)
      .catch((e) => setBranchDiff(`Error: ${e}`));
  }, [compareMode, selectedBranchFile, baseBranch, compareBranch, directory]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<GitStatusResult>("get_git_status", { directory });
      setStatus(result);
      if (result.isGitRepo && result.files.length > 0) {
        setSelectedFile((prev) => {
          if (prev && result.files.some((f) => f.path === prev.path && f.staged === prev.staged)) {
            return prev;
          }
          return result.files[0];
        });
      } else {
        setSelectedFile(null);
        setDiff("");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [directory]);

  // Only fetch when the panel is active (lazy load)
  useEffect(() => {
    if (isActive) {
      refresh();
    }
  }, [isActive, refresh]);

  useEffect(() => {
    if (!selectedFile || !status?.isGitRepo) {
      setDiff("");
      return;
    }
    if (selectedFile.status === "??") {
      invoke<string>("read_file_content", {
        directory,
        filePath: selectedFile.path,
      })
        .then(setDiff)
        .catch((e) => setDiff(`Error reading file: ${e}`));
      return;
    }
    invoke<string>("get_git_diff", {
      directory,
      filePath: selectedFile.path,
      staged: selectedFile.staged,
    })
      .then(setDiff)
      .catch((e) => setDiff(`Error loading diff: ${e}`));
  }, [selectedFile, directory, status?.isGitRepo]);

  // Reset match index when file changes
  useEffect(() => {
    setCurrentMatch(0);
  }, [selectedFile]);

  if (loading && !status) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--text-tertiary)]">
        <svg className="animate-spin h-5 w-5 opacity-50" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-xs">Loading git status</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-red-400">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" className="opacity-50">
          <path fillRule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 11-2 0 1 1 0 012 0zM8 6.5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 6.5z" />
        </svg>
        <span className="text-xs">{error}</span>
      </div>
    );
  }

  if (!status?.isGitRepo) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--text-tertiary)]">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" className="opacity-40">
          <path fillRule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9z" />
        </svg>
        <span className="text-xs">Not a git repository</span>
      </div>
    );
  }

  const staged = status.files.filter((f) => f.staged);
  const modified = status.files.filter((f) => !f.staged && f.status !== "??");
  const untracked = status.files.filter((f) => f.status === "??");

  const renderGroup = (label: string, files: GitFileEntry[]) => {
    if (files.length === 0) return null;
    return (
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] px-2 py-1 font-semibold">
          {label} ({files.length})
        </div>
        {files.map((file) => {
          const isSelected =
            selectedFile?.path === file.path && selectedFile?.staged === file.staged;
          return (
            <button
              key={`${file.staged ? "s" : "u"}-${file.path}`}
              onClick={() => setSelectedFile(file)}
              className={`group w-full text-left px-2 py-1 text-xs font-mono truncate flex items-center gap-2 rounded transition-colors ${
                isSelected
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
              }`}
              title={file.path}
            >
              <span
                className={`w-5 text-center font-bold flex-shrink-0 ${
                  isSelected ? "text-white" : statusColor(file.status)
                }`}
              >
                {file.status}
              </span>
              <FileIcon filename={file.path} />
              <span className="truncate flex-1" dir="rtl">
                <bdi>{file.path}</bdi>
              </span>
              {onEditFile && (
                <span
                  onClick={(e) => { e.stopPropagation(); onEditFile(file.path); }}
                  className={`flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] px-1 rounded hover:bg-black/20 cursor-pointer ${
                    isSelected ? "text-white/70 hover:text-white" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                  }`}
                  title="Edit file"
                >
                  Edit
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0 text-[var(--text-tertiary)]">
            <path fillRule="evenodd" d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" />
          </svg>
          <span className="text-xs font-mono text-[var(--text-primary)] font-medium truncate">
            {status.branch}
          </span>
          {status.files.length > 0 && (
            <span className="text-[10px] text-[var(--text-tertiary)] tabular-nums flex-shrink-0">
              {status.files.length} changed
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={() => {
              const next = !compareMode;
              setCompareMode(next);
              if (next) loadBranches();
            }}
            className={`text-[10px] transition-colors px-1.5 py-0.5 rounded ${
              compareMode
                ? "text-[var(--accent)] bg-[var(--accent)]/10 font-medium"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            }`}
            title={isFeatureBranch ? "Compare with master/main" : "Compare branches"}
          >
            {isFeatureBranch ? "vs main" : "Compare"}
          </button>
          {!compareMode && (
            <button
              onClick={() => {
                const next = diffMode === "unified" ? "split" : "unified";
                setDiffMode(next);
                localStorage.setItem("git-diff-mode", next);
              }}
              className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-1.5 py-0.5 rounded hover:bg-[var(--bg-tertiary)]"
              title="Toggle diff view"
            >
              {diffMode === "unified" ? "Split" : "Unified"}
            </button>
          )}
          <button
            onClick={refresh}
            className={`text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-1.5 py-0.5 rounded hover:bg-[var(--bg-tertiary)] ${loading ? "animate-spin-slow" : ""}`}
            title="Refresh"
          >
            {loading ? (
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path fillRule="evenodd" d="M8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.001 7.001 0 0114.95 7.16a.75.75 0 11-1.49.178A5.501 5.501 0 008 2.5zM1.705 8.005a.75.75 0 01.834.656 5.501 5.501 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.001 7.001 0 011.05 8.84a.75.75 0 01.656-.834z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {compareMode ? (
        /* Branch Comparison Mode */
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] flex-shrink-0">
            <select
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              className="bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-0.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] font-mono max-w-[160px]"
            >
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-[var(--text-tertiary)] flex-shrink-0">
              <path fillRule="evenodd" d="M8.22 2.97a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06l2.97-2.97H3.75a.75.75 0 010-1.5h7.44L8.22 4.03a.75.75 0 010-1.06z" />
            </svg>
            <select
              value={compareBranch}
              onChange={(e) => setCompareBranch(e.target.value)}
              className="bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-0.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] font-mono max-w-[160px]"
            >
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <span className="text-[10px] text-[var(--text-tertiary)] tabular-nums flex-shrink-0">
              {branchCommits.length} commit{branchCommits.length !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="flex flex-1 min-h-0">
            <div className="w-64 flex-shrink-0 border-r border-[var(--border-color)] overflow-y-auto py-2">
              {branchCommits.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 gap-2 text-[var(--text-tertiary)]">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="opacity-40">
                    <path fillRule="evenodd" d="M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 010-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 010 1.5h-3.32z" />
                  </svg>
                  <span className="text-[10px]">
                    {baseBranch && compareBranch ? "No commits between branches" : "Select branches to compare"}
                  </span>
                </div>
              ) : (
                branchCommits.map((commit) => {
                  const isCollapsed = collapsedCommits.has(commit.hash);
                  return (
                    <div key={commit.hash} className="mb-1">
                      <button
                        onClick={() => setCollapsedCommits((prev) => {
                          const next = new Set(prev);
                          if (next.has(commit.hash)) next.delete(commit.hash);
                          else next.add(commit.hash);
                          return next;
                        })}
                        className="w-full text-left px-2 py-1.5 text-[11px] flex items-center gap-1.5 hover:bg-[var(--bg-tertiary)] rounded transition-colors"
                        title={`${commit.short_hash} - ${commit.author_name}`}
                      >
                        <span className={`text-[9px] flex-shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`}>▶</span>
                        <span className="truncate text-[var(--text-primary)]">{commit.subject}</span>
                        <span className="ml-auto text-[9px] text-[var(--text-tertiary)] flex-shrink-0">{commit.files.length}</span>
                      </button>
                      {!isCollapsed && commit.files.map((file) => (
                        <button
                          key={file.path}
                          onClick={() => setSelectedBranchFile(file.path)}
                          className={`w-full text-left pl-7 pr-2 py-0.5 text-xs font-mono truncate flex items-center gap-2 rounded transition-colors ${
                            selectedBranchFile === file.path
                              ? "bg-[var(--accent)] text-white"
                              : "text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                          }`}
                          title={file.path}
                        >
                          <span className={`w-4 text-center font-bold flex-shrink-0 text-[10px] ${
                            selectedBranchFile === file.path ? "text-white" : statusColor(file.status)
                          }`}>
                            {file.status}
                          </span>
                          <FileIcon filename={file.path} />
                          <span className="truncate flex-1" dir="rtl">
                            <bdi>{file.path}</bdi>
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
            <div className="flex-1 w-0 flex flex-col bg-[var(--bg-primary)]">
              <div ref={diffContainerRef} className="flex-1 overflow-auto">
                {selectedBranchFile ? (
                  <DiffViewer diff={branchDiff} mode={diffMode} filePath={selectedBranchFile} searchQuery="" currentMatch={0} />
                ) : (
                  <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
                    Select a file to view changes
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : status.files.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-[var(--text-tertiary)]">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" className="opacity-40">
            <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
          </svg>
          <span className="text-xs">Working tree clean</span>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* File list */}
          <div className="w-64 flex-shrink-0 border-r border-[var(--border-color)] overflow-y-auto py-2">
            {renderGroup("Staged", staged)}
            {renderGroup("Modified", modified)}
            {renderGroup("Untracked", untracked)}
          </div>

          {/* Diff viewer */}
          <div className="flex-1 w-0 flex flex-col bg-[var(--bg-primary)]">
            {searchOpen && (
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] flex-shrink-0">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentMatch(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      navigateMatch(e.shiftKey ? -1 : 1);
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setSearchOpen(false);
                      setSearchQuery("");
                      setCurrentMatch(0);
                    }
                  }}
                  placeholder="Search in diff..."
                  className="bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-0.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] w-48"
                  autoFocus
                />
                <span className="text-[10px] text-[var(--text-tertiary)] min-w-[4rem]">
                  {searchQuery ? `${totalMatches > 0 ? currentMatch + 1 : 0}/${totalMatches}` : ""}
                </span>
                <button
                  onClick={() => navigateMatch(-1)}
                  disabled={totalMatches === 0}
                  className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 text-xs px-1"
                  title="Previous match (Shift+Enter)"
                >
                  ↑
                </button>
                <button
                  onClick={() => navigateMatch(1)}
                  disabled={totalMatches === 0}
                  className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 text-xs px-1"
                  title="Next match (Enter)"
                >
                  ↓
                </button>
                <button
                  onClick={() => {
                    setSearchOpen(false);
                    setSearchQuery("");
                    setCurrentMatch(0);
                  }}
                  className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] text-xs px-1 ml-auto"
                  title="Close (Escape)"
                >
                  ✕
                </button>
              </div>
            )}
            <div ref={diffContainerRef} className="flex-1 overflow-auto">
              {selectedFile ? (
                selectedFile.status === "??" ? (
                  <NewFileViewer content={diff} filePath={selectedFile.path} searchQuery={searchQuery} currentMatch={currentMatch} />
                ) : (
                  <DiffViewer diff={diff} mode={diffMode} filePath={selectedFile.path} searchQuery={searchQuery} currentMatch={currentMatch} />
                )
              ) : (
                <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
                  Select a file to view changes
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
