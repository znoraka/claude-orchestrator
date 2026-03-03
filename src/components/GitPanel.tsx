import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";
import type { GitFileEntry, GitStatusResult } from "../types";

interface GitPanelProps {
  directory: string;
  isActive?: boolean;
  onEditFile?: (filePath: string) => void;
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

// --- Search highlight helper ---

function highlightSearchInText(
  text: string,
  query: string,
  matchIndices: Set<number>,
  baseIndex: number
): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let last = 0;
  let localIdx = 0;
  let pos = lower.indexOf(qLower);
  while (pos !== -1) {
    if (pos > last) parts.push(text.slice(last, pos));
    const globalIdx = baseIndex + localIdx;
    const isCurrent = matchIndices.has(globalIdx);
    parts.push(
      <mark
        key={pos}
        data-search-match={globalIdx}
        className={isCurrent ? "bg-yellow-400 text-black" : "bg-yellow-700/60 text-inherit"}
        style={{ borderRadius: 2 }}
      >
        {text.slice(pos, pos + query.length)}
      </mark>
    );
    localIdx++;
    last = pos + query.length;
    pos = lower.indexOf(qLower, last);
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? <>{parts}</> : text;
}

function highlightSearchInTokens(
  tokens: HighlightedToken[],
  query: string,
  matchIndices: Set<number>,
  baseIndex: number
): { node: React.ReactNode; matchCount: number } {
  if (!query) return { node: <TokenSpan tokens={tokens} />, matchCount: 0 };

  const fullText = tokens.map((t) => t.content).join("");
  const lower = fullText.toLowerCase();
  const qLower = query.toLowerCase();

  // Find match positions in the full line
  const matches: number[] = [];
  let pos = lower.indexOf(qLower);
  while (pos !== -1) {
    matches.push(pos);
    pos = lower.indexOf(qLower, pos + qLower.length);
  }
  if (matches.length === 0) return { node: <TokenSpan tokens={tokens} />, matchCount: 0 };

  // Build a set of character ranges that are highlighted
  const hlRanges = matches.map((m) => [m, m + query.length] as const);

  const parts: React.ReactNode[] = [];
  let charOffset = 0;
  let matchIdx = 0;

  for (let ti = 0; ti < tokens.length; ti++) {
    const token = tokens[ti];
    const tokenStart = charOffset;
    const tokenEnd = charOffset + token.content.length;
    let cursor = tokenStart;

    for (const [hlStart, hlEnd] of hlRanges) {
      if (hlStart >= tokenEnd || hlEnd <= tokenStart) continue;
      const clampStart = Math.max(hlStart, tokenStart);
      const clampEnd = Math.min(hlEnd, tokenEnd);

      if (clampStart > cursor) {
        parts.push(
          <span key={`${ti}-${cursor}`} style={token.color ? { color: token.color } : undefined}>
            {token.content.slice(cursor - tokenStart, clampStart - tokenStart)}
          </span>
        );
      }

      const globalIdx = baseIndex + (matches.indexOf(hlStart) >= 0 ? matches.indexOf(hlStart) : matchIdx);
      const isCurrent = matchIndices.has(globalIdx);
      // Only render mark at the start of a match
      if (clampStart === hlStart) {
        matchIdx++;
      }
      parts.push(
        <mark
          key={`${ti}-hl-${clampStart}`}
          data-search-match={globalIdx}
          className={isCurrent ? "bg-yellow-400 text-black" : "bg-yellow-700/60"}
          style={{ borderRadius: 2 }}
        >
          <span style={token.color && !isCurrent ? { color: token.color } : undefined}>
            {token.content.slice(clampStart - tokenStart, clampEnd - tokenStart)}
          </span>
        </mark>
      );
      cursor = clampEnd;
    }

    if (cursor < tokenEnd) {
      parts.push(
        <span key={`${ti}-tail`} style={token.color ? { color: token.color } : undefined}>
          {token.content.slice(cursor - tokenStart)}
        </span>
      );
    }
    charOffset = tokenEnd;
  }

  return { node: <>{parts}</>, matchCount: matches.length };
}

// Count search matches in a text string
function countMatches(text: string, query: string): number {
  if (!query) return 0;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  let count = 0;
  let pos = lower.indexOf(qLower);
  while (pos !== -1) {
    count++;
    pos = lower.indexOf(qLower, pos + qLower.length);
  }
  return count;
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

function UnifiedDiff({ diff, filePath, searchQuery, currentMatch }: { diff: string; filePath: string; searchQuery: string; currentMatch: number }) {
  const classified = useMemo(() => diff.split("\n").map(classifyLine), [diff]);
  const contentLines = useMemo(() => classified.map((l) => l.content), [classified]);
  const highlighted = useHighlightedLines(contentLines, filePath);

  // Compute cumulative match index per line
  const cumulativeMatchCounts = useMemo(() => {
    const counts: number[] = [];
    let total = 0;
    for (const line of classified) {
      counts.push(total);
      total += countMatches(line.content, searchQuery);
    }
    return counts;
  }, [classified, searchQuery]);

  const currentMatchSet = useMemo(() => new Set([currentMatch]), [currentMatch]);

  return (
    <div className="font-mono text-xs leading-5 overflow-auto h-full py-2">
      <table style={{ minWidth: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {classified.map((line, i) => {
            const tokens = highlighted?.[i];
            const isCode = line.type === "context" || line.type === "add" || line.type === "remove";
            const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
            const baseIdx = cumulativeMatchCounts[i];

            if (!isCode) {
              return (
                <tr key={i} className={BG[line.type]}>
                  <td colSpan={2} className={`${FALLBACK_COLOR[line.type]} px-2 whitespace-pre`}>
                    {highlightSearchInText(line.content, searchQuery, currentMatchSet, baseIdx)}
                  </td>
                </tr>
              );
            }

            const renderContent = () => {
              if (tokens) {
                const { node } = highlightSearchInTokens(tokens, searchQuery, currentMatchSet, baseIdx);
                return node;
              }
              return highlightSearchInText(line.content, searchQuery, currentMatchSet, baseIdx);
            };

            return (
              <tr key={i} className={BG[line.type]}>
                <td className={`${GUTTER_COLOR[line.type]} w-6 text-center select-none whitespace-pre`}>{prefix}</td>
                <td className={`${tokens ? "" : FALLBACK_COLOR[line.type]} whitespace-pre`}>
                  {renderContent()}
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

function SplitDiff({ diff, filePath, searchQuery, currentMatch }: { diff: string; filePath: string; searchQuery: string; currentMatch: number }) {
  const pairs = useMemo(() => buildSplitPairs(diff), [diff]);

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

  // Cumulative match counts across both sides (left then right per row)
  const cumulativeMatchCounts = useMemo(() => {
    const counts: { left: number; right: number }[] = [];
    let total = 0;
    for (let i = 0; i < pairs.length; i++) {
      const lCount = countMatches(pairs[i].left?.content ?? "", searchQuery);
      const rCount = countMatches(pairs[i].right?.content ?? "", searchQuery);
      counts.push({ left: total, right: total + lCount });
      total += lCount + rCount;
    }
    return counts;
  }, [pairs, searchQuery]);

  const currentMatchSet = useMemo(() => new Set([currentMatch]), [currentMatch]);

  return (
    <div className="font-mono text-xs leading-5 overflow-auto h-full py-2">
      <table style={{ minWidth: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {pairs.map((pair, i) => {
            if (pair.type === "header" || pair.type === "hunk") {
              return (
                <tr key={i} className={BG[pair.type]}>
                  <td colSpan={4} className={`${FALLBACK_COLOR[pair.type]} px-2 whitespace-pre`}>
                    {highlightSearchInText(pair.left?.content ?? "", searchQuery, currentMatchSet, cumulativeMatchCounts[i].left)}
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
            const lBase = cumulativeMatchCounts[i].left;
            const rBase = cumulativeMatchCounts[i].right;

            const renderLeft = () => {
              if (!pair.left) return "";
              if (lTok) return highlightSearchInTokens(lTok, searchQuery, currentMatchSet, lBase).node;
              return highlightSearchInText(pair.left.content, searchQuery, currentMatchSet, lBase);
            };
            const renderRight = () => {
              if (!pair.right) return "";
              if (rTok) return highlightSearchInTokens(rTok, searchQuery, currentMatchSet, rBase).node;
              return highlightSearchInText(pair.right.content, searchQuery, currentMatchSet, rBase);
            };

            return (
              <tr key={i}>
                <td className={`${BG[lType]} ${GUTTER_COLOR[lType]} w-5 text-center select-none whitespace-pre`}>{pair.left ? lPrefix : ""}</td>
                <td className={`${BG[lType]} whitespace-pre border-r border-[var(--border-color)] ${lTok ? "" : FALLBACK_COLOR[lType]}`} style={{ width: '50%' }}>
                  {renderLeft()}
                </td>
                <td className={`${BG[rType]} ${GUTTER_COLOR[rType]} w-5 text-center select-none whitespace-pre`}>{pair.right ? rPrefix : ""}</td>
                <td className={`${BG[rType]} whitespace-pre ${rTok ? "" : FALLBACK_COLOR[rType]}`} style={{ width: '50%' }}>
                  {renderRight()}
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

function DiffViewer({ diff, mode, filePath, searchQuery, currentMatch }: { diff: string; mode: DiffMode; filePath: string; searchQuery: string; currentMatch: number }) {
  if (!diff) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
        No changes to display
      </div>
    );
  }

  return mode === "split"
    ? <SplitDiff diff={diff} filePath={filePath} searchQuery={searchQuery} currentMatch={currentMatch} />
    : <UnifiedDiff diff={diff} filePath={filePath} searchQuery={searchQuery} currentMatch={currentMatch} />;
}

// --- New file viewer with syntax highlighting ---

function NewFileViewer({ content, filePath, searchQuery, currentMatch }: { content: string; filePath: string; searchQuery: string; currentMatch: number }) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const highlighted = useHighlightedLines(lines, filePath);

  const cumulativeMatchCounts = useMemo(() => {
    const counts: number[] = [];
    let total = 0;
    for (const line of lines) {
      counts.push(total);
      total += countMatches(line, searchQuery);
    }
    return counts;
  }, [lines, searchQuery]);

  const currentMatchSet = useMemo(() => new Set([currentMatch]), [currentMatch]);

  return (
    <div className="font-mono text-xs leading-5 overflow-auto h-full py-2">
      <table style={{ minWidth: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          <tr>
            <td colSpan={2} className="text-[var(--text-tertiary)] text-[10px] uppercase tracking-wider pb-2 px-2">New file</td>
          </tr>
          {lines.map((line, i) => {
            const tokens = highlighted?.[i];
            const baseIdx = cumulativeMatchCounts[i];
            const renderContent = () => {
              if (tokens) return highlightSearchInTokens(tokens, searchQuery, currentMatchSet, baseIdx).node;
              return <span className="text-green-400">{highlightSearchInText(line, searchQuery, currentMatchSet, baseIdx)}</span>;
            };
            return (
              <tr key={i} className="bg-green-900/30">
                <td className="text-green-400 w-6 text-center select-none whitespace-pre">+</td>
                <td className="whitespace-pre">{renderContent()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Main GitPanel ---

export default function GitPanel({ directory, isActive, onEditFile }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitFileEntry | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>(
    () => (localStorage.getItem("git-diff-mode") as DiffMode) || "unified"
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const diffContainerRef = useRef<HTMLDivElement>(null);

  // Cmd+E opens selected file in editor
  useEffect(() => {
    if (!isActive || !onEditFile || !selectedFile) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "e") {
        e.preventDefault();
        onEditFile(selectedFile.path);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isActive, onEditFile, selectedFile]);

  // Total match count for current diff
  const totalMatches = useMemo(() => {
    if (!searchQuery || !diff) return 0;
    return countMatches(diff, searchQuery);
  }, [diff, searchQuery]);

  // Cmd+F to open search, Escape to close
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === "Escape" && searchOpen) {
        e.preventDefault();
        setSearchOpen(false);
        setSearchQuery("");
        setCurrentMatch(0);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isActive, searchOpen]);

  // Scroll current match into view
  useEffect(() => {
    if (!searchQuery || totalMatches === 0) return;
    const container = diffContainerRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-search-match="${currentMatch}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [currentMatch, searchQuery, totalMatches]);

  const navigateMatch = useCallback((direction: 1 | -1) => {
    if (totalMatches === 0) return;
    setCurrentMatch((prev) => (prev + direction + totalMatches) % totalMatches);
  }, [totalMatches]);

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

  // Only fetch when the panel is active (lazy load)
  useEffect(() => {
    if (isActive) {
      refresh();
    }
  }, [isActive, refresh]);

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

  // Reset match index when file changes
  useEffect(() => {
    setCurrentMatch(0);
  }, [selectedFile]);

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
              className={`group w-full text-left px-2 py-1 text-xs font-mono truncate flex items-center gap-2 rounded transition-colors ${
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
              <span className="truncate flex-1">{file.path}</span>
              {onEditFile && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditFile(file.path);
                  }}
                  className={`flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] px-1 rounded hover:bg-black/20 ${
                    isSelected ? "text-white/70 hover:text-white" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                  }`}
                  title="Edit file"
                >
                  Edit
                </span>
              )}
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
          <div className="flex-1 w-0 flex flex-col bg-[var(--bg-primary)]">
            {searchOpen && (
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] flex-shrink-0">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentMatch(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      navigateMatch(e.shiftKey ? -1 : 1);
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setSearchOpen(false);
                      setSearchQuery("");
                      setCurrentMatch(0);
                    }
                  }}
                  placeholder="Search in diff..."
                  className="bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-0.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] w-48"
                  autoFocus
                />
                <span className="text-[10px] text-[var(--text-tertiary)] min-w-[4rem]">
                  {searchQuery ? `${totalMatches > 0 ? currentMatch + 1 : 0}/${totalMatches}` : ""}
                </span>
                <button
                  onClick={() => navigateMatch(-1)}
                  disabled={totalMatches === 0}
                  className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 text-xs px-1"
                  title="Previous match (Shift+Enter)"
                >
                  ↑
                </button>
                <button
                  onClick={() => navigateMatch(1)}
                  disabled={totalMatches === 0}
                  className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 text-xs px-1"
                  title="Next match (Enter)"
                >
                  ↓
                </button>
                <button
                  onClick={() => {
                    setSearchOpen(false);
                    setSearchQuery("");
                    setCurrentMatch(0);
                  }}
                  className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] text-xs px-1 ml-auto"
                  title="Close (Escape)"
                >
                  ✕
                </button>
              </div>
            )}
            <div ref={diffContainerRef} className="flex-1 overflow-auto">
              {selectedFile ? (
                selectedFile.status === "??" ? (
                  <NewFileViewer content={diff} filePath={selectedFile.path} searchQuery={searchQuery} currentMatch={currentMatch} />
                ) : (
                  <DiffViewer diff={diff} mode={diffMode} filePath={selectedFile.path} searchQuery={searchQuery} currentMatch={currentMatch} />
                )
              ) : (
                <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
                  Select a file to view changes
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
