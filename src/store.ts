import { Fragment, type ReactNode, createElement, useEffect } from "react";
import { create } from "zustand";
import { Debouncer } from "@tanstack/react-pacer";

// ── Persisted UI state ──────────────────────────────────────────────────

const PERSISTED_STATE_KEY = "claude-orchestrator:renderer-state:v1";
const LEGACY_KEYS = ["t3code:renderer-state:v8"] as const;

interface PersistedState {
  collapsedWorkspaceIds: string[];
  workspaceOrder: string[];
}

function readPersistedState(): PersistedState {
  if (typeof window === "undefined") return { collapsedWorkspaceIds: [], workspaceOrder: [] };
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return { collapsedWorkspaceIds: [], workspaceOrder: [] };
    return JSON.parse(raw) as PersistedState;
  } catch {
    return { collapsedWorkspaceIds: [], workspaceOrder: [] };
  }
}

function persistState(state: AppStore): void {
  if (typeof window === "undefined") return;
  try {
    const data: PersistedState = {
      collapsedWorkspaceIds: [...state.collapsedWorkspaceIds],
      workspaceOrder: [...state.workspaceOrder],
    };
    window.localStorage.setItem(PERSISTED_STATE_KEY, JSON.stringify(data));
    // Clean up legacy keys on first persist
    for (const key of LEGACY_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore quota/storage errors
  }
}

// ── Store interface ─────────────────────────────────────────────────────

interface AppStore {
  // Persisted UI state
  collapsedWorkspaceIds: Set<string>;
  workspaceOrder: string[];

  // Transient UI state
  isSidebarOpen: boolean;

  // Actions
  toggleWorkspace: (id: string) => void;
  setWorkspaceCollapsed: (id: string, collapsed: boolean) => void;
  reorderWorkspaces: (orderedIds: string[]) => void;
  setSidebarOpen: (open: boolean) => void;
}

// ── Zustand store ───────────────────────────────────────────────────────

const persisted = readPersistedState();

const debouncedPersist = new Debouncer(persistState, { wait: 500 });

export const useStore = create<AppStore>((set) => ({
  collapsedWorkspaceIds: new Set(persisted.collapsedWorkspaceIds),
  workspaceOrder: persisted.workspaceOrder,
  isSidebarOpen: true,

  toggleWorkspace: (id) =>
    set((state) => {
      const next = new Set(state.collapsedWorkspaceIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { collapsedWorkspaceIds: next };
    }),

  setWorkspaceCollapsed: (id, collapsed) =>
    set((state) => {
      const next = new Set(state.collapsedWorkspaceIds);
      if (collapsed) next.add(id);
      else next.delete(id);
      return { collapsedWorkspaceIds: next };
    }),

  reorderWorkspaces: (orderedIds) => set({ workspaceOrder: orderedIds }),

  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
}));

// Persist state changes with debouncing
useStore.subscribe((state) => {
  // Convert Set to array for serialization check
  debouncedPersist.maybeExecute(state);
});

// Flush pending writes before page unload
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    debouncedPersist.flush();
  });
}

export function StoreProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    persistState(useStore.getState());
  }, []);
  return createElement(Fragment, null, children);
}
