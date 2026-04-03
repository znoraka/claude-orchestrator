import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import { CheckIcon, CopyIcon } from "lucide-react";
import React, {
  Children,
  Suspense,
  isValidElement,
  use,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "../../../../lib/bridge";
import { resolveDiffThemeName, type DiffThemeName } from "../../../../lib/diffRendering";
import { useOpenFile } from "../../OpenFileContext";
import { fnv1a32 } from "../../../../lib/diffRendering";
import { LRUCache } from "../../../../lib/lruCache";

// ── Error boundary ────────────────────────────────────────────────────────────

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

// ── Constants & cache ─────────────────────────────────────────────────────────

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

// Dark-only: orchestrator always runs in dark mode
const THEME_NAME = resolveDiffThemeName("dark");

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  return raw === "gitignore" ? "ini" : raw;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(onlyChild)) {
    return null;
  }
  // Accept the native "code" element OR a custom component substituting it.
  // When a `code` component override is provided, react-markdown passes the
  // function as the element type instead of the string "code".
  if (typeof onlyChild.type === "string" && onlyChild.type !== "code") {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [THEME_NAME],
    langs: [language as SupportedLanguages],
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      throw err;
    }
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

// ── Link helpers ──────────────────────────────────────────────────────────────

const URL_RE = /(https?:\/\/[^\s<>'")\]]+)/g;

// Matches file paths with an extension: src/App.tsx, ./foo/bar.js, /abs/path.rs, review-helpers.js
const FILE_PATH_RE = /^(\.{0,2}\/)?([a-zA-Z0-9_@.-]+\/)*[a-zA-Z0-9_@.-]+\.[a-zA-Z0-9]{1,10}(:\d+)?$/;

/** Intercept <a> clicks and open in default browser via Tauri */
export function handleLinkClick(e: React.MouseEvent<HTMLDivElement | HTMLSpanElement>) {
  const target = (e.target as HTMLElement).closest("a");
  if (target?.href) {
    e.preventDefault();
    openUrl(target.href);
  }
}

/** Render plain text with URLs converted to clickable links */
export function LinkifiedText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => {
    const result: (string | { url: string })[] = [];
    let lastIndex = 0;
    for (const match of text.matchAll(URL_RE)) {
      if (match.index > lastIndex) result.push(text.slice(lastIndex, match.index));
      result.push({ url: match[0] });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) result.push(text.slice(lastIndex));
    return result;
  }, [text]);

  return (
    <span className={className} onClick={handleLinkClick}>
      {parts.map((p, i) =>
        typeof p === "string" ? p : (
          <a key={i} href={p.url} className="text-[var(--accent)] underline">
            {p.url}
          </a>
        )
      )}
    </span>
  );
}

// ── Code block components ─────────────────────────────────────────────────────

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock">
      <button
        type="button"
        className="chat-markdown-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy code"}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {children}
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  isStreaming: boolean;
}

function SuspenseShikiCodeBlock({ className, code, isStreaming }: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, THEME_NAME);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  const highlighter = use(getHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: THEME_NAME });
    } catch (error) {
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      return highlighter.codeToHtml(code, { lang: "text", theme: THEME_NAME });
    }
  }, [code, highlighter, language]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

// ── Main component ────────────────────────────────────────────────────────────

function MarkdownContentInner({ text, isStreaming = false }: { text: string; isStreaming?: boolean }) {
  const openFile = useOpenFile();

  const markdownComponents = useMemo<Components>(
    () => ({
      code({ node: _node, className, children, ...props }) {
        // Block code (inside <pre>) has a className like "language-xxx" — skip it
        if (className) return <code className={className} {...props}>{children}</code>;
        const text = typeof children === "string" ? children : "";
        if (openFile && FILE_PATH_RE.test(text.trim())) {
          return (
            <button
              type="button"
              className="font-mono text-blue-400 hover:text-blue-300 hover:underline cursor-pointer bg-transparent border-0 p-0 text-[0.85em]"
              title={`Open ${text} in editor`}
              onClick={() => openFile(text.trim().replace(/:\d+$/, ""))}
            >
              {children}
            </button>
          );
        }
        return <code className={className} {...props}>{children}</code>;
      },
      a({ node: _node, href, ...props }) {
        return (
          <a
            {...props}
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              if (href) {
                e.preventDefault();
                openUrl(href);
              }
            }}
          />
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        return (
          <MarkdownCodeBlock code={codeBlock.code}>
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  isStreaming={isStreaming}
                />
              </Suspense>
            </CodeHighlightErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
    }),
    [isStreaming, openFile],
  );

  const processedText = useMemo(() => {
    const unescaped = text.replace(/\\n/g, "\n");
    return unescaped.replace(/<\/?[a-z]+-[a-z-]*>/g, "");
  }, [text]);

  return (
    <div className="chat-markdown text-sm text-[var(--text-primary)">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {processedText}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownContent = memo(MarkdownContentInner);
