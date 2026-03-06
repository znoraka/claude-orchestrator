import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, bracketMatching } from "@codemirror/language";
import { oneDarkHighlightStyle } from "../utils/oneDarkHighlight";

export interface FileReference {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
}

interface Props {
  directory: string;
  onSelect: (ref: FileReference) => void;
  onClose: () => void;
  initialFile?: FileReference;
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

const darkTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--bg-primary)",
    color: "var(--text-primary)",
    height: "100%",
    fontSize: "13px",
  },
  ".cm-content": { caretColor: "var(--accent)", fontFamily: "var(--font-mono, 'SF Mono', Menlo, monospace)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "rgba(99,102,241,0.25)" },
  ".cm-gutters": { backgroundColor: "var(--bg-secondary)", color: "var(--text-tertiary)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-tertiary)" },
  ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
}, { dark: true });

export default function FilePickerModal({ directory, onSelect, onClose, initialFile }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadedFile, setLoadedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isViewOnly = !!initialFile;

  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pre-warm the file list cache in the background on mount
  useEffect(() => {
    if (!directory || initialFile) return;
    invoke("search_project_files", { directory, query: "" }).catch(() => {});
  }, [directory]); // eslint-disable-line react-hooks/exhaustive-deps

  // Search files (only when query is non-empty)
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!directory || initialFile) return;
    if (!query) {
      setResults([]);
      setSelectedIdx(0);
      return;
    }
    setLoading(true);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const files = await invoke<string[]>("search_project_files", { directory, query });
        setError(null);
        setResults(files);
        setSelectedIdx(0);
      } catch (err) {
        console.error("search_project_files failed:", err, "directory:", directory);
        setError(`Could not list files in ${directory}`);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 80);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [query, directory]);

  // Scroll selected result into view
  useEffect(() => {
    if (resultsRef.current && selectedIdx >= 0) {
      const el = resultsRef.current.children[selectedIdx] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIdx]);

  // Load file content (just fetches, doesn't mount editor)
  const loadFile = useCallback(async (filePath: string) => {
    const fullPath = directory.endsWith("/") ? directory + filePath : directory + "/" + filePath;
    try {
      const content = await invoke<string>("read_file", { filePath: fullPath });
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
      setSelection(null);
      setFileContent(content);
      setLoadedFile(filePath);
    } catch {
      // ignore load errors
    }
  }, [directory]);

  // Mount CodeMirror after editor div is rendered
  useEffect(() => {
    if (!loadedFile || fileContent === null || !editorRef.current) return;

    const mount = async () => {
      const ext = loadedFile.split(".").pop()?.toLowerCase() || "";
      const langLoader = LANG_MAP[ext];
      const langExt = langLoader ? await langLoader() : [];

      if (!editorRef.current) return;

      const state = EditorState.create({
        doc: fileContent,
        extensions: [
          EditorState.readOnly.of(true),
          darkTheme,
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          bracketMatching(),
          highlightSelectionMatches(),
          syntaxHighlighting(oneDarkHighlightStyle, { fallback: true }),
          keymap.of([...defaultKeymap, ...searchKeymap]),
          langExt,
          EditorView.updateListener.of((update) => {
            const sel = update.state.selection.main;
            if (sel.from !== sel.to) {
              const startLine = update.state.doc.lineAt(sel.from).number;
              const endLine = update.state.doc.lineAt(sel.to).number;
              setSelection({ start: startLine, end: endLine });
            } else {
              setSelection(null);
            }
          }),
          EditorView.lineWrapping,
        ],
      });

      const view = new EditorView({ state, parent: editorRef.current });
      viewRef.current = view;

      // Restore previous line selection when reopening an existing reference
      if (initialFile && initialFile.startLine >= 1 && initialFile.endLine >= initialFile.startLine) {
        const doc = view.state.doc;
        const totalLines = doc.lines;
        const isWholeFile = initialFile.startLine === 1 && initialFile.endLine === totalLines;
        if (!isWholeFile && initialFile.startLine <= totalLines && initialFile.endLine <= totalLines) {
          const from = doc.line(initialFile.startLine).from;
          const to = doc.line(initialFile.endLine).to;
          view.dispatch({
            selection: EditorSelection.single(from, to),
            scrollIntoView: true,
          });
        }
      }

      view.focus();
    };
    mount();

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [loadedFile, fileContent]);

  // Confirm selection
  const confirm = useCallback(() => {
    if (!loadedFile || !viewRef.current) return;
    const doc = viewRef.current.state.doc;
    const sel = viewRef.current.state.selection.main;

    let startLine: number, endLine: number, content: string;
    if (sel.from !== sel.to) {
      startLine = doc.lineAt(sel.from).number;
      endLine = doc.lineAt(sel.to).number;
      // Extract full lines for the selection
      const fromPos = doc.line(startLine).from;
      const toPos = doc.line(endLine).to;
      content = doc.sliceString(fromPos, toPos);
    } else {
      // No selection — include entire file
      startLine = 1;
      endLine = doc.lines;
      content = doc.toString();
    }

    onSelect({ filePath: loadedFile, startLine, endLine, content });
    onClose();
  }, [loadedFile, onSelect, onClose]);

  // Keyboard handling for search input
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (loadedFile) {
        confirm();
      } else if (results.length > 0) {
        loadFile(results[selectedIdx]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (loadedFile && !isViewOnly) {
        // Go back to search
        setLoadedFile(null);
        setSelection(null);
        if (viewRef.current) { viewRef.current.destroy(); viewRef.current = null; }
        setTimeout(() => searchRef.current?.focus(), 0);
      } else {
        onClose();
      }
    }
  };

  // Global Escape handler when editor is focused
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (loadedFile && !isViewOnly) {
          setLoadedFile(null);
          setSelection(null);
          if (viewRef.current) { viewRef.current.destroy(); viewRef.current = null; }
          setTimeout(() => searchRef.current?.focus(), 0);
        } else {
          onClose();
        }
      }
      // Enter to confirm when file is loaded
      if (e.key === "Enter" && loadedFile) {
        e.preventDefault();
        confirm();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [loadedFile, onClose, confirm]);

  // Cleanup
  useEffect(() => {
    return () => { if (viewRef.current) { viewRef.current.destroy(); viewRef.current = null; } };
  }, []);

  // Load full file content when opened with initialFile
  useEffect(() => {
    if (!initialFile) return;
    loadFile(initialFile.filePath);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus search on mount (only when not pre-loaded)
  useEffect(() => { if (!initialFile) searchRef.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
          {!isViewOnly ? (
            <>
              <svg className="w-4 h-4 text-[var(--text-tertiary)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search files…"
                className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none font-mono"
                spellCheck={false}
              />
              {loadedFile && (
                <span className="text-xs text-[var(--text-secondary)] font-mono truncate max-w-[300px]">
                  {loadedFile}
                </span>
              )}
            </>
          ) : (
            <span className="flex-1 text-xs text-[var(--text-secondary)] font-mono truncate">
              {loadedFile}
            </span>
          )}
          <button
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-1"
          >
            ✕
          </button>
        </div>

        {/* Content area */}
        {!loadedFile && isViewOnly ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-sm text-[var(--text-tertiary)]">Loading…</span>
          </div>
        ) : !loadedFile ? (
          /* File search results */
          <div ref={resultsRef} className="flex-1 overflow-y-auto min-h-0">
            {error && (
              <div className="px-4 py-4 text-xs text-red-400 text-center">{error}</div>
            )}
            {!error && results.length === 0 && query && !loading && (
              <div className="px-4 py-8 text-sm text-[var(--text-tertiary)] text-center">No files found</div>
            )}
            {!error && results.length === 0 && query && loading && (
              <div className="px-4 py-8 text-sm text-[var(--text-tertiary)] text-center">Searching…</div>
            )}
            {!error && results.length === 0 && !query && (
              <div className="px-4 py-8 text-sm text-[var(--text-tertiary)] text-center">
                Type to search for files in this project
              </div>
            )}
            {results.map((filePath, i) => {
              const parts = filePath.split("/");
              const fileName = parts.pop()!;
              const dirPath = parts.join("/");
              return (
                <button
                  key={filePath}
                  className={`w-full text-left px-4 py-2 flex items-center gap-2 text-sm transition-colors ${
                    i === selectedIdx
                      ? "bg-[var(--accent)]/15 text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                  }`}
                  onMouseEnter={() => setSelectedIdx(i)}
                  onMouseDown={(e) => { e.preventDefault(); loadFile(filePath); }}
                >
                  <svg className="w-4 h-4 shrink-0 text-[var(--text-tertiary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="font-mono truncate">{fileName}</span>
                  {dirPath && (
                    <span className="text-[var(--text-tertiary)] text-xs truncate ml-auto font-mono">{dirPath}/</span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          /* Editor with file content */
          <div className="flex-1 min-h-0 overflow-hidden" ref={editorRef} />
        )}

        {/* Footer */}
        {loadedFile && (
          <div className="flex items-center gap-3 px-3 py-2 border-t border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <span className="text-xs text-[var(--text-tertiary)] font-mono flex-1">
              {selection
                ? `Lines ${selection.start}–${selection.end} selected (${selection.end - selection.start + 1} lines)`
                : isViewOnly ? "Select lines to update, or keep entire file" : "Select lines or add entire file"}
            </span>
            <span className="text-[10px] text-[var(--text-tertiary)]">
              {selection ? `Enter to ${isViewOnly ? "update" : "add"} selection` : `Enter to ${isViewOnly ? "update" : "add"} file`}
            </span>
            <button
              onClick={confirm}
              className="px-3 py-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded text-xs font-medium transition-colors"
            >
              {selection ? `${isViewOnly ? "Update" : "Add"} lines ${selection.start}–${selection.end}` : `${isViewOnly ? "Keep" : "Add"} entire file`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
