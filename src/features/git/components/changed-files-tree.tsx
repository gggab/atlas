import { memo, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronDown, GitCommit } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQuery } from "@tanstack/react-query";
import { useGitStore } from "../stores/git-store";
import { gitCommitChangedFiles } from "../lib/git-diff-api";

const TREE_ROW_H = 22;

interface ChangedFilesTreeProps {
  repoPath: string;
  /** Filter repository status rows by staged-ness. */
  staged: boolean;
  /** Path of the file currently shown in the diff pane (highlighted). */
  currentFile: string;
  /** Optional fixed commit supplied by the host viewer. */
  commit?: string | null;
  /** When set, list ONLY these (repo-relative) paths. The chat's modal scopes
   *  the tree to what a single turn touched; without it the tree answers a
   *  different question — everything dirty in the repo. */
  only?: string[];
  /** Select a file in the host viewer without creating a workbench tab. */
  onSelect: (path: string) => void;
}

interface DirNode {
  name: string;
  path: string;
  isDir: true;
  children: TreeNode[];
}
interface FileNode {
  name: string;
  path: string;
  isDir: false;
  status: string;
}
type TreeNode = DirNode | FileNode;

/** First porcelain char → a tint. Mirrors the Changes-panel status badges. */
function statusColor(status: string): string {
  switch (status[0]) {
    case "A":
    case "?":
      return "var(--atlas-status-success-foreground)";
    case "M":
      return "var(--atlas-status-warning-foreground)";
    case "D":
      return "var(--atlas-status-error-foreground)";
    case "R":
    case "C":
      // `primary`, not `accent`: shadcn's `accent` is a hover SURFACE, so the
      // rename left this badge painting near-black-on-black — and the blue
      // fallback never fired, because `--accent` has always been defined.
      return "var(--primary)";
    default:
      return "var(--muted-foreground)";
  }
}

/** First porcelain char → the single-letter badge. Untracked (`?`) reads as a
 *  new file, so show "A" (Added) rather than the raw porcelain "?". */
function statusLetter(status: string): string {
  const c = status[0];
  return c === "?" ? "A" : c;
}

function buildTree(files: { path: string; status: string }[]): DirNode {
  const root: DirNode = { name: "", path: "", isDir: true, children: [] };
  for (const { path, status } of files) {
    const parts = path.split("/");
    let dir = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      acc = acc ? `${acc}/${part}` : part;
      if (i === parts.length - 1) {
        dir.children.push({ name: part, path, isDir: false, status });
      } else {
        let next = dir.children.find((c): c is DirNode => c.isDir && c.name === part);
        if (!next) {
          next = { name: part, path: acc, isDir: true, children: [] };
          dir.children.push(next);
        }
        dir = next;
      }
    }
  }
  collapseChains(root);
  sortTree(root);
  return root;
}

/** Fold single-child directory chains into one row (src ▸ features ▸ git →
 *  "src/features/git"), the way VS Code / JetBrains compact trees do. */
function collapseChains(dir: DirNode) {
  for (const child of dir.children) {
    if (child.isDir) collapseChains(child);
  }
  // Root keeps its (empty) name; only fold interior dirs.
  if (dir.name !== "" && dir.children.length === 1 && dir.children[0].isDir) {
    const only = dir.children[0];
    dir.name = `${dir.name}/${only.name}`;
    dir.path = only.path;
    dir.children = only.children;
  }
}

function sortTree(dir: DirNode) {
  dir.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of dir.children) if (c.isDir) sortTree(c);
}

interface FlatRow {
  node: TreeNode;
  depth: number;
}

function flatten(dir: DirNode, collapsed: Set<string>, depth: number): FlatRow[] {
  const out: FlatRow[] = [];
  for (const child of dir.children) {
    out.push({ node: child, depth });
    if (child.isDir && !collapsed.has(child.path)) {
      out.push(...flatten(child, collapsed, depth + 1));
    }
  }
  return out;
}

