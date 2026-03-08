import type { Session } from "../types";

/**
 * Walk from a session down to the youngest (most recently active) descendant.
 * Returns the leaf session, or the session itself if it has no children.
 */
export function getYoungestDescendant(sessionId: string, sessions: Session[]): Session {
  // Build parentId → children map
  const childrenOf = new Map<string, Session[]>();
  for (const s of sessions) {
    if (s.parentSessionId) {
      const arr = childrenOf.get(s.parentSessionId) || [];
      arr.push(s);
      childrenOf.set(s.parentSessionId, arr);
    }
  }

  let current = sessions.find((s) => s.id === sessionId);
  if (!current) return sessions.find((s) => s.id === sessionId) ?? ({ id: sessionId } as Session);

  while (true) {
    const children = childrenOf.get(current.id);
    if (!children || children.length === 0) return current;
    // Pick the child with the highest lastActiveAt
    current = children.reduce((a, b) => (b.lastActiveAt > a.lastActiveAt ? b : a));
  }
}

/**
 * Walk from a session up to its root ancestor (the session with no parent).
 */
export function getRootSession(sessionId: string, sessions: Session[]): Session {
  const byId = new Map<string, Session>();
  for (const s of sessions) byId.set(s.id, s);

  let current = byId.get(sessionId);
  if (!current) return { id: sessionId } as Session;

  while (current.parentSessionId) {
    const parent = byId.get(current.parentSessionId);
    if (!parent) break;
    current = parent;
  }

  return current;
}
