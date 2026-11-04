import { useEffect, useMemo, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  BookMarked,
  FilePlus2,
  FolderPlus,
  Pencil,
  Trash2,
  Star,
  Copy,
} from "lucide-react";
import { api, type FileNode } from "@/lib/ipc";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import { basename, dirname, join } from "@/lib/format";
import { ContextMenu, type MenuEntry } from "./ui/Menu";

type Editing = { mode: "rename"; path: string } | { mode: "new-file" | "new-folder"; dir: string } | null;

export function fileIcon(name: string, size = 15) {
  if (/\.tex$/i.test(name)) return <FileCode2 size={size} className="file-icon" />;
  if (/\.bib$/i.test(name)) return <BookMarked size={size} className="file-icon" />;
  if (/\.(png|jpe?g|gif|svg|webp|eps|pdf)$/i.test(name)) return <FileImage size={size} className="file-icon" />;
  if (/\.(md|txt)$/i.test(name)) return <FileText size={size} className="file-icon" />;
  return <File size={size} className="file-icon" />;
}

const GIT_MARK: Record<string, [string, string]> = {
  new: ["A", "var(--green)"],
  modified: ["M", "var(--orange)"],
  deleted: ["D", "var(--red)"],
  renamed: ["R", "var(--accent)"],
  conflicted: ["!", "var(--red)"],
  typechange: ["T", "var(--orange)"],
};

