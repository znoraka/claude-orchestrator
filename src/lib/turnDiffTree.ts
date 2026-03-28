export interface DiffStat {
  additions: number;
  deletions: number;
}

export interface DiffTreeDirectoryNode {
  kind: "directory";
  name: string;
  path: string;
  stat: DiffStat;
  children: DiffTreeNode[];
}

export interface DiffTreeFileNode {
  kind: "file";
  name: string;
  path: string;
  stat: DiffStat | null;
}

export type DiffTreeNode = DiffTreeDirectoryNode | DiffTreeFileNode;

interface MutableDirectoryNode {
  name: string;
  path: string;
  stat: DiffStat;
  directories: Map<string, MutableDirectoryNode>;
  files: DiffTreeFileNode[];
}

const SORT_LOCALE_OPTIONS: Intl.CollatorOptions = { numeric: true, sensitivity: "base" };

function normalizePathSegments(pathValue: string): string[] {
  return pathValue
    .split(/[/\\]/)
    .filter((segment: string) => segment.length > 0);
}

function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, SORT_LOCALE_OPTIONS);
}

function compactDirectoryNode(node: DiffTreeDirectoryNode): DiffTreeDirectoryNode {
  const compactedChildren = node.children.map((child) =>
    child.kind === "directory" ? compactDirectoryNode(child) : child,
  );

  let compactedNode: DiffTreeDirectoryNode = {
    ...node,
    children: compactedChildren,
  };

  while (compactedNode.children.length === 1 && compactedNode.children[0]?.kind === "directory") {
    const onlyChild = compactedNode.children[0];
    compactedNode = {
      kind: "directory",
      name: `${compactedNode.name}/${onlyChild.name}`,
      path: onlyChild.path,
      stat: onlyChild.stat,
      children: onlyChild.children,
    };
  }

  return compactedNode;
}

function toTreeNodes(directory: MutableDirectoryNode): DiffTreeNode[] {
  const subdirectories: DiffTreeDirectoryNode[] = Array.from(directory.directories.values())
    .sort(compareByName)
    .map((subdirectory: MutableDirectoryNode): DiffTreeDirectoryNode => ({
      kind: "directory",
      name: subdirectory.name,
      path: subdirectory.path,
      stat: {
        additions: subdirectory.stat.additions,
        deletions: subdirectory.stat.deletions,
      },
      children: toTreeNodes(subdirectory),
    }))
    .map((subdirectory: DiffTreeDirectoryNode) => compactDirectoryNode(subdirectory));

  const files = [...directory.files].sort(compareByName);
  return [...subdirectories, ...files];
}

export function buildDiffTree(files: ReadonlyArray<{ path: string; added: number; removed: number }>): DiffTreeNode[] {
  const root: MutableDirectoryNode = {
    name: "",
    path: "",
    stat: { additions: 0, deletions: 0 },
    directories: new Map(),
    files: [],
  };

  for (const file of files) {
    const segments = normalizePathSegments(file.path);
    if (segments.length === 0) continue;

    const filePath = segments.join("/");
    const fileName = segments[segments.length - 1];
    if (!fileName) continue;

    const stat: DiffStat = { additions: file.added, deletions: file.removed };
    const ancestors: MutableDirectoryNode[] = [root];
    let currentDirectory = root;

    for (const segment of segments.slice(0, -1)) {
      const nextPath = currentDirectory.path ? `${currentDirectory.path}/${segment}` : segment;
      const existing = currentDirectory.directories.get(segment);
      if (existing) {
        currentDirectory = existing;
      } else {
        const created: MutableDirectoryNode = {
          name: segment,
          path: nextPath,
          stat: { additions: 0, deletions: 0 },
          directories: new Map(),
          files: [],
        };
        currentDirectory.directories.set(segment, created);
        currentDirectory = created;
      }
      ancestors.push(currentDirectory);
    }

    currentDirectory.files.push({
      kind: "file",
      name: fileName,
      path: filePath,
      stat,
    });

    for (const ancestor of ancestors) {
      ancestor.stat.additions += stat.additions;
      ancestor.stat.deletions += stat.deletions;
    }
  }

  return toTreeNodes(root);
}
