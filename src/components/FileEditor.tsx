import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { Vim, vim } from "@replit/codemirror-vim";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";

interface Props {
  baseDirectory?: string;
  initialFilePath?: string;
  onClose: () => void;
}

const LANG_MAP: Record<string, () => Promise<any>> = {
  ts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: false })),
  tsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })),
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  rs: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  yml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
};

// Parse and apply supported vimrc mappings
let vimrcLoaded = false;

function applyVimrc(content: string) {
  const MODE_MAP: Record<string, string | undefined> = {
    noremap: undefined,  // normal + visual
    map: undefined,
    nnoremap: "normal",
    nmap: "normal",
    vnoremap: "visual",
    vmap: "visual",
    inoremap: "insert",
    imap: "insert",
    onoremap: "normal",  // operator-pending → best effort as normal
    omap: "normal",
  };

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith('"')) continue;

    const match = line.match(
      /^(noremap|nnoremap|vnoremap|inoremap|onoremap|map|nmap|vmap|imap|omap)\s+(\S+)\s+(.+)$/
    );
    if (!match) continue;

    const [, cmd, lhs, rhs] = match;

    // Skip VSCode/IDE-specific, :exe commands, and <CR>-terminated ex commands
    if (
      rhs.includes("workbench.") ||
      rhs.includes("editor.") ||
      rhs.includes("notebook.") ||
      rhs.includes("prettier.") ||
      rhs.includes("eslint.") ||
      rhs.includes(":exe ")
    ) continue;

    const mode = MODE_MAP[cmd] as any;
    const isNoremap = cmd.includes("noremap");

    try {
      if (isNoremap) {
        Vim.noremap(lhs, rhs, mode);
      } else {
        Vim.map(lhs, rhs, mode);
      }
    } catch {
      // Unsupported mapping — skip silently
    }
  }
}

async function loadVimrc() {
  if (vimrcLoaded) return;
  vimrcLoaded = true;
  try {
    const content = await invoke<string>("read_file", { filePath: "~/.vimrc" });
    applyVimrc(content);
  } catch {
    // No vimrc or unreadable — that's fine
  }
}

const darkTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    height: "100%",
    fontSize: "13px",
  },
  ".cm-content": { caretColor: "var(--accent)", fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "rgba(255,255,255,0.1)" },
  ".cm-gutters": { backgroundColor: "var(--bg-secondary)", color: "var(--text-tertiary)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-tertiary)" },
  ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
  ".cm-panels": { backgroundColor: "var(--bg-secondary)", color: "var(--text-primary)" },
  ".cm-panels input": { backgroundColor: "var(--bg-primary)", color: "var(--text-primary)", border: "1px solid var(--border-color)" },
  ".cm-vim-panel": { backgroundColor: "var(--bg-secondary)", color: "var(--text-primary)", padding: "2px 8px", fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)", fontSize: "12px" },
  ".cm-fat-cursor": { backgroundColor: "rgba(255,255,255,0.3) !important" },
  "& .cm-vim-panel input": { fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)", fontSize: "12px" },
}, { dark: true });

const EDITOR_MODE_KEY = "claude-orchestrator-editor-vim";

