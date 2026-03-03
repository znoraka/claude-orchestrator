import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";
import type { GitFileEntry, GitStatusResult } from "../types";

interface GitPanelProps {
  directory: string;
}

const STATUS_COLORS: Record<string, string> = {
  M: "text-yellow-400",
  A: "text-green-400",
  D: "text-red-400",
  R: "text-blue-400",
  C: "text-blue-400",
  "??": "text-gray-400",
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] || "text-gray-400";
}

type DiffMode = "unified" | "split";

interface DiffLine {
  type: "context" | "add" | "remove" | "hunk" | "header";
  content: string;
}

function classifyLine(line: string): DiffLine {
  if (line.startsWith("+++") || line.startsWith("---"))
    return { type: "header", content: line };
  if (line.startsWith("@@")) return { type: "hunk", content: line };
  if (line.startsWith("+")) return { type: "add", content: line.slice(1) };
  if (line.startsWith("-")) return { type: "remove", content: line.slice(1) };
  return { type: "context", content: line.startsWith(" ") ? line.slice(1) : line };
}

// --- Shiki highlighter singleton ---

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  rs: "rust", py: "python", rb: "ruby", go: "go", java: "java",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  swift: "swift", kt: "kotlin", scala: "scala",
  html: "html", css: "css", scss: "scss", less: "less",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  md: "markdown", sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
  xml: "xml", svg: "xml", vue: "vue", svelte: "svelte",
  php: "php", lua: "lua", zig: "zig", r: "r",
  dockerfile: "dockerfile", makefile: "makefile",
};

function langFromPath(filePath: string): BundledLanguage | null {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile" as BundledLanguage;
  if (name === "makefile" || name === "gnumakefile") return "makefile" as BundledLanguage;
  const ext = name.split(".").pop() ?? "";
  return (EXT_TO_LANG[ext] as BundledLanguage) ?? null;
}

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark"],
      langs: [],
    });
  }
  return highlighterPromise;
}

async function ensureLang(hl: Highlighter, lang: string): Promise<void> {
  if (!loadedLangs.has(lang)) {
    try {
      await hl.loadLanguage(lang as Parameters<Highlighter["loadLanguage"]>[0]);
      loadedLangs.add(lang);
    } catch {
      // Language not available — fall back to plain text
    }
  }
}

interface HighlightedToken {
  content: string;
  color?: string;
}

async function highlightLines(
  lines: string[],
  filePath: string
): Promise<HighlightedToken[][]> {
  const lang = langFromPath(filePath);
  if (!lang) {
    return lines.map((l) => [{ content: l }]);
  }
  const hl = await getHighlighter();
  await ensureLang(hl, lang);
  if (!loadedLangs.has(lang)) {
    return lines.map((l) => [{ content: l }]);
  }

  const code = lines.join("\n");
  const result = hl.codeToTokens(code, { lang, theme: "github-dark" });
  return result.tokens.map((lineTokens) =>
    lineTokens.map((t) => ({ content: t.content, color: t.color }))
  );
}

// --- Hook to highlight lines for a file ---

function useHighlightedLines(lines: string[], filePath: string): HighlightedToken[][] | null {
  const [tokens, setTokens] = useState<HighlightedToken[][] | null>(null);
  const idRef = useRef(0);

  useEffect(() => {
    const id = ++idRef.current;
    highlightLines(lines, filePath).then((result) => {
      if (id === idRef.current) setTokens(result);
    });
  }, [lines, filePath]);

  return tokens;
}

function TokenSpan({ tokens }: { tokens: HighlightedToken[] }) {
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} style={t.color ? { color: t.color } : undefined}>
          {t.content}
        </span>
      ))}
    </>
  );
}

// --- Diff backgrounds (no text color — syntax tokens provide color) ---

const BG: Record<DiffLine["type"], string> = {
  context: "",
  add: "bg-green-900/30",
  remove: "bg-red-900/30",
  hunk: "bg-cyan-900/20",
  header: "",
};

const GUTTER_COLOR: Record<DiffLine["type"], string> = {
  context: "text-[var(--text-tertiary)]",
  add: "text-green-400",
  remove: "text-red-400",
  hunk: "text-cyan-400",
  header: "text-[var(--text-tertiary)]",
};

// Fallback text color when no syntax tokens available
const FALLBACK_COLOR: Record<DiffLine["type"], string> = {
  context: "text-[var(--text-secondary)]",
  add: "text-green-400",
  remove: "text-red-400",
  hunk: "text-cyan-400",
  header: "text-[var(--text-tertiary)] font-bold",
};

// --- Unified diff ---

