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
  // Step 1: Group sessions by repo root
  const byRepo = new Map<string, Map<string, Session[]>>();

  for (const s of sessions) {
    const dir = s.directory || "~";
    const repo = repoRootDir(dir);
    let repoMap = byRepo.get(repo);
    if (!repoMap) {
      repoMap = new Map();
      byRepo.set(repo, repoMap);
    }
    let arr = repoMap.get(dir);
    if (!arr) {
      arr = [];
      repoMap.set(dir, arr);
    }
    arr.push(s);
  }

  // Step 2: Build workspaces with worktrees
  const workspaces: Workspace[] = [];
  for (const [repo, worktreeMap] of byRepo) {
    const worktrees: Worktree[] = [];
    for (const [dir, dirSessions] of worktreeMap) {
      const sorted = [...dirSessions].sort((a, b) =>
        (b.lastActiveAt - a.lastActiveAt) || (b.createdAt - a.createdAt)
      );
      const isMain = dir === repo;
      worktrees.push({
        path: dir,
        branch: "", // filled in later by the sidebar via list_worktrees
        isMain,
        sessions: sorted,
        lastActiveAt: sorted[0].lastActiveAt,
      });
    }
    // Filter out worktrees whose directory no longer exists
    const visibleWorktrees = nonExistentDirs
      ? worktrees.filter((w) => !nonExistentDirs.has(w.path))
      : worktrees;

    if (visibleWorktrees.length === 0) continue;

    // Sort: main first, then by lastActiveAt desc
    visibleWorktrees.sort((a, b) => {
      if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
      return b.lastActiveAt - a.lastActiveAt;
    });

    workspaces.push({
      id: repo,
      directory: repo,
      worktrees: visibleWorktrees,
      lastActiveAt: Math.max(...visibleWorktrees.map((w) => w.lastActiveAt)),
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
