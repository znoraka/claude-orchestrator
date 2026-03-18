import { useMemo, useRef, useState, useEffect } from "react";
import { createPatch } from "diff";
import { getHighlighter, ensureLang, langFromPath, PierreDiff } from "../../DiffViewer";
import { MarkdownContent, LinkifiedText, handleLinkClick } from "./shared/MarkdownContent";
import type { ToolGroup, TodoItem } from "../types";

interface HighlightedToken { content: string; color?: string; }

function useShikiHighlight(code: string, filePath: string, containerRef: React.RefObject<HTMLElement | null>): HighlightedToken[][] | null {
  const [tokens, setTokens] = useState<HighlightedToken[][] | null>(null);
  const idRef = useRef(0);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setIsVisible(true); observer.disconnect(); } },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef]);

  useEffect(() => {
    if (!isVisible || !code) return;
    const id = ++idRef.current;
    const lang = langFromPath(filePath);
    if (!lang) {
      setTokens(code.split("\n").map(l => [{ content: l }]));
      return;
    }
    const schedule = window.requestIdleCallback || ((cb: () => void) => setTimeout(cb, 16));
    schedule(async () => {
      const hl = await getHighlighter();
      await ensureLang(hl, lang);
      const result = hl.codeToTokens(code, { lang, theme: "one-dark-pro" });
      if (id === idRef.current) {
        setTokens(result.tokens.map(lineTokens => lineTokens.map(t => ({ content: t.content, color: t.color }))));
      }
    });
  }, [code, filePath, isVisible]);

  return tokens;
}

function TokenLine({ tokens }: { tokens: HighlightedToken[] }) {
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} style={t.color ? { color: t.color } : undefined}>{t.content}</span>
      ))}
    </>
  );
}

function FileChangeView({ changes }: { changes: Array<{ kind: string; path: string }> }) {
  return (
    <div className="py-1.5 px-3 font-mono text-xs space-y-0.5">
      {changes.map((c, i) => {
        const symbol = c.kind === "add" ? "+" : c.kind === "delete" ? "-" : "~";
        const color = c.kind === "add" ? "text-green-400" : c.kind === "delete" ? "text-red-400" : "text-yellow-400";
        const short = c.path.split("/").slice(-2).join("/");
        return (
          <div key={i} className="flex gap-2 items-center">
            <span className={`${color} font-bold w-3 shrink-0`}>{symbol}</span>
            <span className="text-[var(--text-secondary)] truncate" title={c.path}>{short}</span>
          </div>
        );
      })}
    </div>
  );
}

function EditDiffView({ filePath, oldStr, newStr }: { filePath: string; oldStr: string; newStr: string }) {
  const patch = useMemo(() => createPatch(filePath, oldStr, newStr, "", "", { context: 3 }), [filePath, oldStr, newStr]);
  return <PierreDiff diff={patch} mode="unified" filePath={filePath} />;
}

