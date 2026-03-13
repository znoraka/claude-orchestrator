interface FileMenuProps {
  suggestions: string[];
  activeIndex: number;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onHover: (i: number) => void;
  onSelect: (path: string) => void;
}

export function FileMenu({ suggestions, activeIndex, menuRef, onHover, onSelect }: FileMenuProps) {
  if (suggestions.length === 0) return null;
  return (
    <div
      ref={menuRef}
      className="mx-auto max-w-2xl mb-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg overflow-hidden z-50 max-h-64 overflow-y-auto"
    >
      {suggestions.map((filePath, i) => {
        const parts = filePath.split("/");
        const fileName = parts.pop()!;
        const dirPath = parts.join("/");
        return (
          <button
            key={filePath}
            className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-sm transition-colors ${i === activeIndex ? "bg-[var(--accent)]/15 text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onSelect(filePath); }}
          >
            <span className="font-mono text-[var(--text-primary)] truncate">{fileName}</span>
            {dirPath && (
              <span className="text-[var(--text-tertiary)] text-xs truncate ml-auto">{dirPath}/</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
