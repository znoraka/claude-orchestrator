import type { Session, Worktree, Workspace } from "../types";

/** Strip trailing slashes so the same directory always hashes to the same color. */
export function normalizeDir(dir: string): string {
  if (dir.length > 1 && dir.endsWith("/")) {
    return dir.replace(/\/+$/, "");
  }
  return dir;
}

/** Strip worktree suffixes so worktrees group under the parent repo. */
export function repoRootDir(dir: string): string {
  // Handle .worktrees/<name> (manual convention)
  const wtIdx = dir.indexOf("/.worktrees/");
  if (wtIdx !== -1) return dir.slice(0, wtIdx);
  // Handle .claude/worktrees/<name> (built-in EnterWorktree)
  const clIdx = dir.indexOf("/.claude/worktrees/");
  if (clIdx !== -1) return dir.slice(0, clIdx);
  return dir;
}

/** Extract worktree name from path, or "main" for the repo root. */
export function worktreeName(path: string): string {
  const wtIdx = path.indexOf("/.worktrees/");
  if (wtIdx !== -1) return path.slice(wtIdx + "/.worktrees/".length);
  const clIdx = path.indexOf("/.claude/worktrees/");
  if (clIdx !== -1) return path.slice(clIdx + "/.claude/worktrees/".length);
  return "main";
}

export function deriveWorkspaces(sessions: Session[], nonExistentDirs?: Set<string>): Workspace[] {
  // Group sessions by repo root, then flatten all sessions into a single worktree
  const byRepo = new Map<string, Session[]>();

  for (const s of sessions) {
    const dir = s.directory || "~";
    if (nonExistentDirs?.has(dir)) continue;
    const repo = repoRootDir(dir);
    let arr = byRepo.get(repo);
    if (!arr) {
      arr = [];
      byRepo.set(repo, arr);
    }
    arr.push(s);
  }

  const workspaces: Workspace[] = [];
  for (const [repo, repoSessions] of byRepo) {
    const sorted = [...repoSessions].sort((a, b) =>
      (b.lastActiveAt - a.lastActiveAt) || (b.createdAt - a.createdAt)
    );

    // Single flat worktree containing all sessions under this repo root
    const worktree: Worktree = {
      path: repo,
      branch: "",
      isMain: true,
      sessions: sorted,
      lastActiveAt: sorted[0].lastActiveAt,
    };

    workspaces.push({
      id: repo,
      directory: repo,
      worktrees: [worktree],
      lastActiveAt: worktree.lastActiveAt,
    });
  }

  // Sort workspaces alphabetically by directory name
  return workspaces.sort((a, b) => {
    const nameA = (a.directory.split("/").filter(Boolean).pop() || a.directory).toLowerCase();
    const nameB = (b.directory.split("/").filter(Boolean).pop() || b.directory).toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

export function workspaceForSession(
  sessionId: string,
  sessions: Session[]
): string | null {
  const session = sessions.find((s) => s.id === sessionId);
  return session ? repoRootDir(session.directory || "~") : null;
}
