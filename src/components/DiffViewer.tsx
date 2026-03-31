import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";
import { PatchDiff } from "@pierre/diffs/react";
import type { PrComment, BlameLine } from "../types";

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
      themes: ["pierre-dark"],
      langs: [],
    });
  }
  return highlighterPromise;
}

// Eager-init: start loading the highlighter as soon as this module is imported
getHighlighter();

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

// --- Inline comment props ---

export interface InlineCommentProps {
  comments: PrComment[];
  commentLine: number | null;
  commentText: string;
  onCommentTextChange: (text: string) => void;
  onPostComment: () => void;
  onCancelComment: () => void;
  posting: boolean;
}

// --- CSS for the diff panel (adapted from t3code) ---

export const DIFF_UNSAFE_CSS = `
  diffs-container {
    --diffs-dark-bg: #0c0e14;
    --diffs-font-family: "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    --diffs-font-size: 12px;
    --diffs-line-height: 20px;
  }
`;

// --- Relative time helper ---

function relativeTime(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

// --- Blame hover bridge ---
// Polls Pierre's getHoveredLine and writes the blame to a ref so the parent can read it.

function BlameHoverBridge({ getHoveredLine, blameMap, onBlameChange }: {
  getHoveredLine: () => { lineNumber: number; side: string } | undefined;
  blameMap: Map<number, BlameLine>;
  onBlameChange: (blame: BlameLine | null) => void;
}) {
  useEffect(() => {
    let prev: string | null = null;
    let raf: number;
    const poll = () => {
      const hovered = getHoveredLine();
      const b = hovered ? (blameMap.get(hovered.lineNumber) ?? null) : null;
      const key = b?.sha ?? null;
      if (key !== prev) { prev = key; onBlameChange(b); }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => { cancelAnimationFrame(raf); onBlameChange(null); };
  }, [getHoveredLine, blameMap, onBlameChange]);

  return null; // renders nothing inside the diff
}

// --- PatchDiff wrapper ---

export function PierreDiff({ diff, mode, filePath, blameMap, onBlameHover }: {
  diff: string;
  mode: DiffMode;
  filePath: string;
  blameMap?: Map<number, BlameLine>;
  onBlameHover?: (blame: BlameLine | null) => void;
}) {
  // Ensure the patch has proper git diff headers for @pierre/diffs to parse
  const patch = useMemo(() => {
    if (diff.startsWith("diff --git")) return diff;
    // Wrap raw hunks in a minimal git diff header
    return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n${diff}`;
  }, [diff, filePath]);

  const hasBlame = !!blameMap && blameMap.size > 0 && !!onBlameHover;

  const renderHoverUtility = useCallback(
    (getHoveredLine: () => { lineNumber: number; side: string } | undefined) => {
      if (!blameMap || blameMap.size === 0 || !onBlameHover) return null;
      return <BlameHoverBridge getHoveredLine={getHoveredLine} blameMap={blameMap} onBlameChange={onBlameHover} />;
    },
    [blameMap, onBlameHover]
  );

  return (
    <PatchDiff
      patch={patch}
      options={{
        theme: "pierre-dark",
        diffStyle: mode === "split" ? "split" : "unified",
        diffIndicators: "classic",
        overflow: "scroll",
        themeType: "dark",
        disableFileHeader: true,
        unsafeCSS: DIFF_UNSAFE_CSS,
        enableHoverUtility: hasBlame,
      }}
      renderHoverUtility={hasBlame ? renderHoverUtility : undefined}
    />
  );
}

// --- Lazy hunk rendering ---

const LAZY_THRESHOLD = 200; // lines — below this, render directly

function splitIntoHunks(diffText: string): string[] {
  const lines = diffText.split("\n");
  const chunks: string[] = [];
  const header: string[] = [];
  let current: string[] = [];
  let inHeader = true;

  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      if (inHeader) {
        inHeader = false;
      } else {
        chunks.push([...header, ...current].join("\n"));
        current = [];
      }
    }
    if (inHeader) header.push(line);
    else current.push(line);
  }
  if (current.length) chunks.push([...header, ...current].join("\n"));
  return chunks;
}

function LazyHunk({ hunk, mode, filePath, blameMap, onBlameHover }: { hunk: string; mode: DiffMode; filePath: string; blameMap?: Map<number, BlameLine>; onBlameHover?: (blame: BlameLine | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { rootMargin: "400px" }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  const estimatedHeight = hunk.split("\n").length * 20;
  return (
    <div ref={ref} style={{ minHeight: visible ? undefined : estimatedHeight }}>
      {visible && <PierreDiff diff={hunk} mode={mode} filePath={filePath} blameMap={blameMap} onBlameHover={onBlameHover} />}
    </div>
  );
}

function LazyPatchDiff({ diff, mode, filePath, blameMap, onBlameHover }: { diff: string; mode: DiffMode; filePath: string; blameMap?: Map<number, BlameLine>; onBlameHover?: (blame: BlameLine | null) => void }) {
  const lineCount = diff.split("\n").length;
  if (lineCount < LAZY_THRESHOLD) {
    return <PierreDiff diff={diff} mode={mode} filePath={filePath} blameMap={blameMap} onBlameHover={onBlameHover} />;
  }
  const hunks = splitIntoHunks(diff);
  return (
    <div>
      {hunks.map((hunk, i) => (
        <LazyHunk key={i} hunk={hunk} mode={mode} filePath={filePath} blameMap={blameMap} onBlameHover={onBlameHover} />
      ))}
    </div>
  );
}

// --- Truncated diff (for ContextRail) ---

const TRUNCATE_LINES = 150;

function TruncatedUnifiedDiff({ diff, filePath }: { diff: string; filePath: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => diff.split("\n"), [diff]);
  const truncated = !expanded && lines.length > TRUNCATE_LINES;
  const displayDiff = truncated ? lines.slice(0, TRUNCATE_LINES).join("\n") : diff;

  return (
    <div>
      <PierreDiff diff={displayDiff} mode="unified" filePath={filePath} />
      {truncated && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] py-2 border-t border-[var(--border-subtle)]"
        >
          Show {lines.length - TRUNCATE_LINES} more lines…
        </button>
      )}
    </div>
  );
}

// --- DiffViewer ---

export default function DiffViewer({ diff, mode, filePath, blameMap, inlineComments: _inlineComments }: {
  diff: string; mode: DiffMode; filePath: string; searchQuery: string; currentMatch: number;
  blameMap?: Map<number, BlameLine>;
  onLineClick?: (lineNumber: number) => void;
  inlineComments?: InlineCommentProps;
}) {
  const [hoveredBlame, setHoveredBlame] = useState<BlameLine | null>(null);
  const onBlameHover = useCallback((b: BlameLine | null) => setHoveredBlame(b), []);

  if (!diff) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-sm">
        No changes to display
      </div>
    );
  }

  return (
    <div className="diff-panel-viewport h-full flex flex-col">
      <div className="flex-1 overflow-auto">
        <div className="diff-render-file">
          <LazyPatchDiff diff={diff} mode={mode} filePath={filePath} blameMap={blameMap} onBlameHover={onBlameHover} />
        </div>
      </div>
      {hoveredBlame && (
        <div
          className="flex items-center gap-2 px-3 flex-shrink-0 border-t border-[var(--border-color)]"
          style={{
            height: 28,
            fontSize: 11,
            fontFamily: "var(--font-mono, monospace)",
            color: "var(--text-secondary)",
            background: "var(--bg-secondary)",
          }}
        >
          <span style={{ color: "var(--accent)", fontWeight: 600 }}>
            {hoveredBlame.sha.slice(0, 8)}
          </span>
          <span style={{ color: "var(--text-primary)" }}>
            {hoveredBlame.author}
          </span>
          <span style={{ opacity: 0.5 }}>
            {relativeTime(hoveredBlame.date)}
          </span>
        </div>
      )}
    </div>
  );
}

// --- Unified diff export (for ContextRail) ---

export function UnifiedDiff({ diff, filePath }: {
  diff: string; filePath: string; searchQuery: string; currentMatch: number;
  onLineClick?: (lineNumber: number) => void;
  inlineComments?: InlineCommentProps;
}) {
  return (
    <div className="diff-panel-viewport">
      <TruncatedUnifiedDiff diff={diff} filePath={filePath} />
    </div>
  );
}

// --- New file viewer ---

export function NewFileViewer({ content, filePath }: { content: string; filePath: string; searchQuery: string; currentMatch: number }) {
  // Convert raw content to a unified diff (all lines are additions)
  const patch = useMemo(() => {
    const lines = content.split("\n").map((l) => `+${l}`).join("\n");
    return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${content.split("\n").length} @@\n${lines}`;
  }, [content, filePath]);

  return (
    <div className="diff-panel-viewport">
      <div className="diff-render-file">
        <PatchDiff
          patch={patch}
          options={{
            theme: "pierre-dark",
            diffStyle: "unified",
            diffIndicators: "classic",
            overflow: "scroll",
            themeType: "dark",
            disableFileHeader: true,
            unsafeCSS: DIFF_UNSAFE_CSS,
          }}
        />
      </div>
    </div>
  );
}
