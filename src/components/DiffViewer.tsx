import { useState, useEffect, useRef, useMemo, Fragment } from "react";
import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";
import type { PrComment } from "../types";

// --- Types ---

export type DiffMode = "unified" | "split";

export interface DiffLine {
  type: "context" | "add" | "remove" | "hunk" | "header";
  content: string;
}

export function classifyLine(line: string): DiffLine {
  if (line.startsWith("+++") || line.startsWith("---"))
    return { type: "header", content: line };
  if (line.startsWith("@@")) return { type: "hunk", content: line };
  if (line.startsWith("+")) return { type: "add", content: line.slice(1) };
  if (line.startsWith("-")) return { type: "remove", content: line.slice(1) };
  return { type: "context", content: line.startsWith(" ") ? line.slice(1) : line };
}

// --- Shiki highlighter singleton ---

export const EXT_TO_LANG: Record<string, string> = {
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

export function langFromPath(filePath: string): BundledLanguage | null {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile" as BundledLanguage;
  if (name === "makefile" || name === "gnumakefile") return "makefile" as BundledLanguage;
  const ext = name.split(".").pop() ?? "";
  return (EXT_TO_LANG[ext] as BundledLanguage) ?? null;
}

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

export async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark"],
      langs: [],
    });
  }
  return highlighterPromise;
}

