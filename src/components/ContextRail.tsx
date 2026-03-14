import { memo, useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionUsage } from "../types";
import { UnifiedDiff, NewFileViewer } from "./DiffViewer";

interface GitFile {
  path: string;
  status: string;
  staged: boolean;
}

interface GitStatusResult {
  branch: string;
  files: GitFile[];
  isGitRepo: boolean;
}

interface Props {
  directory: string;
  sessionUsage: Map<string, SessionUsage>;
  activeSessionId: string | null;
  defaultTab?: "git" | "cost";
  onTabChange?: (tab: "git" | "cost") => void;
  selectedFile?: { path: string; seq: number; diff?: string };
}

function StatusIcon({ status }: { status: string }) {
  if (status === "M") return <span className="text-[var(--status-waiting)] font-mono text-[10px] w-3">M</span>;
  if (status === "A" || status === "?") return <span className="text-[var(--status-running)] font-mono text-[10px] w-3">A</span>;
  if (status === "D") return <span className="text-[var(--danger)] font-mono text-[10px] w-3">D</span>;
  return <span className="text-[var(--text-tertiary)] font-mono text-[10px] w-3">{status}</span>;
}


const ContextRail = memo(function ContextRail({
  directory,
  sessionUsage,
  activeSessionId,
  defaultTab = "git",
  onTabChange,
  selectedFile,
}: Props) {
  const [activeTab, setActiveTab] = useState<"git" | "cost">(defaultTab);
  const [gitFiles, setGitFiles] = useState<GitFile[]>([]);
  const [gitBranch, setGitBranch] = useState<string>("");
  const [gitLoading, setGitLoading] = useState(false);

  // Map of "path:staged" → diff content (cached after first load)
  const [diffCache, setDiffCache] = useState<Map<string, string>>(new Map());
  // Map of "path:staged" → { added, removed } from git diff --numstat (fast, loaded eagerly)
  const [statCache, setStatCache] = useState<Map<string, { added: number; removed: number }>>(new Map());
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // For files not tracked by git — show raw content
  const [untrackedFile, setUntrackedFile] = useState<{ path: string; content: string } | null>(null);
  // For pre-computed diffs passed in from the chat recap
  const [providedDiffView, setProvidedDiffView] = useState<{ path: string; diff: string } | null>(null);
  // Track the last seq we've processed so we only act on each file-open request once
  const lastHandledSeqRef = useRef(-1);

  useEffect(() => {
    if (activeTab !== "git" || !directory) return;
    let cancelled = false;
    setGitLoading(true);

    const fetch = async () => {
      try {
        const result = await invoke<GitStatusResult>("get_git_status", { directory });
        if (cancelled) return;
        setGitBranch(result.branch);
        setGitFiles(result.files);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setGitLoading(false);
      }
    };

    fetch();
    const interval = setInterval(fetch, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [directory, activeTab]);

  // Eagerly fetch file stats (added/removed counts) via a single git diff --numstat call per staged state
  useEffect(() => {
    if (!directory || gitFiles.length === 0) return;
    let cancelled = false;

    const fetchStats = async () => {
      for (const staged of [false, true]) {
        const hasFiles = gitFiles.some((f) => f.staged === staged && f.status !== "??");
        if (!hasFiles) continue;
        try {
          const stats = await invoke<Record<string, [number, number]>>("get_git_numstat", { directory, staged });
          if (cancelled) return;
          setStatCache((prev) => {
            const next = new Map(prev);
            for (const [path, [added, removed]] of Object.entries(stats)) {
              next.set(`${path}:${staged}`, { added, removed });
            }
            return next;
          });
        } catch { /* ignore */ }
      }
    };

    fetchStats();
    return () => { cancelled = true; };
  }, [directory, gitFiles]);

  const fileKey = (f: GitFile) => `${f.path}:${f.staged}`;

  const handleFileClick = async (file: GitFile) => {
    const key = fileKey(file);

    // Untracked file — show raw content instead of diff
    if (file.status === "??") {
      if (untrackedFile?.path === file.path) {
        setUntrackedFile(null);
        return;
      }
      const absPath = (directory ? (directory.endsWith("/") ? directory : directory + "/") : "") + file.path;
      invoke<string>("read_file", { filePath: absPath })
        .then((content) => setUntrackedFile({ path: file.path, content }))
        .catch(() => setUntrackedFile({ path: file.path, content: "" }));
      return;
    }

    // Toggle collapse
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }

    setExpandedKey(key);

    // Load diff if not cached
    if (!diffCache.has(key)) {
      setLoadingKey(key);
      try {
        const diff = await invoke<string>("get_git_diff", {
          directory,
          filePath: file.path,
          staged: file.staged,
        });
        setDiffCache((prev) => new Map(prev).set(key, diff));
      } catch {
        setDiffCache((prev) => new Map(prev).set(key, ""));
      } finally {
        setLoadingKey(null);
      }
    }
  };

  const handleTabChange = (tab: "git" | "cost") => {
    setActiveTab(tab);
    onTabChange?.(tab);
  };

  // Switch to git tab as soon as a file is requested
  useEffect(() => {
    if (!selectedFile) return;
    setActiveTab("git");
    onTabChange?.("git");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile]);

  // Once gitFiles are loaded, expand the selected file — but only process each request once
  useEffect(() => {
    if (!selectedFile) return;
    if (selectedFile.seq <= lastHandledSeqRef.current) return;
    const filePath = selectedFile.path;
    const providedDiff = selectedFile.diff;

    // If a pre-computed diff was provided (from the chat recap), use it directly.
    if (providedDiff !== undefined) {
      lastHandledSeqRef.current = selectedFile.seq;
      setProvidedDiffView({ path: filePath, diff: providedDiff });
      return;
    }

    if (gitLoading) return;
    lastHandledSeqRef.current = selectedFile.seq;
    const match = gitFiles.find((f) => f.path === filePath || filePath.endsWith(f.path));
    if (match) {
      const key = fileKey(match);
      setExpandedKey(key);
      if (!diffCache.has(key)) {
        setLoadingKey(key);
        invoke<string>("get_git_diff", { directory, filePath: match.path, staged: match.staged })
          .then((diff) => setDiffCache((prev) => new Map(prev).set(key, diff)))
          .catch(() => setDiffCache((prev) => new Map(prev).set(key, "")))
          .finally(() => setLoadingKey(null));
      }
    } else {
      // File is not git-tracked — read its content directly
      const absPath = directory
        ? (directory.endsWith("/") ? directory : directory + "/") + filePath
        : filePath;
      invoke<string>("read_file", { filePath: absPath })
        .then((content) => setUntrackedFile({ path: filePath, content }))
        .catch(() => setUntrackedFile({ path: filePath, content: "" }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile, gitFiles, gitLoading]);

  const totalCost = [...sessionUsage.values()].reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
  const activeUsage = activeSessionId ? sessionUsage.get(activeSessionId) : undefined;

  return (
    <div
      className="flex flex-col h-full border-l border-[var(--border-subtle)]"
      style={{ background: "var(--rail-bg)", width: "100%" }}
    >
      {/* Tab bar */}
      <div className="flex items-center border-b border-[var(--border-subtle)] px-3 pt-2 gap-1 shrink-0">
        <button
          onClick={() => handleTabChange("git")}
          className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
            activeTab === "git"
              ? "text-[var(--text-primary)] border-b-2 border-[var(--accent)] -mb-px"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          }`}
        >
          Git
        </button>
        <button
          onClick={() => handleTabChange("cost")}
          className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
            activeTab === "cost"
              ? "text-[var(--text-primary)] border-b-2 border-[var(--accent)] -mb-px"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          }`}
        >
          Cost
        </button>
      </div>

      {/* Content */}
      <div className={`flex-1 min-h-0 ${(expandedKey !== null || untrackedFile !== null || providedDiffView !== null) && activeTab === "git" ? "flex flex-col" : "overflow-y-auto"}`}>
        {activeTab === "git" && (
          <div className={`flex flex-col ${expandedKey !== null || untrackedFile !== null || providedDiffView !== null ? "flex-1 min-h-0" : ""}`}>
            {/* Branch */}
            {gitBranch && expandedKey === null && untrackedFile === null && providedDiffView === null && (
              <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] px-3 py-2 border-b border-[var(--border-subtle)]">
                <svg className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                </svg>
                <span className="font-mono truncate">{gitBranch}</span>
              </div>
            )}

            {gitLoading && gitFiles.length === 0 && expandedKey === null && untrackedFile === null && providedDiffView === null && (
              <div className="text-xs text-[var(--text-tertiary)] py-4 text-center">Loading…</div>
            )}

            {!gitLoading && gitFiles.length === 0 && expandedKey === null && untrackedFile === null && providedDiffView === null && (
              <div className="text-xs text-[var(--text-tertiary)] py-4 text-center">No changes</div>
            )}

            {/* Pre-computed diff from chat recap */}
            {providedDiffView !== null && (
              <div className="flex flex-col h-full">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)] shrink-0">
                  <button
                    onClick={() => setProvidedDiffView(null)}
                    className="flex items-center gap-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M10 4l-4 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Back
                  </button>
                  <span className="text-xs font-mono text-[var(--text-primary)] truncate flex-1 min-w-0 ml-1">{providedDiffView.path}</span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto bg-[var(--bg-primary)]">
                  {providedDiffView.diff ? (
                    <UnifiedDiff diff={providedDiffView.diff} filePath={providedDiffView.path} searchQuery="" currentMatch={-1} />
                  ) : (
                    <div className="text-xs text-[var(--text-tertiary)] py-4 text-center">No changes</div>
                  )}
                </div>
              </div>
            )}

            {/* Untracked file content view */}
            {untrackedFile !== null && (() => {
              return (
                <div className="flex flex-col h-full">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)] shrink-0">
                    <button
                      onClick={() => setUntrackedFile(null)}
                      className="flex items-center gap-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M10 4l-4 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Back
                    </button>
                    <span className="text-xs font-mono text-[var(--text-primary)] truncate flex-1 min-w-0 ml-1">{untrackedFile.path}</span>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto bg-[var(--bg-primary)]">
                    {untrackedFile.content ? (
                      <NewFileViewer
                        content={untrackedFile.content}
                        filePath={untrackedFile.path}
                        searchQuery=""
                        currentMatch={0}
                      />
                    ) : (
                      <div className="text-xs text-[var(--text-tertiary)] py-4 text-center">Empty file</div>
                    )}
                  </div>
                </div>
              );
            })()}

            {gitFiles.length > 0 && expandedKey !== null && untrackedFile === null && providedDiffView === null && (() => {
              const expandedFile = gitFiles.find((f) => fileKey(f) === expandedKey);
              if (!expandedFile) return null;
              const diff = diffCache.get(expandedKey) ?? "";
              const isLoading = loadingKey === expandedKey;
              const counts = statCache.get(expandedKey) ?? null;

              return (
                <div className="flex flex-col h-full">
                  {/* Detail header */}
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)] shrink-0">
                    <button
                      onClick={() => setExpandedKey(null)}
                      className="flex items-center gap-1 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M10 4l-4 4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Back
                    </button>
                    <div className="flex items-center gap-1.5 flex-1 min-w-0 ml-1">
                      <StatusIcon status={expandedFile.status} />
                      <span className="text-xs font-mono text-[var(--text-primary)] truncate">{expandedFile.path}</span>
                    </div>
                    {counts && (
                      <span className="text-[10px] font-mono shrink-0">
                        <span className="text-green-400">+{counts.added}</span>
                        <span className="text-red-400 ml-0.5">-{counts.removed}</span>
                      </span>
                    )}
                  </div>
                  {/* Full-height diff */}
                  <div className="flex-1 min-h-0 overflow-y-auto bg-[var(--bg-primary)]">
                    {isLoading ? (
                      <div className="text-xs text-[var(--text-tertiary)] py-4 text-center">Loading…</div>
                    ) : diff ? (
                      <UnifiedDiff
                        diff={diff}
                        filePath={expandedFile.path}
                        searchQuery=""
                        currentMatch={-1}
                      />
                    ) : (
                      <div className="text-xs text-[var(--text-tertiary)] py-4 text-center">No diff available</div>
                    )}
                  </div>
                </div>
              );
            })()}

            {gitFiles.length > 0 && expandedKey === null && untrackedFile === null && providedDiffView === null && (
              <>
                <div className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-wider px-3 pt-2.5 pb-1">
                  {gitFiles.length} file{gitFiles.length !== 1 ? "s" : ""} changed
                </div>
                {gitFiles.map((f) => {
                  const key = fileKey(f);
                  const counts = statCache.get(key) ?? null;

                  return (
                    <button
                      key={key}
                      onClick={() => handleFileClick(f)}
                      className="w-full flex items-center gap-2 py-1.5 px-3 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      <svg
                        className="w-3 h-3 shrink-0 text-[var(--text-tertiary)]"
                        viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
                      >
                        <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <StatusIcon status={f.status} />
                      <span className="text-xs font-mono truncate flex-1 min-w-0 text-[var(--text-secondary)]">
                        {f.path}
                      </span>
                      {counts && (
                        <span className="text-[10px] font-mono shrink-0 ml-1">
                          <span className="text-green-400">+{counts.added}</span>
                          <span className="text-red-400 ml-0.5">-{counts.removed}</span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}

        {activeTab === "cost" && (
          <div className="flex flex-col gap-4 p-3">
            {activeUsage && (
              <div className="rounded-lg border border-[var(--card-border)] p-3" style={{ background: "var(--card-bg)" }}>
                <div className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2">Current Session</div>
                <div className="text-2xl font-bold text-[var(--text-primary)]">
                  ${activeUsage.costUsd.toFixed(2)}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-[var(--text-tertiary)]">
                  <div>In: {(activeUsage.inputTokens / 1000).toFixed(1)}k</div>
                  <div>Out: {(activeUsage.outputTokens / 1000).toFixed(1)}k</div>
                  <div>Cache: {(activeUsage.cacheReadInputTokens / 1000).toFixed(1)}k</div>
                  <div>Context: {Math.round(activeUsage.contextTokens / 1000)}k</div>
                </div>
              </div>
            )}
            <div className="rounded-lg border border-[var(--card-border)] p-3" style={{ background: "var(--card-bg)" }}>
              <div className="text-[10px] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2">Total Today</div>
              <div className="text-2xl font-bold text-[var(--text-primary)]">
                ${totalCost.toFixed(2)}
              </div>
              <div className="text-[10px] text-[var(--text-tertiary)] mt-1">
                across {sessionUsage.size} session{sessionUsage.size !== 1 ? "s" : ""}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default ContextRail;
