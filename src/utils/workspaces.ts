import type { Session, Workspace } from "../types";

export function deriveWorkspaces(sessions: Session[]): Workspace[] {
  const byDir = new Map<string, Session[]>();

  for (const s of sessions) {
    const dir = s.directory || "~";
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
  return session ? (session.directory || "~") : null;
}
