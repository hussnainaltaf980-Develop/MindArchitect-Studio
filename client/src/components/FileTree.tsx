import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export interface FileEntry {
  path: string;
  language: string;
  sizeBytes: number;
  updatedAt: string | Date;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  file?: FileEntry;
}

/** Fold a flat path list into a tree. Directories are synthesised, so adding a
 *  file under a new directory needs no separate "create folder" step. */
function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let next = node.children.find((c) => c.name === part && c.isDir === !isLast);
      if (!next) {
        next = { name: part, path, isDir: !isLast, children: [], file: isLast ? file : undefined };
        node.children.push(next);
      }
      node = next;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
    );
    nodes.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

function iconFor(name: string, language: string) {
  if (language === "python") return "py";
  if (language === "typescript") return name.endsWith(".tsx") ? "tx" : "ts";
  if (language === "json") return "{}";
  if (language === "markdown") return "md";
  if (language === "yaml") return "ym";
  return "·";
}

function Row({
  node,
  depth,
  activePath,
  dirtyPaths,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  dirtyPaths: Set<string>;
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);

  if (node.isDir) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1 rounded px-1.5 py-[3px] text-left text-[13px] text-muted-foreground hover:bg-muted/60"
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <span className="w-3 text-[9px] opacity-70">{open ? "▾" : "▸"}</span>
          <span className="truncate font-medium">{node.name}</span>
          <span className="tabular ml-auto text-[10px] opacity-60">{node.children.length}</span>
        </button>
        {open
          ? node.children.map((c) => (
              <Row
                key={c.path}
                node={c}
                depth={depth + 1}
                activePath={activePath}
                dirtyPaths={dirtyPaths}
                onOpen={onOpen}
              />
            ))
          : null}
      </div>
    );
  }

  const active = node.path === activePath;
  const dirty = dirtyPaths.has(node.path);
  return (
    <button
      type="button"
      onClick={() => onOpen(node.path)}
      title={node.path}
      className={cn(
        "group flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left text-[13px]",
        active ? "bg-accent text-accent-foreground" : "text-foreground/80 hover:bg-muted/60",
      )}
      style={{ paddingLeft: 6 + depth * 12 }}
      data-testid={`file-${node.path}`}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[9px] font-semibold uppercase",
          active ? "bg-primary/25 text-primary" : "bg-muted text-muted-foreground",
        )}
        aria-hidden
      >
        {iconFor(node.name, node.file?.language ?? "")}
      </span>
      <span className="truncate">{node.name}</span>
      {dirty ? (
        <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title="Unsaved" />
      ) : null}
    </button>
  );
}

export function FileTree({
  files,
  activePath,
  dirtyPaths,
  onOpen,
  onCreate,
}: {
  files: FileEntry[];
  activePath: string | null;
  dirtyPaths: Set<string>;
  onOpen: (path: string) => void;
  onCreate: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <button
          type="button"
          onClick={() => {
            const name = window.prompt("New file path (e.g. scripts/new_run.py)");
            if (name && name.trim()) onCreate(name.trim());
          }}
          className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          title="New file"
        >
          + new file
        </button>
        <span className="tabular ml-auto text-[10px] text-muted-foreground">
          {files.length} files
        </span>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto py-1" data-testid="file-tree">
        {tree.length === 0 ? (
          <p className="px-3 py-6 text-[12px] leading-relaxed text-muted-foreground">
            This workspace has no files yet. Use <span className="text-foreground">+ new
            file</span> to create one.
          </p>
        ) : (
          tree.map((n) => (
            <Row
              key={n.path}
              node={n}
              depth={0}
              activePath={activePath}
              dirtyPaths={dirtyPaths}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </div>
  );
}
