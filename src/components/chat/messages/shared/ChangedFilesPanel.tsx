import { useState } from "react";
import FileIcon from "../../../FileIcon";
import type { ChangedFile } from "../../types";

export function ChangedFilesPanel({ files, onOpenFile }: { files: ChangedFile[]; onOpenFile: (path: string, diff: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = (() => {
    const map = new Map<string, ChangedFile[]>();
    for (const f of files) {
      const slash = f.path.indexOf("/");
      const dir = slash === -1 ? "" : f.path.slice(0, slash);
      const key = dir || "";
      const arr = map.get(key) ?? [];
      arr.push(f);
      map.set(key, arr);
    }
    return map;
  })();

  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);
  const allCollapsed = collapsed.size === groups.size && groups.size > 0;

  const toggleAll = () => {
    if (allCollapsed) setCollapsed(new Set());
    else setCollapsed(new Set(groups.keys()));
  };

  return (
    <div className="mx-3 mb-2 mt-1 rounded-md overflow-hidden text-[11px]" style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-subtle)" }}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-subtle)]" style={{ background: "var(--bg-tertiary)" }}>
        <span className="font-medium text-[var(--text-secondary)] uppercase tracking-wider text-[10px] flex items-center gap-1.5">
          CHANGED FILES ({files.length})
          {(totalAdded > 0 || totalRemoved > 0) && (
            <>
              <span className="text-[var(--text-tertiary)] normal-case tracking-normal">•</span>
              <span className="font-mono normal-case tracking-normal">
                <span className="text-green-400">+{totalAdded}</span>
                <span className="text-[var(--text-tertiary)]">/</span>
                <span className="text-red-400">-{totalRemoved}</span>
              </span>
            </>
          )}
        </span>
        <div className="flex items-center gap-3">
          {groups.size > 1 && (
            <button onClick={toggleAll} className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors">
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
          )}
          <button
            onClick={() => onOpenFile(files[0].path, files[0].diff)}
            className="text-[var(--accent)] hover:opacity-80 transition-opacity font-medium"
          >
            View diff
          </button>
        </div>
      </div>
      {Array.from(groups.entries()).map(([dir, groupFiles]) => {
        const isCollapsed = collapsed.has(dir);
        const groupAdded = groupFiles.reduce((s, f) => s + f.added, 0);
        const groupRemoved = groupFiles.reduce((s, f) => s + f.removed, 0);
        const hasDir = dir !== "";
        return (
          <div key={dir || "__root__"}>
            {hasDir && (
              <button
                onClick={() => setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(dir)) next.delete(dir); else next.add(dir);
                  return next;
                })}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-[var(--bg-hover)] transition-colors border-b border-[var(--border-subtle)]"
              >
                <svg
                  className="w-2.5 h-2.5 text-[var(--text-tertiary)] shrink-0 transition-transform"
                  style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
                  viewBox="0 0 16 16" fill="currentColor"
                >
                  <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <svg className="w-3 h-3 text-[var(--text-tertiary)] shrink-0" viewBox="0 0 16 16" fill="currentColor" fillOpacity="0.5">
                  <path d="M1.75 2.5A.25.25 0 0 1 2 2.25h3.586a.25.25 0 0 1 .177.073l.707.707a.25.25 0 0 0 .177.073H14a.25.25 0 0 1 .25.25v9.5a.25.25 0 0 1-.25.25H2a.25.25 0 0 1-.25-.25v-10Z" />
                </svg>
                <span className="font-mono text-[var(--text-secondary)] flex-1 min-w-0 truncate">{dir}</span>
                {(groupAdded > 0 || groupRemoved > 0) && (
                  <span className="font-mono ml-2 shrink-0">
                    <span className="text-green-400">+{groupAdded}</span>
                    <span className="text-[var(--text-tertiary)]">/</span>
                    <span className="text-red-400">-{groupRemoved}</span>
                  </span>
                )}
              </button>
            )}
            {!isCollapsed && groupFiles.map((f) => {
              const parts = f.path.split("/");
              const filename = parts[parts.length - 1];
              return (
                <button
                  key={f.path}
                  onClick={() => onOpenFile(f.path, f.diff)}
                  className="w-full flex items-center gap-1.5 text-left hover:bg-[var(--bg-hover)] transition-colors group border-b border-[var(--border-subtle)] last:border-b-0"
                  style={{ paddingLeft: hasDir ? "2rem" : "0.75rem", paddingRight: "0.75rem", paddingTop: "0.375rem", paddingBottom: "0.375rem" }}
                >
                  <FileIcon filename={filename} size={13} />
                  <span className="font-mono text-[var(--text-secondary)] flex-1 min-w-0 truncate">{filename}</span>
                  {(f.added > 0 || f.removed > 0) && (
                    <span className="font-mono ml-2 shrink-0">
                      <span className="text-green-400">+{f.added}</span>
                      <span className="text-[var(--text-tertiary)]">/</span>
                      <span className="text-red-400">-{f.removed}</span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