function UnifiedDiff({ diff, filePath }: { diff: string; filePath: string }) {
  const classified = useMemo(() => diff.split("\n").map(classifyLine), [diff]);
  const contentLines = useMemo(() => classified.map((l) => l.content), [classified]);
  const highlighted = useHighlightedLines(contentLines, filePath);

  return (
    <div className="font-mono text-xs leading-5 overflow-auto h-full py-2">
      <table style={{ minWidth: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {classified.map((line, i) => {
            const tokens = highlighted?.[i];
            const isCode = line.type === "context" || line.type === "add" || line.type === "remove";
            const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";

            if (!isCode) {
              return (
                <tr key={i} className={BG[line.type]}>
                  <td colSpan={2} className={`${FALLBACK_COLOR[line.type]} px-2 whitespace-pre`}>
                    {line.content}
                  </td>
                </tr>
              );
            }

            return (
              <tr key={i} className={BG[line.type]}>
                <td className={`${GUTTER_COLOR[line.type]} w-6 text-center select-none whitespace-pre`}>{prefix}</td>
                <td className={`${tokens ? "" : FALLBACK_COLOR[line.type]} whitespace-pre`}>
                  {tokens ? <TokenSpan tokens={tokens} /> : line.content}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Split diff ---

interface SplitPair {
  left: DiffLine | null;
  right: DiffLine | null;
  type: "context" | "change" | "hunk" | "header";
}

function buildSplitPairs(diff: string): SplitPair[] {
  const lines = diff.split("\n").map(classifyLine);
  const pairs: SplitPair[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "header" || line.type === "hunk") {
      pairs.push({ left: line, right: line, type: line.type });
      i++;
    } else if (line.type === "context") {
      pairs.push({ left: line, right: line, type: "context" });
      i++;
    } else {
      const removes: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].type === "remove") {
        removes.push(lines[i]);
        i++;
      }
      while (i < lines.length && lines[i].type === "add") {
        adds.push(lines[i]);
        i++;
      }
      const max = Math.max(removes.length, adds.length);
      for (let j = 0; j < max; j++) {
        pairs.push({
          left: j < removes.length ? removes[j] : null,
          right: j < adds.length ? adds[j] : null,
          type: "change",
        });
      }
    }
  }
  return pairs;
}

function SplitDiff({ diff, filePath }: { diff: string; filePath: string }) {
  const pairs = useMemo(() => buildSplitPairs(diff), [diff]);

  // Collect all content lines for highlighting (left then right)
  const { leftLines, rightLines } = useMemo(() => {
    const left: string[] = [];
    const right: string[] = [];
    for (const pair of pairs) {
      left.push(pair.left?.content ?? "");
      right.push(pair.right?.content ?? "");
    }
    return { leftLines: left, rightLines: right };
  }, [pairs]);

  const leftTokens = useHighlightedLines(leftLines, filePath);
  const rightTokens = useHighlightedLines(rightLines, filePath);

  return (
    <div className="font-mono text-xs leading-5 overflow-auto h-full py-2">
      <table style={{ minWidth: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {pairs.map((pair, i) => {
            if (pair.type === "header" || pair.type === "hunk") {
              return (
                <tr key={i} className={BG[pair.type]}>
                  <td colSpan={4} className={`${FALLBACK_COLOR[pair.type]} px-2 whitespace-pre`}>
                    {pair.left?.content}
                  </td>
                </tr>
              );
            }

            const lType = pair.left?.type ?? "context";
            const rType = pair.right?.type ?? "context";
            const lTok = leftTokens?.[i];
            const rTok = rightTokens?.[i];
            const lPrefix = lType === "remove" ? "-" : " ";
            const rPrefix = rType === "add" ? "+" : " ";

            return (
              <tr key={i}>
                <td className={`${BG[lType]} ${GUTTER_COLOR[lType]} w-5 text-center select-none whitespace-pre`}>{pair.left ? lPrefix : ""}</td>
                <td className={`${BG[lType]} whitespace-pre border-r border-[var(--border-color)] ${lTok ? "" : FALLBACK_COLOR[lType]}`} style={{ width: '50%' }}>
                  {lTok && pair.left ? <TokenSpan tokens={lTok} /> : (pair.left?.content ?? "")}
                </td>
                <td className={`${BG[rType]} ${GUTTER_COLOR[rType]} w-5 text-center select-none whitespace-pre`}>{pair.right ? rPrefix : ""}</td>
                <td className={`${BG[rType]} whitespace-pre ${rTok ? "" : FALLBACK_COLOR[rType]}`} style={{ width: '50%' }}>
                  {rTok && pair.right ? <TokenSpan tokens={rTok} /> : (pair.right?.content ?? "")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- DiffViewer ---

function DiffViewer({ diff, mode, filePath }: { diff: string; mode: DiffMode; filePath: string }) {
  if (!diff) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
        No changes to display
      </div>
    );
  }

  return mode === "split"
    ? <SplitDiff diff={diff} filePath={filePath} />
    : <UnifiedDiff diff={diff} filePath={filePath} />;
}

// --- New file viewer with syntax highlighting ---

function NewFileViewer({ content, filePath }: { content: string; filePath: string }) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const highlighted = useHighlightedLines(lines, filePath);

  return (
    <div className="font-mono text-xs leading-5 overflow-auto h-full py-2">
      <table style={{ minWidth: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          <tr>
            <td colSpan={2} className="text-[var(--text-tertiary)] text-[10px] uppercase tracking-wider pb-2 px-2">New file</td>
          </tr>
          {lines.map((line, i) => {
            const tokens = highlighted?.[i];
            return (
              <tr key={i} className="bg-green-900/30">
                <td className="text-green-400 w-6 text-center select-none whitespace-pre">+</td>
                <td className="whitespace-pre">{tokens ? <TokenSpan tokens={tokens} /> : <span className="text-green-400">{line}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Main GitPanel ---

export default function GitPanel({ directory }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitFileEntry | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>(
    () => (localStorage.getItem("git-diff-mode") as DiffMode) || "unified"
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<GitStatusResult>("get_git_status", { directory });
      setStatus(result);
      if (result.isGitRepo && result.files.length > 0) {
        setSelectedFile((prev) => {
          if (prev && result.files.some((f) => f.path === prev.path && f.staged === prev.staged)) {
            return prev;
          }
          return result.files[0];
        });
      } else {
        setSelectedFile(null);
        setDiff("");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [directory]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedFile || !status?.isGitRepo) {
      setDiff("");
      return;
    }
    if (selectedFile.status === "??") {
      invoke<string>("read_file_content", {
        directory,
        filePath: selectedFile.path,
      })
        .then(setDiff)
        .catch((e) => setDiff(`Error reading file: ${e}`));
      return;
    }
    invoke<string>("get_git_diff", {
      directory,
      filePath: selectedFile.path,
      staged: selectedFile.staged,
    })
      .then(setDiff)
      .catch((e) => setDiff(`Error loading diff: ${e}`));
  }, [selectedFile, directory, status?.isGitRepo]);

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
        Loading git status...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400 text-sm">
        {error}
      </div>
    );
  }

  if (!status?.isGitRepo) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
        Not a git repository
      </div>
    );
  }

  const staged = status.files.filter((f) => f.staged);
  const modified = status.files.filter((f) => !f.staged && f.status !== "??");
  const untracked = status.files.filter((f) => f.status === "??");

  const renderGroup = (label: string, files: GitFileEntry[]) => {
    if (files.length === 0) return null;
    return (
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] px-2 py-1 font-semibold">
          {label} ({files.length})
        </div>
        {files.map((file) => {
          const isSelected =
            selectedFile?.path === file.path && selectedFile?.staged === file.staged;
          return (
            <button
              key={`${file.staged ? "s" : "u"}-${file.path}`}
              onClick={() => setSelectedFile(file)}
              className={`w-full text-left px-2 py-1 text-xs font-mono truncate flex items-center gap-2 rounded transition-colors ${
                isSelected
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
              }`}
              title={file.path}
            >
              <span
                className={`w-5 text-center font-bold flex-shrink-0 ${
                  isSelected ? "text-white" : statusColor(file.status)
                }`}
              >
                {file.status}
              </span>
              <span className="truncate">{file.path}</span>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border-color)] flex-shrink-0">
        <span className="text-xs font-mono text-[var(--text-secondary)]">
          {status.branch}
        </span>
        <span className="text-[10px] text-[var(--text-tertiary)]">
          {status.files.length} file{status.files.length !== 1 ? "s" : ""} changed
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => {
              const next = diffMode === "unified" ? "split" : "unified";
              setDiffMode(next);
              localStorage.setItem("git-diff-mode", next);
            }}
            className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-1.5 py-0.5 rounded hover:bg-[var(--bg-tertiary)]"
            title="Toggle diff view"
          >
            {diffMode === "unified" ? "Split" : "Unified"}
          </button>
          <button
            onClick={refresh}
            className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-1.5 py-0.5 rounded hover:bg-[var(--bg-tertiary)]"
            title="Refresh"
          >
            {loading ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      {status.files.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-[var(--text-tertiary)] text-sm">
          Working tree clean
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* File list */}
          <div className="w-64 flex-shrink-0 border-r border-[var(--border-color)] overflow-y-auto py-2">
            {renderGroup("Staged", staged)}
            {renderGroup("Modified", modified)}
            {renderGroup("Untracked", untracked)}
          </div>

          {/* Diff viewer */}
          <div className="flex-1 min-w-0 overflow-auto bg-[var(--bg-primary)]">
            {selectedFile ? (
              selectedFile.status === "??" ? (
                <NewFileViewer content={diff} filePath={selectedFile.path} />
              ) : (
                <DiffViewer diff={diff} mode={diffMode} filePath={selectedFile.path} />
              )
            ) : (
              <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
                Select a file to view changes
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
