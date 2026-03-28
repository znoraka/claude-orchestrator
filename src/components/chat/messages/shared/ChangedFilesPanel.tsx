import { memo, useCallback, useEffect, useMemo, useState } from "react";
import FileIcon from "../../../FileIcon";
import type { ChangedFile } from "../../types";
import { buildDiffTree, type DiffTreeNode } from "../../../../lib/turnDiffTree";

function DiffStatLabel({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <>
      <span className="text-green-400">+{additions}</span>
      <span className="mx-0.5 text-[var(--text-tertiary)]">/</span>
      <span className="text-red-400">-{deletions}</span>
    </>
  );
}

function hasNonZeroStat(stat: { additions: number; deletions: number }): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

function collectDirectoryPaths(nodes: ReadonlyArray<DiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}

function buildExpansionState(paths: string[], expanded: boolean): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const p of paths) state[p] = expanded;
  return state;
}

export const ChangedFilesPanel = memo(function ChangedFilesPanel({
  files,
  onOpenFile,
}: {
  files: ChangedFile[];
  onOpenFile: (path: string, diff: string) => void;
}) {
  const treeNodes = useMemo(() => buildDiffTree(files), [files]);

  const directoryPathsKey = useMemo(
    () => collectDirectoryPaths(treeNodes).join("\0"),
    [treeNodes],
  );

  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>(() =>
    buildExpansionState(directoryPathsKey ? directoryPathsKey.split("\0") : [], true),
  );

  const [allExpanded, setAllExpanded] = useState(true);

  useEffect(() => {
    const paths = directoryPathsKey ? directoryPathsKey.split("\0") : [];
    setExpandedDirs(buildExpansionState(paths, allExpanded));
  }, [directoryPathsKey, allExpanded]);

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => ({ ...prev, [path]: !prev[path] }));
  }, []);

  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);

  // Build a lookup from relative path to the ChangedFile (for diff data)
  const fileByPath = useMemo(() => {
    const map = new Map<string, ChangedFile>();
    for (const f of files) map.set(f.path, f);
    return map;
  }, [files]);

  const handleFileClick = useCallback(
    (path: string) => {
      const f = fileByPath.get(path);
      if (f) onOpenFile(f.path, f.diff);
    },
    [fileByPath, onOpenFile],
  );

  const renderNode = (node: DiffTreeNode, depth: number) => {
    const leftPadding = 10 + depth * 14;

    if (node.kind === "directory") {
      const isExpanded = expandedDirs[node.path] ?? true;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            className="group flex w-full items-center gap-1.5 py-1 pr-2.5 text-left hover:bg-[var(--bg-hover)]"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDir(node.path)}
          >
            <svg
              className="w-2.5 h-2.5 text-[var(--text-tertiary)] shrink-0 transition-transform"
              style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <svg className="w-3 h-3 text-[var(--text-tertiary)] shrink-0" viewBox="0 0 16 16" fill="currentColor" fillOpacity="0.5">
              <path d="M1.75 2.5A.25.25 0 0 1 2 2.25h3.586a.25.25 0 0 1 .177.073l.707.707a.25.25 0 0 0 .177.073H14a.25.25 0 0 1 .25.25v9.5a.25.25 0 0 1-.25.25H2a.25.25 0 0 1-.25-.25v-10Z" />
            </svg>
            <span className="font-mono text-[11px] text-[var(--text-secondary)] truncate flex-1 min-w-0 group-hover:text-[var(--text-primary)]">
              {node.name}
            </span>
            {hasNonZeroStat(node.stat) && (
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
              </span>
            )}
          </button>
          {isExpanded && node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    const fileName = node.name;
    return (
      <button
        key={`file:${node.path}`}
        type="button"
        className="group flex w-full items-center gap-1.5 py-1 pr-2.5 text-left hover:bg-[var(--bg-hover)]"
        style={{ paddingLeft: `${leftPadding + 14}px` }}
        onClick={() => handleFileClick(node.path)}
      >
        <FileIcon filename={fileName} size={13} />
        <span className="font-mono text-[11px] text-[var(--text-secondary)] truncate flex-1 min-w-0 group-hover:text-[var(--text-primary)]">
          {fileName}
        </span>
        {node.stat && hasNonZeroStat(node.stat) && (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="mx-3 mb-2 mt-1 overflow-hidden text-[11px]" style={{ background: "var(--bg-secondary)", border: "2px solid var(--border-color)" }}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-subtle)]" style={{ background: "var(--bg-tertiary)" }}>
        <span className="font-medium text-[var(--text-secondary)] uppercase tracking-wider text-[10px] flex items-center gap-1.5">
          CHANGED FILES ({files.length})
          {(totalAdded > 0 || totalRemoved > 0) && (
            <>
              <span className="text-[var(--text-tertiary)] normal-case tracking-normal">&middot;</span>
              <span className="font-mono normal-case tracking-normal">
                <DiffStatLabel additions={totalAdded} deletions={totalRemoved} />
              </span>
            </>
          )}
        </span>
        <div className="flex items-center gap-3">
          {treeNodes.length > 1 && (
            <button
              onClick={() => setAllExpanded((v) => !v)}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            >
              {allExpanded ? "Collapse all" : "Expand all"}
            </button>
          )}
          <button
            onClick={() => onOpenFile(files[0].path, files[0].diff)}
            className="text-[var(--accent)] hover:opacity-80 font-medium"
          >
            View diff
          </button>
        </div>
      </div>
      <div className="py-0.5">
        {treeNodes.map((node) => renderNode(node, 0))}
      </div>
    </div>
  );
});
