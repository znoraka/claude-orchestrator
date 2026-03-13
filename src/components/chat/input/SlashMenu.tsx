interface SlashMenuProps {
  commands: Array<{ name: string; description: string; source: string }>;
  activeIndex: number;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onHover: (i: number) => void;
  onSelect: (cmd: { name: string }) => void;
}

export function SlashMenu({ commands, activeIndex, menuRef, onHover, onSelect }: SlashMenuProps) {
  if (commands.length === 0) return null;
  return (
    <div
      ref={menuRef}
      className="mx-auto max-w-2xl mb-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg overflow-hidden z-50 max-h-64 overflow-y-auto"
    >
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          className={`w-full text-left px-3 py-2 flex items-baseline gap-4 text-sm transition-colors ${i === activeIndex ? "bg-[var(--accent)]/15 text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => { e.preventDefault(); onSelect(cmd); }}
        >
          <span className="font-mono text-[var(--accent)] shrink-0">/{cmd.name}</span>
          <span className="text-[var(--text-tertiary)] truncate text-xs">{cmd.description}</span>
          {cmd.source === "user" && (
            <span className="text-[10px] text-[var(--text-tertiary)] opacity-60 ml-auto shrink-0">(user)</span>
          )}
        </button>
      ))}
    </div>
  );
}