export async function ensureLang(hl: Highlighter, lang: string): Promise<void> {
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

// --- Search highlight helpers ---

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

  const matches: number[] = [];
  let pos = lower.indexOf(qLower);
  while (pos !== -1) {
    matches.push(pos);
    pos = lower.indexOf(qLower, pos + qLower.length);
  }
  if (matches.length === 0) return { node: <TokenSpan tokens={tokens} />, matchCount: 0 };

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

export function countMatches(text: string, query: string): number {
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

// --- Diff backgrounds ---

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

const FALLBACK_COLOR: Record<DiffLine["type"], string> = {
  context: "text-[var(--text-secondary)]",
  add: "text-green-400",
  remove: "text-red-400",
  hunk: "text-cyan-400",
  header: "text-[var(--text-tertiary)] font-bold",
};

// --- Inline comment props & helpers ---

export interface InlineCommentProps {
  comments: PrComment[];
  commentLine: number | null;
  commentText: string;
  onCommentTextChange: (text: string) => void;
  onPostComment: () => void;
  onCancelComment: () => void;
  posting: boolean;
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function InlineCommentBubbles({ comments, colSpan }: { comments: PrComment[]; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-0 py-0">
        <div className="border-y border-[var(--border-color)] bg-[var(--bg-secondary)]">
          {comments.map((c) => (
            <div key={c.id} className="px-3 py-1.5 text-xs border-b border-[var(--border-color)] last:border-b-0">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-[var(--text-primary)]">{c.user}</span>
                <span className="text-[var(--text-tertiary)] text-[10px]">{relativeTime(c.createdAt)}</span>
              </div>
              <div
                className="text-[var(--text-secondary)] mt-0.5 whitespace-pre-wrap pr-comment-body"
                dangerouslySetInnerHTML={{ __html: c.bodyHtml }}
              />
            </div>
          ))}
        </div>
      </td>
    </tr>
  );
}

function InlineCommentInput({ commentText, onCommentTextChange, onPostComment, onCancelComment, posting, colSpan }: {
  commentText: string; onCommentTextChange: (text: string) => void;
  onPostComment: () => void; onCancelComment: () => void; posting: boolean; colSpan: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <tr>
      <td colSpan={colSpan} className="px-0 py-0">
        <div className="border-y border-[var(--accent)]/40 bg-[var(--bg-secondary)] px-3 py-2">
          <textarea
            ref={ref}
            value={commentText}
            onChange={(e) => onCommentTextChange(e.target.value)}
            placeholder="Write a review comment... (Cmd+Enter to submit)"
            className="w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] resize-none"
            rows={3}
            onKeyDown={(e) => {
              if (e.metaKey && e.key === "Enter") { e.preventDefault(); onPostComment(); }
              if (e.key === "Escape") onCancelComment();
            }}
          />
          <div className="flex items-center justify-end gap-1.5 mt-1">
            <button
              onClick={onCancelComment}
              className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors px-1.5 py-0.5"
            >
              Cancel
            </button>
            <button
              onClick={onPostComment}
              disabled={!commentText.trim() || posting}
              className="text-[10px] text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors px-2 py-0.5 rounded font-medium"
            >
              {posting ? "..." : "Comment"}
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

// --- Unified diff ---

export function UnifiedDiff({ diff, filePath, searchQuery, currentMatch, onLineClick, inlineComments }: {
  diff: string; filePath: string; searchQuery: string; currentMatch: number;
  onLineClick?: (lineNumber: number) => void;
  inlineComments?: InlineCommentProps;
}) {
  const classified = useMemo(() => diff.split("\n").map(classifyLine), [diff]);
  const contentLines = useMemo(() => classified.map((l) => l.content), [classified]);
  const highlighted = useHighlightedLines(contentLines, filePath);

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

  // Parse line numbers from hunk headers
  const lineNumbers = useMemo(() => {
    let newLine = 0;
    return classified.map((line) => {
      if (line.type === "hunk") {
        const match = line.content.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
        if (match) newLine = parseInt(match[1], 10);
        return null;
      }
      if (line.type === "header") return null;
      if (line.type === "remove") return null;
      const num = newLine;
      if (line.type === "add" || line.type === "context") newLine++;
      return num;
    });
  }, [classified]);

  // Group comments by line number for quick lookup
  const commentsByLine = useMemo(() => {
    if (!inlineComments) return new Map<number, PrComment[]>();
    const map = new Map<number, PrComment[]>();
    for (const c of inlineComments.comments) {
      const arr = map.get(c.line) || [];
      arr.push(c);
      map.set(c.line, arr);
    }
    return map;
  }, [inlineComments?.comments]);

  // Comments that don't map to any visible line (fallback to top)
  const unmappedComments = useMemo(() => {
    if (!inlineComments) return [];
    const visibleLines = new Set(lineNumbers.filter((n): n is number => n !== null));
    return inlineComments.comments.filter((c) => !visibleLines.has(c.line));
  }, [inlineComments?.comments, lineNumbers]);

  return (
    <div className="font-mono text-xs leading-5 overflow-auto h-full py-2">
      <table className="diff-table" style={{ minWidth: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {/* Unmapped comments shown at top */}
          {unmappedComments.length > 0 && (
            <InlineCommentBubbles comments={unmappedComments} colSpan={2} />
          )}
          {classified.map((line, i) => {
            const tokens = highlighted?.[i];
            const isCode = line.type === "context" || line.type === "add" || line.type === "remove";
            const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
            const baseIdx = cumulativeMatchCounts[i];
            const lineNum = lineNumbers[i];

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

            const lineComments = lineNum !== null ? commentsByLine.get(lineNum) : undefined;
            const showInput = inlineComments && inlineComments.commentLine === lineNum && lineNum !== null;

            return (
              <Fragment key={i}>
                <tr className={`${BG[line.type]} diff-row`}>
                  <td
                    className={`${GUTTER_COLOR[line.type]} w-6 text-center select-none whitespace-pre relative group/gutter ${onLineClick && lineNum ? "cursor-pointer" : ""}`}
                    onClick={onLineClick && lineNum ? () => onLineClick(lineNum) : undefined}
                  >
                    {onLineClick && lineNum ? (
                      <>
                        <span className="group-hover/gutter:hidden">{prefix}</span>
                        <span className="hidden group-hover/gutter:inline text-[var(--accent)] font-bold">+</span>
                      </>
                    ) : (
                      prefix
                    )}
                  </td>
                  <td className={`${tokens ? "" : FALLBACK_COLOR[line.type]} whitespace-pre`}>
                    {renderContent()}
                  </td>
                </tr>
                {lineComments && lineComments.length > 0 && (
                  <InlineCommentBubbles comments={lineComments} colSpan={2} />
                )}
                {showInput && (
                  <InlineCommentInput
                    commentText={inlineComments.commentText}
                    onCommentTextChange={inlineComments.onCommentTextChange}
                    onPostComment={inlineComments.onPostComment}
                    onCancelComment={inlineComments.onCancelComment}
                    posting={inlineComments.posting}
                    colSpan={2}
                  />
                )}
              </Fragment>
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

export function buildSplitPairs(diff: string): SplitPair[] {
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

export function SplitDiff({ diff, filePath, searchQuery, currentMatch, onLineClick, inlineComments }: {
  diff: string; filePath: string; searchQuery: string; currentMatch: number;
  onLineClick?: (lineNumber: number) => void;
  inlineComments?: InlineCommentProps;
}) {
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

  // Compute new-side line numbers for each pair (for comment placement)
  const pairLineNumbers = useMemo(() => {
    let newLine = 0;
    return pairs.map((pair) => {
      if (pair.type === "hunk") {
        const match = (pair.left?.content ?? "").match(/@@ -\d+(?:,\d+)? \+(\d+)/);
        if (match) newLine = parseInt(match[1], 10);
        return null;
      }
      if (pair.type === "header") return null;
      // For change pairs with only a left (remove) side, no new line number
      if (pair.right === null) return null;
      const num = newLine;
      if (pair.right.type === "add" || pair.right.type === "context") newLine++;
      return num;
    });
  }, [pairs]);

  // Group comments by line number
  const commentsByLine = useMemo(() => {
    if (!inlineComments) return new Map<number, PrComment[]>();
    const map = new Map<number, PrComment[]>();
    for (const c of inlineComments.comments) {
      const arr = map.get(c.line) || [];
      arr.push(c);
      map.set(c.line, arr);
    }
    return map;
  }, [inlineComments?.comments]);

  // Unmapped comments
  const unmappedComments = useMemo(() => {
    if (!inlineComments) return [];
    const visibleLines = new Set(pairLineNumbers.filter((n): n is number => n !== null));
    return inlineComments.comments.filter((c) => !visibleLines.has(c.line));
  }, [inlineComments?.comments, pairLineNumbers]);

  return (
    <div className="font-mono text-xs leading-5 overflow-auto h-full py-2">
      <table style={{ minWidth: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {unmappedComments.length > 0 && (
            <InlineCommentBubbles comments={unmappedComments} colSpan={4} />
          )}
          {pairs.map((pair, i) => {
            const lineNum = pairLineNumbers[i];

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

            const lineComments = lineNum !== null ? commentsByLine.get(lineNum) : undefined;
            const showInput = inlineComments && inlineComments.commentLine === lineNum && lineNum !== null;

            return (
              <Fragment key={i}>
                <tr>
                  <td className={`${BG[lType]} ${GUTTER_COLOR[lType]} w-5 text-center select-none whitespace-pre`}>{pair.left ? lPrefix : ""}</td>
                  <td className={`${BG[lType]} whitespace-pre border-r border-[var(--border-color)] ${lTok ? "" : FALLBACK_COLOR[lType]}`} style={{ width: '50%' }}>
                    {renderLeft()}
                  </td>
                  <td
                    className={`${BG[rType]} ${GUTTER_COLOR[rType]} w-5 text-center select-none whitespace-pre relative group/gutter ${onLineClick && lineNum ? "cursor-pointer" : ""}`}
                    onClick={onLineClick && lineNum ? () => onLineClick(lineNum) : undefined}
                  >
                    {onLineClick && lineNum ? (
                      <>
                        <span className="group-hover/gutter:hidden">{pair.right ? rPrefix : ""}</span>
                        <span className="hidden group-hover/gutter:inline text-[var(--accent)] font-bold">+</span>
                      </>
                    ) : (
                      pair.right ? rPrefix : ""
                    )}
                  </td>
                  <td className={`${BG[rType]} whitespace-pre ${rTok ? "" : FALLBACK_COLOR[rType]}`} style={{ width: '50%' }}>
                    {renderRight()}
                  </td>
                </tr>
                {lineComments && lineComments.length > 0 && (
                  <InlineCommentBubbles comments={lineComments} colSpan={4} />
                )}
                {showInput && (
                  <InlineCommentInput
                    commentText={inlineComments.commentText}
                    onCommentTextChange={inlineComments.onCommentTextChange}
                    onPostComment={inlineComments.onPostComment}
                    onCancelComment={inlineComments.onCancelComment}
                    posting={inlineComments.posting}
                    colSpan={4}
                  />
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- DiffViewer ---

export default function DiffViewer({ diff, mode, filePath, searchQuery, currentMatch, onLineClick, inlineComments }: {
  diff: string; mode: DiffMode; filePath: string; searchQuery: string; currentMatch: number;
  onLineClick?: (lineNumber: number) => void;
  inlineComments?: InlineCommentProps;
}) {
  if (!diff) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
        No changes to display
      </div>
    );
  }

  return mode === "split"
    ? <SplitDiff diff={diff} filePath={filePath} searchQuery={searchQuery} currentMatch={currentMatch} onLineClick={onLineClick} inlineComments={inlineComments} />
    : <UnifiedDiff diff={diff} filePath={filePath} searchQuery={searchQuery} currentMatch={currentMatch} onLineClick={onLineClick} inlineComments={inlineComments} />;
}

// --- New file viewer with syntax highlighting ---

export function NewFileViewer({ content, filePath, searchQuery, currentMatch }: { content: string; filePath: string; searchQuery: string; currentMatch: number }) {
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
