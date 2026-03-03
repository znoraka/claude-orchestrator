import type { Session, Workspace } from "../types";

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

export function deriveWorkspaces(sessions: Session[]): Workspace[] {
  const byDir = new Map<string, Session[]>();

  for (const s of sessions) {
    // Group worktrees under the parent repo directory
    const dir = repoRootDir(s.directory || "~");
    let arr = byDir.get(dir);
    if (!arr) {
      arr = [];
      byDir.set(dir, arr);
    }
    arr.push(s);
  }

  const workspaces: Workspace[] = [];
  for (const [dir, dirSessions] of byDir) {
    const sorted = [...dirSessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    workspaces.push({
      id: dir,
      directory: dir,
      sessions: sorted,
      lastActiveAt: sorted[0].lastActiveAt,
    });
  }

  return workspaces.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function workspaceForSession(
  sessionId: string,
  sessions: Session[]
): string | null {
  const session = sessions.find((s) => s.id === sessionId);
  return session ? repoRootDir(session.directory || "~") : null;
}