export default function FileEditor({ baseDirectory, initialFilePath, onClose }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  const [filePath, setFilePath] = useState(() => initialFilePath || (baseDirectory || "~") + "/");
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [modified, setModified] = useState(false);
  const [useVim, setUseVim] = useState(() => localStorage.getItem(EDITOR_MODE_KEY) !== "false");
  const [vimMode, setVimMode] = useState("NORMAL");
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ path: string; isDir: boolean }[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [pathFocused, setPathFocused] = useState(!initialFilePath);

  const originalContent = useRef("");

  // Save file
  const saveFile = useCallback(async () => {
    if (!loadedPath || !viewRef.current) return;
    const content = viewRef.current.state.doc.toString();
    try {
      await invoke("write_file", { filePath: loadedPath, content });
      originalContent.current = content;
      setModified(false);
      setError(null);
    } catch (e: any) {
      setError(String(e));
    }
  }, [loadedPath]);

  // Load file
  const loadFile = useCallback(async (path: string) => {
    try {
      const content = await invoke<string>("read_file", { filePath: path });
      setLoadedPath(path);
      setError(null);
      originalContent.current = content;
      setModified(false);

      // Determine language extension
      const ext = path.split(".").pop()?.toLowerCase() || "";
      const langLoader = LANG_MAP[ext];
      const langExt = langLoader ? await langLoader() : [];

      // Destroy old view
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }

      if (!editorRef.current) return;

      const state = EditorState.create({
        doc: content,
        extensions: [
          ...(useVim ? [vim()] : []),
          darkTheme,
          history(),
          bracketMatching(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          langExt,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              setModified(update.state.doc.toString() !== originalContent.current);
            }
            const pos = update.state.selection.main.head;
            const line = update.state.doc.lineAt(pos);
            setCursorPos({ line: line.number, col: pos - line.from + 1 });
            // Detect vim mode changes from the update
            const cm = (update.view as any).cm;
            if (cm?.state?.vim) {
              const v = cm.state.vim;
              const mode = v.insertMode ? "INSERT" : v.visualMode ? "VISUAL" : "NORMAL";
              setVimMode(mode);
            }
          }),
          EditorView.lineWrapping,
        ],
      });

      const view = new EditorView({ state, parent: editorRef.current });
      viewRef.current = view;
      setPathFocused(false);
      view.focus();
    } catch (e: any) {
      setError(String(e));
    }
  }, [useVim]);

  // Cmd+S to save, Escape to close (standard mode only)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "s") {
        e.preventDefault();
        saveFile();
      }
      if (e.key === "Escape" && !useVim && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [saveFile, useVim, onClose]);

  // Re-create editor when vim mode toggles
  useEffect(() => {
    if (loadedPath) loadFile(loadedPath);
  }, [useVim]);

  // Register vim :w, :q, :wq commands
  useEffect(() => {
    const saveRef = { current: saveFile };
    const closeRef = { current: onClose };
    saveRef.current = saveFile;
    closeRef.current = onClose;

    Vim.defineEx("write", "w", () => { saveRef.current(); });
    Vim.defineEx("quit", "q", () => { closeRef.current(); });
    Vim.defineEx("wquit", "wq", async () => { await saveRef.current(); closeRef.current(); });
  }, [saveFile, onClose]);

  // Track vim mode changes via EditorView update listener (set up in loadFile)

  // Autocomplete for path input
  useEffect(() => {
    if (!pathFocused || !filePath.trim()) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      invoke<[string, boolean][]>("list_files", { partial: filePath })
        .then((items) => {
          setSuggestions(items.map(([path, isDir]) => ({ path, isDir })));
          setSelectedIdx(-1);
        })
        .catch(() => setSuggestions([]));
    }, 100);
    return () => clearTimeout(timer);
  }, [filePath, pathFocused]);

  const toggleVim = () => {
    const next = !useVim;
    setUseVim(next);
    localStorage.setItem(EDITOR_MODE_KEY, String(next));
  };

  // Load vimrc + auto-load file if initialFilePath provided
  useEffect(() => {
    const init = useVim ? loadVimrc() : Promise.resolve();
    init.then(() => {
      if (initialFilePath) {
        loadFile(initialFilePath);
      }
    });
  }, []); // only on mount

  // Cleanup editor on unmount
  useEffect(() => {
    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, []);

  const acceptSuggestion = (item: { path: string; isDir: boolean }) => {
    if (item.isDir) {
      setFilePath(item.path + "/");
    } else {
      setFilePath(item.path);
      setSuggestions([]);
      loadFile(item.path);
    }
  };

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab" && suggestions.length > 0) {
      e.preventDefault();
      acceptSuggestion(suggestions[Math.max(0, selectedIdx)]);
    } else if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (selectedIdx >= 0 && suggestions.length > 0) {
        acceptSuggestion(suggestions[selectedIdx]);
      } else {
        setSuggestions([]);
        loadFile(filePath);
      }
    } else if (e.key === "Escape") {
      if (suggestions.length > 0) {
        setSuggestions([]);
      } else if (loadedPath) {
        setPathFocused(false);
        viewRef.current?.focus();
      } else {
        onClose();
      }
    }
  };

  // Scroll selected suggestion into view
  const suggestionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedIdx >= 0 && suggestionsRef.current) {
      const el = suggestionsRef.current.children[selectedIdx] as HTMLElement;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIdx]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex flex-col bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg shadow-2xl overflow-hidden"
        style={{ width: "min(900px, 90vw)", height: "min(700px, 85vh)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Path bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
          <div className="relative flex-1">
            <input
              ref={pathInputRef}
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              onKeyDown={handlePathKeyDown}
              onFocus={() => setPathFocused(true)}
              autoFocus
              className="w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] font-mono transition-colors"
              placeholder="~/path/to/file"
              spellCheck={false}
            />
            {suggestions.length > 0 && pathFocused && (
              <div
                ref={suggestionsRef}
                className="absolute left-0 right-0 top-full mt-1 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded shadow-lg max-h-48 overflow-y-auto z-10"
              >
                {suggestions.map((s, i) => (
                  <div
                    key={s.path}
                    onClick={() => acceptSuggestion(s)}
                    className={`px-3 py-1.5 text-xs font-mono cursor-pointer truncate flex items-center gap-2 ${
                      i === selectedIdx
                        ? "bg-[var(--accent)] text-white"
                        : "text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                    }`}
                  >
                    <span className={`text-[10px] ${i === selectedIdx ? "text-white/70" : "text-[var(--text-tertiary)]"}`}>
                      {s.isDir ? "dir" : "file"}
                    </span>
                    {s.path}
                  </div>
                ))}
              </div>
            )}
          </div>
          {loadedPath && (
            <button
              onClick={async () => {
                // resolve_path expands ~ and relative paths on the Rust side
                const resolved = await invoke<string>("resolve_path", { filePath: loadedPath });
                await openPath(resolved);
              }}
              className="px-2 py-0.5 text-[10px] font-mono rounded border bg-[var(--bg-primary)] text-[var(--text-tertiary)] border-[var(--border-color)] hover:text-[var(--text-secondary)] transition-colors"
              title="Open in default editor"
            >
              External
            </button>
          )}
          <button
            onClick={toggleVim}
            className={`px-2 py-0.5 text-[10px] font-mono rounded border transition-colors ${
              useVim
                ? "bg-green-500/15 text-green-400 border-green-500/30"
                : "bg-[var(--bg-primary)] text-[var(--text-tertiary)] border-[var(--border-color)] hover:text-[var(--text-secondary)]"
            }`}
            title="Toggle Vim mode"
          >
            {useVim ? "Vim" : "Standard"}
          </button>
          <button
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-1"
            title={useVim ? "Close (or :q)" : "Close"}
          >
            ✕
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="px-3 py-1.5 text-xs text-red-400 bg-red-400/10 border-b border-red-400/20">
            {error}
          </div>
        )}

        {/* Editor area */}
        <div className="flex-1 min-h-0 overflow-hidden" ref={editorRef}>
          {!loadedPath && (
            <div className="flex items-center justify-center h-full text-sm text-[var(--text-tertiary)]">
              Enter a file path above to open
            </div>
          )}
        </div>

        {/* Status bar */}
        {loadedPath && (
          <div className="flex items-center gap-3 px-3 py-1 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] text-[10px] font-mono text-[var(--text-tertiary)]">
            {useVim && (
              <span className={`font-bold ${
                vimMode === "INSERT" ? "text-green-400" :
                vimMode === "VISUAL" ? "text-purple-400" :
                "text-[var(--text-secondary)]"
              }`}>
                {vimMode}
              </span>
            )}
            <span className="truncate flex-1 text-[var(--text-secondary)]">
              {loadedPath}
              {modified && <span className="text-yellow-400 ml-1">[+]</span>}
            </span>
            {!useVim && modified && (
              <span className="text-[var(--text-tertiary)]">Cmd+S to save</span>
            )}
            <span>{cursorPos.line}:{cursorPos.col}</span>
          </div>
        )}
      </div>
    </div>
  );
}
