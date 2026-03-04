import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Workspace } from "../types";

export interface GitWorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
}

/** Fetch branch info for worktrees from the backend, keyed by worktree path.
 *  Also returns all git worktrees grouped by repo directory.
 *  Polls every 10s. */
export function useWorktreeBranches(workspaces: Workspace[]): {
  branches: Map<string, string>;
  byRepo: Map<string, GitWorktreeInfo[]>;
} {
  const [branches, setBranches] = useState<Map<string, string>>(new Map());
  const [byRepo, setByRepo] = useState<Map<string, GitWorktreeInfo[]>>(new Map());

  useEffect(() => {
    const repos = new Set(workspaces.map((w) => w.directory));
    let cancelled = false;

    const fetchBranches = async () => {
      const newBranches = new Map<string, string>();
      const newByRepo = new Map<string, GitWorktreeInfo[]>();
      for (const repo of repos) {
        try {
          const wts = await invoke<Array<{ path: string; branch: string; isMain: boolean }>>(
            "list_worktrees",
            { directory: repo }
          );
          newByRepo.set(repo, wts);
          for (const wt of wts) {
            newBranches.set(wt.path, wt.branch);
          }
        } catch {
          // ignore
        }
      }
      if (!cancelled) {
        setBranches(newBranches);
        setByRepo(newByRepo);
      }
    };

    fetchBranches();
    const interval = setInterval(fetchBranches, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspaces]);

  return { branches, byRepo };
}