function WriteContentView({ filePath, content, startLine }: { filePath: string; content: string; startLine?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => content.split("\n"), [content]);
  const tokens = useShikiHighlight(content, filePath, containerRef);
  const maxLines = 30;
  const truncated = lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;
  const displayTokens = truncated ? tokens?.slice(0, maxLines) : tokens;
  const lineOffset = (startLine ?? 1) - 1;

  return (
    <div ref={containerRef} className="font-mono text-[11px] leading-[18px] overflow-x-auto">
      <table style={{ minWidth: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {displayLines.map((line, i) => (
            <tr key={i}>
              <td className="text-[var(--text-tertiary)] w-8 text-right select-none pr-2 align-top opacity-50">{i + 1 + lineOffset}</td>
              <td className="whitespace-pre">
                {displayTokens?.[i] ? <TokenLine tokens={displayTokens[i]} /> : <span className="text-[var(--text-secondary)]">{line}</span>}
              </td>
            </tr>
          ))}
          {truncated && (
            <tr><td colSpan={2} className="text-[var(--text-tertiary)] text-center py-1 text-[10px]">… {lines.length - maxLines} more lines</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function TodoListView({ todos }: { todos: TodoItem[] }) {
  if (!Array.isArray(todos)) return null;
  return (
    <div className="px-3 py-2 space-y-1">
      {todos.map((todo, i) => {
        const statusIcon = todo.status === "completed" ? (
          <svg className="w-3.5 h-3.5 text-green-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        ) : todo.status === "in_progress" ? (
          <svg className="w-3.5 h-3.5 text-blue-400 shrink-0 animate-spin" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="10" cy="10" r="7" strokeOpacity={0.25} />
            <path d="M10 3a7 7 0 016.93 6" strokeLinecap="round" />
          </svg>
        ) : (
          <span className="block w-3.5 h-3.5 rounded-full border border-[var(--text-tertiary)] shrink-0" />
        );
        const textColor = todo.status === "completed" ? "text-[var(--text-tertiary)] line-through" :
          todo.status === "in_progress" ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-secondary)]";
        const rowBg = todo.status === "in_progress" ? "bg-[var(--bg-tertiary)] rounded" : "";
        return (
          <div key={i} className={`flex items-start gap-2 px-1.5 py-0.5 -mx-1.5 ${rowBg}`}>
            <div className="mt-0.5">{statusIcon}</div>
            <span className={`text-xs ${textColor}`}>{todo.content}</span>
          </div>
        );
      })}
    </div>
  );
}

function ToolInputView({ toolName, input }: { toolName: string; input: Record<string, unknown> }) {
  const renderValue = (key: string, value: unknown) => {
    if (value == null) return null;
    const strVal = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (typeof value === "string" && (value.includes("\n") || value.length > 100)) {
      return (
        <div key={key} className="px-3 py-1">
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">{key}</span>
          <pre className="mt-0.5 text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono bg-[var(--bg-tertiary)] rounded px-2 py-1.5 max-h-32 overflow-y-auto">{value}</pre>
        </div>
      );
    }
    return (
      <div key={key} className="flex gap-2 px-3 py-0.5 items-baseline">
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] shrink-0">{key}</span>
        <span className="text-xs text-[var(--text-secondary)] font-mono truncate"><LinkifiedText text={strVal} /></span>
      </div>
    );
  };

  switch (toolName) {
    case "Read":
      return <div className="py-1.5">{renderValue("path", input.file_path)}{input.offset != null ? renderValue("from line", input.offset) : null}{input.limit != null ? renderValue("lines", input.limit) : null}</div>;
    case "Bash":
      return <div className="py-1.5"><div className="px-3"><pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono bg-[var(--bg-tertiary)] rounded px-2 py-1.5 max-h-48 overflow-y-auto"><span className="text-[var(--text-tertiary)] select-none">$ </span>{input.command as string}</pre></div>{input.timeout != null ? renderValue("timeout", `${input.timeout}ms`) : null}</div>;
    case "Grep": {
      const ctx = [input["-B"] ? `-B ${input["-B"]}` : "", input["-A"] ? `-A ${input["-A"]}` : "", input["-C"] ? `-C ${input["-C"]}` : ""].filter(Boolean).join(" ");
      return <div className="py-1.5">{renderValue("pattern", input.pattern)}{input.path != null ? renderValue("path", input.path) : null}{input.glob != null ? renderValue("glob", input.glob) : null}{input.output_mode != null ? renderValue("mode", input.output_mode) : null}{ctx ? renderValue("context", ctx) : null}</div>;
    }
    case "Glob":
      return <div className="py-1.5">{renderValue("pattern", input.pattern)}{input.path != null ? renderValue("path", input.path) : null}</div>;
    case "WebSearch":
      return <div className="py-1.5">{renderValue("query", input.query)}</div>;
    case "WebFetch":
      return <div className="py-1.5">{renderValue("url", input.url)}{input.prompt != null ? renderValue("prompt", input.prompt) : null}</div>;
    case "LSP":
      return <div className="py-1.5">{renderValue("command", input.command)}{input.file_path != null ? renderValue("path", input.file_path) : null}{input.query != null ? renderValue("query", input.query) : null}</div>;
    case "FileChange": {
      const changes = (input.changes as Array<{ kind: string; path: string }>) ?? [];
      return <div className="py-1.5 px-3 font-mono text-xs space-y-0.5">{changes.map((c, i) => { const sym = c.kind === "add" ? "+" : c.kind === "delete" ? "-" : "~"; const col = c.kind === "add" ? "text-green-400" : c.kind === "delete" ? "text-red-400" : "text-yellow-400"; return <div key={i} className="flex gap-2 items-center"><span className={`${col} font-bold w-3 shrink-0`}>{sym}</span><span className="text-[var(--text-secondary)] truncate">{c.path.split("/").slice(-2).join("/")}</span></div>; })}</div>;
    }
    case "Agent": {
      const type = input.subagent_type as string;
      const prompt = input.prompt as string;
      return (
        <div className="py-1.5">
          {type && (
            <div className="flex gap-2 px-3 py-0.5 items-center">
              <span className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] shrink-0">type</span>
              <span className="text-xs font-medium text-sky-400 font-mono">{type}</span>
            </div>
          )}
          {prompt && renderValue("prompt", prompt)}
        </div>
      );
    }
    case "Task":
      return <div className="py-1.5">{renderValue("description", input.description)}{input.prompt != null ? renderValue("prompt", input.prompt) : null}</div>;
    default: {
      const entries = Object.entries(input);
      if (entries.length === 0) return null;
      return <div className="py-1.5">{entries.map(([k, v]) => renderValue(k, v))}</div>;
    }
  }
}

interface ToolExpandedDetailProps {
  group: ToolGroup;
  toolName: string;
  isError: boolean;
}

export function ToolExpandedDetail({ group, toolName, isError }: ToolExpandedDetailProps) {
  const input = group.toolUse.input || {};

  const resultContent = useMemo(() => {
    if (!group.toolResult) return null;
    const content = group.toolResult.content;
    return typeof content === "string" ? content : JSON.stringify(content, null, 2);
  }, [group.toolResult]);

  const readContent = useMemo(() => {
    if (toolName !== "Read" || !resultContent) return null;
    const lines = resultContent.split("\n");
    let firstLineNum = 1;
    const stripped = lines.map((line, i) => {
      const m = line.match(/^\s*(\d+)\t(.*)$/);
      if (m) { if (i === 0) firstLineNum = parseInt(m[1], 10); return m[2]; }
      return line;
    });
    return { content: stripped.join("\n"), startLine: firstLineNum };
  }, [toolName, resultContent]);

  if (toolName === "FileChange" && Array.isArray(input.changes)) {
    return <FileChangeView changes={input.changes as Array<{ kind: string; path: string }>} />;
  }
  if (toolName === "Edit" && input.file_path && input.old_string != null && input.new_string != null) {
    return <div className="py-1"><EditDiffView filePath={input.file_path as string} oldStr={input.old_string as string} newStr={input.new_string as string} /></div>;
  }
  if (toolName === "Write" && input.file_path && input.content) {
    const filePath = input.file_path as string;
    const content = input.content as string;
    if (filePath.includes(".claude/plans/")) {
      const lines = content.split("\n").map((l) => `+${l}`).join("\n");
      const patch = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${content.split("\n").length} @@\n${lines}`;
      return <div className="py-1"><PierreDiff diff={patch} mode="unified" filePath={filePath} /></div>;
    }
    return <div className="py-1"><WriteContentView filePath={filePath} content={content} /></div>;
  }
  if (toolName === "Read" && readContent && input.file_path) {
    return <div className="py-1"><WriteContentView filePath={input.file_path as string} content={readContent.content} startLine={readContent.startLine} /></div>;
  }
  if (toolName === "TodoWrite" && Array.isArray(input.todos)) {
    return <TodoListView todos={input.todos as TodoItem[]} />;
  }
  if (toolName === "ExitPlanMode" && resultContent) {
    return <div className="px-4 pt-3 pb-3 text-sm text-[var(--text-primary)] overflow-y-auto max-h-96"><MarkdownContent text={resultContent} /></div>;
  }
  if (resultContent) {
    return (
      <>
        <ToolInputView toolName={toolName} input={input} />
        <div
          className={`mx-3 mb-2 px-3 py-2 rounded text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto ${isError ? "bg-red-500/10 text-red-400 border border-red-500/20" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"}`}
          onClick={handleLinkClick}
        >
          <LinkifiedText text={resultContent} />
        </div>
      </>
    );
  }
  return <ToolInputView toolName={toolName} input={input} />;
}
