import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "../../../../lib/bridge";

// Configure marked once
marked.setOptions({ breaks: true, gfm: true });

marked.use({
  renderer: {
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<a href="${href}" class="text-[var(--accent)] underline" target="_blank" rel="noreferrer">${text}</a>`;
    },
  },
});

const markedOptions = {};

const URL_RE = /(https?:\/\/[^\s<>'")\]]+)/g;

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

export function MarkdownContent({ text }: { text: string }) {
  const html = useMemo(() => {
    const unescaped = text.replace(/\\n/g, "\n");
    const cleaned = unescaped.replace(/<\/?[a-z]+-[a-z-]*>/g, "");
    const raw = marked.parse(cleaned, markedOptions) as string;
    return DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
  }, [text]);

  return (
    <div
      className="text-sm text-[var(--text-primary)] prose-agent max-w-[680px]"
      onClick={handleLinkClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