export function FileTree() {
  const { project, tree, active, git, openFile } = useProject();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const app = useApp();

  const marks = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of git?.files ?? []) {
      m.set(f.path, f.kind);
      // Propagate to parent folders.
      let d = dirname(f.path);
      while (d) {
        if (!m.has(d)) m.set(d, "modified");
        d = dirname(d);
      }
    }
    return m;
  }, [git]);

  // Reveal the active file.
  useEffect(() => {
    if (!active) return;
    let d = dirname(active);
    const next = new Set(expanded);
    let changed = false;
    while (d) {
      if (!next.has(d)) {
        next.add(d);
        changed = true;
      }
      d = dirname(d);
    }
    if (changed) setExpanded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (!project) return null;
  const name = project.name;

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await useProject.getState().refreshTree();
    } catch (e) {
      app.fail(e);
    }
  };

  const submitEdit = async (value: string) => {
    const ed = editing;
    setEditing(null);
    value = value.trim();
    if (!ed || !value) return;
    if (ed.mode === "rename") {
      const to = join(dirname(ed.path), value);
      if (to === ed.path) return;
      await run(() => api.renamePath(name, ed.path, to));
      useProject.getState().renamed(ed.path, to);
      if (project.meta.mainFile === ed.path) {
        await api.setProjectMeta(name, { ...project.meta, mainFile: to });
        await useProject.getState().refreshMeta();
      }
    } else if (ed.mode === "new-file") {
      const path = join(ed.dir, value.includes(".") ? value : `${value}.tex`);
      await run(() => api.writeText(name, path, ""));
      await openFile(path);
    } else {
      await run(() => api.createDir(name, join(ed.dir, value)));
      setExpanded(new Set(expanded).add(join(ed.dir, value)));
    }
  };

  const move = async (from: string, toDir: string) => {
    const to = join(toDir, basename(from));
    if (to === from || toDir === from || toDir.startsWith(from + "/")) return;
    await run(() => api.renamePath(name, from, to));
    useProject.getState().renamed(from, to);
  };

  const menuFor = (node: FileNode | null): MenuEntry[] => {
    const dir = node ? (node.isDir ? node.path : dirname(node.path)) : "";
    const items: MenuEntry[] = [
      {
        label: "New file",
        icon: <FilePlus2 size={14} />,
        onSelect: () => {
          if (dir) setExpanded(new Set(expanded).add(dir));
          setEditing({ mode: "new-file", dir });
        },
      },
      {
        label: "New folder",
        icon: <FolderPlus size={14} />,
        onSelect: () => {
          if (dir) setExpanded(new Set(expanded).add(dir));
          setEditing({ mode: "new-folder", dir });
        },
      },
    ];
    if (!node) return items;
    items.push({ separator: true });
    if (!node.isDir && /\.tex$/i.test(node.name) && project.meta.mainFile !== node.path) {
      items.push({
        label: "Set as main file",
        icon: <Star size={14} />,
        onSelect: async () => {
          await api.setProjectMeta(name, { ...project.meta, mainFile: node.path });
          await useProject.getState().refreshMeta();
          useProject.getState().scheduleCompile();
        },
      });
    }
    items.push(
      { label: "Rename", icon: <Pencil size={14} />, onSelect: () => setEditing({ mode: "rename", path: node.path }) },
      {
        label: "Copy path",
        icon: <Copy size={14} />,
        onSelect: () => navigator.clipboard.writeText(node.path),
      },
      {
        label: "Show in Finder",
        icon: <FolderOpen size={14} />,
        onSelect: async () => revealItemInDir(await api.projectPath(name, node.path)),
      },
      { separator: true },
      {
        label: "Move to Trash",
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () =>
          app.openDialog({
            kind: "confirm",
            title: `Delete “${node.name}”?`,
            message: "It will be moved to your system Trash.",
            confirm: "Move to Trash",
            danger: true,
            onConfirm: () =>
              run(async () => {
                useProject.getState().removed(node.path);
                await api.deletePath(name, node.path);
              }),
          }),
      },
    );
    return items;
  };

  const renderEditRow = (depth: number, mode: "new-file" | "new-folder") => (
    <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="chev" />
      {mode === "new-folder" ? <Folder size={15} className="file-icon" /> : <File size={15} className="file-icon" />}
      <InlineInput initial="" onSubmit={submitEdit} onCancel={() => setEditing(null)} />
    </div>
  );

  const renderNodes = (nodes: FileNode[], depth: number): JSX.Element[] =>
    nodes.map((n) => {
      const open = expanded.has(n.path);
      const mark = marks.get(n.path);
      const isEditing = editing?.mode === "rename" && editing.path === n.path;
      return (
        <div key={n.path}>
          <ContextMenu items={menuFor(n)}>
            <div
              className={`tree-row${active === n.path ? " active" : ""}${dropTarget === n.path ? " drop-target" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              data-dir={n.isDir ? n.path : dirname(n.path)}
              draggable={!isEditing}
              onDragStart={(e) => {
                e.dataTransfer.setData("text/folio-path", n.path);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes("text/folio-path")) return;
                e.preventDefault();
                setDropTarget(n.isDir ? n.path : null);
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDropTarget(null);
                const from = e.dataTransfer.getData("text/folio-path");
                if (from) void move(from, n.isDir ? n.path : dirname(n.path));
              }}
              onClick={() => (n.isDir ? toggle(n.path) : openFile(n.path))}
            >
              {n.isDir ? <ChevronRight size={13} className={`chev${open ? " open" : ""}`} /> : <span className="chev" />}
              {n.isDir ? (
                open ? (
                  <FolderOpen size={15} className="file-icon" />
                ) : (
                  <Folder size={15} className="file-icon" />
                )
              ) : (
                fileIcon(n.name)
              )}
              {isEditing ? (
                <InlineInput initial={n.name} selectStem onSubmit={submitEdit} onCancel={() => setEditing(null)} />
              ) : (
                <span className="name">{n.name}</span>
              )}
              {project.meta.mainFile === n.path && <span className="main-badge">MAIN</span>}
              {mark && (
                <span className="git-mark" style={{ color: GIT_MARK[mark]?.[1] }}>
                  {n.isDir ? "•" : GIT_MARK[mark]?.[0]}
                </span>
              )}
            </div>
          </ContextMenu>
          {n.isDir && open && (
            <>
              {editing && editing.mode !== "rename" && editing.dir === n.path && renderEditRow(depth + 1, editing.mode)}
              {renderNodes(n.children ?? [], depth + 1)}
            </>
          )}
        </div>
      );
    });

  return (
    <ContextMenu items={menuFor(null)}>
      <div
        className={`tree${dropTarget === "" ? " drop-root" : ""}`}
        data-dir=""
        style={{ minHeight: "100%" }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("text/folio-path")) e.preventDefault();
        }}
        onDrop={(e) => {
          const from = e.dataTransfer.getData("text/folio-path");
          if (from) void move(from, "");
        }}
      >
        {editing && editing.mode !== "rename" && editing.dir === "" && renderEditRow(0, editing.mode)}
        {renderNodes(tree, 0)}
        <TreeActions onNewFile={() => setEditing({ mode: "new-file", dir: "" })} onNewFolder={() => setEditing({ mode: "new-folder", dir: "" })} />
      </div>
    </ContextMenu>
  );
}

// Exposed so the sidebar header buttons can trigger creation.
let externalNewFile: (() => void) | null = null;
let externalNewFolder: (() => void) | null = null;
export const treeActions = {
  newFile: () => externalNewFile?.(),
  newFolder: () => externalNewFolder?.(),
};
function TreeActions({ onNewFile, onNewFolder }: { onNewFile: () => void; onNewFolder: () => void }) {
  externalNewFile = onNewFile;
  externalNewFolder = onNewFolder;
  return null;
}

function InlineInput({
  initial,
  selectStem,
  onSubmit,
  onCancel,
}: {
  initial: string;
  selectStem?: boolean;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    if (selectStem && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial, selectStem]);
  const finish = (submit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (submit) onSubmit(ref.current?.value ?? "");
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className="tree-rename"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}
