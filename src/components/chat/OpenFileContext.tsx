import { createContext, useContext } from "react";

/**
 * Provides a callback to open a file path in the user's configured editor.
 * Set by AgentChat with the session directory, consumed by MarkdownContent.
 */
export const OpenFileContext = createContext<((path: string) => void) | null>(null);

export function useOpenFile() {
  return useContext(OpenFileContext);
}
