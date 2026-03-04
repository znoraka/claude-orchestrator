import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Workspace } from "../types";

/** Fetch branch info for worktrees from the backend, keyed by worktree path.
 *  Polls every 10s. */
export function useWorktreeBranches(workspaces: Workspace[]): Map<string, string> {
  const [branches, setBranches] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const repos = new Set(workspaces.map((w) => w.directory));
    let cancelled = false;

    const fetchBranches = async () => {
      const newBranches = new Map<string, string>();
      for (const repo of repos) {
        try {
          const wts = await invoke<Array<{ path: string; branch: string; isMain: boolean }>>(
            "list_worktrees",
            { directory: repo }
          );
          for (const wt of wts) {
            newBranches.set(wt.path, wt.branch);
          }
        } catch {
          // ignore
        }
      }
      if (!cancelled) setBranches(newBranches);
    };

    fetchBranches();
    const interval = setInterval(fetchBranches, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspaces]);

  return branches;
}