export const ChangedFilesTree = memo(function ChangedFilesTree({
  repoPath,
  staged,
  currentFile,
  commit = null,
  only,
  onSelect,
}: ChangedFilesTreeProps) {
  const onlySet = useMemo(() => (only ? new Set(only) : null), [only]);
  const files = useGitStore.use.files();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // In commit-browse mode, list the files that commit changed.
  const commitFilesQuery = useQuery({
    queryKey: ["commit-files", repoPath, commit],
    queryFn: () => gitCommitChangedFiles(repoPath, commit!),
    enabled: !!repoPath && !!commit,
    staleTime: 30_000,
  });

  const tree = useMemo(() => {
    const seen = new Set<string>();
    const source: { path: string; status: string }[] = commit
      ? (commitFilesQuery.data ?? []).map((f) => ({ path: f.path, status: f.status }))
      : files.filter((f) => f.staged === staged).map((f) => ({ path: f.path, status: f.status }));
    const scoped = source
      // Turn scope, when the caller supplied one.
      .filter((f) => !onlySet || onlySet.has(f.path))
      .filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));

    // `only` SEEDS the list, it does not merely filter it. The store lists what
    // git currently reports as changed, and a scoped path can legitimately be
    // missing from that: a newly created file the store has not picked up yet,
    // one already staged, or one whose change was committed since. Filtering
    // alone silently dropped those — the caller asked for these paths, so they
    // are shown whether or not git is currently calling them dirty.
    if (onlySet) {
      for (const path of onlySet) {
        if (seen.has(path)) continue;
        seen.add(path);
        scoped.push({ path, status: "A" });
      }
    }

    // Ensure the open file is present even if the store hasn't caught up.
    if (currentFile && !seen.has(currentFile)) {
      scoped.push({ path: currentFile, status: "M" });
    }
    return buildTree(scoped);
  }, [files, staged, currentFile, commit, commitFilesQuery.data, onlySet]);

  const rows = useMemo(() => flatten(tree, collapsed, 0), [tree, collapsed]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TREE_ROW_H,
    overscan: 20,
  });

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex h-full w-full flex-col border-r border-[var(--border)] bg-[var(--card)]">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2">
        <GitCommit size={12} className="shrink-0 text-[var(--muted-foreground)]" />
        <span className="shrink-0 text-2xs tabular-nums text-[var(--muted-foreground)]">
          {rows.filter((r) => !r.node.isDir).length}
        </span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto hide-scrollbar py-1">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vr) => {
            const { node, depth } = rows[vr.index];
            const pad = 6 + depth * 12;
            const common = {
              className:
                "absolute left-0 right-0 flex items-center gap-1 pr-2 text-left hover:bg-[var(--atlas-element-hover)] cursor-pointer",
              style: { top: vr.start, height: TREE_ROW_H, paddingLeft: pad },
            } as const;
            if (node.isDir) {
              const open = !collapsed.has(node.path);
              return (
                <button
                  key={`d:${node.path}`}
                  onClick={() => toggle(node.path)}
                  className={`${common.className} text-xs text-[var(--muted-foreground)]`}
                  style={common.style}
                >
                  {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  <span className="truncate font-mono">{node.name}</span>
                </button>
              );
            }
            const active = node.path === currentFile;
            return (
              <button
                key={`f:${node.path}`}
                onClick={() => onSelect(node.path)}
                title={node.path}
                className={`${common.className} gap-1.5 text-xs ${
                  active
                    ? "bg-[var(--atlas-element-active,var(--atlas-element-hover))] text-[var(--foreground)]"
                    : "text-[var(--secondary-foreground)]"
                }`}
                style={{ ...common.style, paddingLeft: pad + 12 }}
              >
                <span
                  className="w-2 shrink-0 text-center font-mono text-3xs"
                  style={{ color: statusColor(node.status) }}
                >
                  {statusLetter(node.status)}
                </span>
                <span className="truncate font-mono">{node.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});
