import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  BookMarked,
  ChevronRight,
  Copy,
  File,
  FileCode2,
  FileImage,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { basename, dirname, join } from "@/lib/format";
import { api, type FileNode } from "@/lib/ipc";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import { ContextMenu, type MenuEntry } from "./ui/Menu";

type Editing =
  | { mode: "rename"; path: string }
  | { mode: "new-file" | "new-folder"; dir: string }
  | null;

export function fileIcon(name: string, size = 15) {
  if (/\.tex$/i.test(name))
    return <FileCode2 size={size} className="file-icon" />;
  if (/\.bib$/i.test(name))
    return <BookMarked size={size} className="file-icon" />;
  if (/\.(png|jpe?g|gif|svg|webp|eps|pdf)$/i.test(name))
    return <FileImage size={size} className="file-icon" />;
  if (/\.(md|txt)$/i.test(name))
    return <FileText size={size} className="file-icon" />;
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
  const [focused, setFocused] = useState<string | null>(null);
  const [drag, setDrag] = useState<{
    node: FileNode;
    x: number;
    y: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const app = useApp();

  const marks = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of git?.files ?? []) {
      m.set(f.path, f.kind);
      let d = dirname(f.path);
      while (d) {
        if (!m.has(d)) m.set(d, "modified");
        d = dirname(d);
      }
    }
    return m;
  }, [git]);

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

  const canMove = (from: string, toDir: string) =>
    dirname(from) !== toDir && toDir !== from && !toDir.startsWith(from + "/");

  const move = async (from: string, toDir: string) => {
    if (!canMove(from, toDir)) return;
    const to = join(toDir, basename(from));
    await run(() => api.renamePath(name, from, to));
    useProject.getState().renamed(from, to);
    const remap = (p: string) =>
      p === from
        ? to
        : p.startsWith(from + "/")
          ? to + p.slice(from.length)
          : p;
    setExpanded((prev) => {
      const next = new Set([...prev].map(remap));
      if (toDir) next.add(toDir);
      return next;
    });
    setFocused((f) => (f ? remap(f) : f));
  };

  const findNode = (nodes: FileNode[], path: string): FileNode | undefined => {
    for (const n of nodes) {
      if (n.path === path) return n;
      if (n.isDir && path.startsWith(n.path + "/"))
        return findNode(n.children ?? [], path);
    }
  };
  const targetDir = () => {
    if (!focused) return "";
    const node = findNode(tree, focused);
    if (!node) return "";
    return node.isDir ? node.path : dirname(node.path);
  };
  const startCreate = (mode: "new-file" | "new-folder", dir = targetDir()) => {
    if (dir) setExpanded((prev) => new Set(prev).add(dir));
    setEditing({ mode, dir });
  };

  const beginDrag = (e: ReactMouseEvent, n: FileNode) => {
    if (e.button !== 0 || editing) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let started = false;
    let target: string | null = null;
    let hoverDir: string | null = null;
    let expandTimer: ReturnType<typeof setTimeout> | undefined;

    const onMove = (ev: MouseEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        started = true;
        document.body.classList.add("tree-dragging");
      }
      setDrag({ node: n, x: ev.clientX, y: ev.clientY });
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const dirEl = el?.closest(".tree [data-dir]");
      const dir = dirEl ? (dirEl.getAttribute("data-dir") ?? "") : null;
      target = dir !== null && canMove(n.path, dir) ? dir : null;
      setDropTarget(target);
      const row = el?.closest(".tree-row[data-folder]");
      const folder = row?.getAttribute("data-folder") ?? null;
      if (folder !== hoverDir) {
        hoverDir = folder;
        clearTimeout(expandTimer);
        if (folder)
          expandTimer = setTimeout(
            () => setExpanded((prev) => new Set(prev).add(folder)),
            600,
          );
      }
    };
    const end = (commit: boolean) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      clearTimeout(expandTimer);
      if (!started) return;
      document.body.classList.remove("tree-dragging");
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false));
      setDrag(null);
      setDropTarget(null);
      if (commit && target !== null) void move(n.path, target);
    };
    const onUp = () => end(true);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") end(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
  };

  const visibleNodes = (nodes: FileNode[]): FileNode[] =>
    nodes.flatMap((n) =>
      n.isDir && expanded.has(n.path)
        ? [n, ...visibleNodes(n.children ?? [])]
        : [n],
    );

  const activate = (n: FileNode) => {
    if (n.isDir) toggle(n.path);
    else
      void openFile(n.path).then(() =>
        requestAnimationFrame(() => treeRef.current?.focus()),
      );
  };

  const confirmDelete = (node: FileNode) =>
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
          setFocused((f) =>
            f === node.path || f?.startsWith(node.path + "/") ? null : f,
          );
        }),
    });

  const menuFor = (node: FileNode | null): MenuEntry[] => {
    const dir = node ? (node.isDir ? node.path : dirname(node.path)) : "";
    const items: MenuEntry[] = [
      {
        label: "New file",
        icon: <FilePlus2 size={14} />,
        onSelect: () => startCreate("new-file", dir),
      },
      {
        label: "New folder",
        icon: <FolderPlus size={14} />,
        onSelect: () => startCreate("new-folder", dir),
      },
    ];
    if (!node) return items;
    items.push({ separator: true });
    if (
      !node.isDir &&
      /\.tex$/i.test(node.name) &&
      project.meta.mainFile !== node.path
    ) {
      items.push({
        label: "Set as main file",
        icon: <Star size={14} />,
        onSelect: async () => {
          await api.setProjectMeta(name, {
            ...project.meta,
            mainFile: node.path,
          });
          await useProject.getState().refreshMeta();
          useProject.getState().scheduleCompile();
        },
      });
    }
    items.push(
      {
        label: "Rename",
        icon: <Pencil size={14} />,
        onSelect: () => setEditing({ mode: "rename", path: node.path }),
      },
      {
        label: "Copy path",
        icon: <Copy size={14} />,
        onSelect: () => navigator.clipboard.writeText(node.path),
      },
      {
        label: "Show in Finder",
        icon: <FolderOpen size={14} />,
        onSelect: async () =>
          revealItemInDir(await api.projectPath(name, node.path)),
      },
      { separator: true },
      {
        label: "Move to Trash",
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => confirmDelete(node),
      },
    );
    return items;
  };

  const renderEditRow = (depth: number, mode: "new-file" | "new-folder") => (
    <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="chev" />
      {mode === "new-folder" ? (
        <Folder size={15} className="file-icon" />
      ) : (
        <File size={15} className="file-icon" />
      )}
      <InlineInput
        initial=""
        onSubmit={submitEdit}
        onCancel={() => setEditing(null)}
      />
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
              className={`tree-row${active === n.path ? " active" : ""}${focused === n.path ? " focused" : ""}${dropTarget === n.path ? " drop-target" : ""}${drag?.node.path === n.path ? " dragging" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              data-path={n.path}
              data-dir={n.isDir ? n.path : dirname(n.path)}
              data-folder={n.isDir && !open ? n.path : undefined}
              onMouseDown={(e) => !isEditing && beginDrag(e, n)}
              onClick={() => {
                if (suppressClick.current) return;
                setFocused(n.path);
                activate(n);
              }}
              onDoubleClick={() => {
                if (!n.isDir)
                  document.querySelector<HTMLElement>(".cm-content")?.focus();
              }}
            >
              {n.isDir ? (
                <ChevronRight
                  size={13}
                  className={`chev${open ? " open" : ""}`}
                />
              ) : (
                <span className="chev" />
              )}
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
                <InlineInput
                  initial={n.name}
                  selectStem
                  onSubmit={submitEdit}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <span className="name">{n.name}</span>
              )}
              {project.meta.mainFile === n.path && (
                <span className="main-badge">MAIN</span>
              )}
              {mark && (
                <span
                  className="git-mark"
                  style={{ color: GIT_MARK[mark]?.[1] }}
                >
                  {n.isDir ? "•" : GIT_MARK[mark]?.[0]}
                </span>
              )}
            </div>
          </ContextMenu>
          {n.isDir && open && (
            <>
              {editing &&
                editing.mode !== "rename" &&
                editing.dir === n.path &&
                renderEditRow(depth + 1, editing.mode)}
              {renderNodes(n.children ?? [], depth + 1)}
            </>
          )}
        </div>
      );
    });

  return (
    <ContextMenu items={menuFor(null)}>
      <div
        ref={treeRef}
        className={`tree${dropTarget === "" ? " drop-root" : ""}`}
        data-dir=""
        tabIndex={-1}
        onKeyDown={(e) => {
          if (
            editing ||
            e.target !== e.currentTarget ||
            e.metaKey ||
            e.ctrlKey ||
            e.altKey
          )
            return;
          const rows = visibleNodes(tree);
          const i = rows.findIndex((r) => r.path === focused);
          const node = rows[i];
          const go = (n: FileNode | undefined) => {
            if (!n) return;
            setFocused(n.path);
            treeRef.current
              ?.querySelector(`.tree-row[data-path="${CSS.escape(n.path)}"]`)
              ?.scrollIntoView({ block: "nearest" });
          };
          switch (e.key) {
            case "ArrowDown":
              go(node ? rows[i + 1] : rows[0]);
              break;
            case "ArrowUp":
              go(node ? rows[i - 1] : rows[rows.length - 1]);
              break;
            case "ArrowRight":
              if (!node?.isDir) return;
              if (!expanded.has(node.path)) toggle(node.path);
              else go(node.children?.[0]);
              break;
            case "ArrowLeft":
              if (!node) return;
              if (node.isDir && expanded.has(node.path)) toggle(node.path);
              else go(rows.find((r) => r.path === dirname(node.path)));
              break;
            case "Enter":
              if (!node) return;
              activate(node);
              break;
            case "Delete":
            case "Backspace":
              if (!node) return;
              confirmDelete(node);
              break;
            default:
              return;
          }
          e.preventDefault();
        }}
        onClick={(e) => {
          if (e.target !== e.currentTarget) return;
          if (focused) {
            const node = findNode(tree, focused);
            if (node?.isDir && expanded.has(node.path)) toggle(node.path);
          }
          setFocused(null);
        }}
      >
        {editing &&
          editing.mode !== "rename" &&
          editing.dir === "" &&
          renderEditRow(0, editing.mode)}
        {renderNodes(tree, 0)}
        <TreeActions
          onNewFile={() => startCreate("new-file")}
          onNewFolder={() => startCreate("new-folder")}
        />
        {drag && (
          <div
            className="tree-drag-ghost"
            style={{ left: drag.x + 12, top: drag.y + 8 }}
          >
            {drag.node.isDir ? (
              <Folder size={13} className="file-icon" />
            ) : (
              fileIcon(drag.node.name, 13)
            )}
            {drag.node.name}
          </div>
        )}
      </div>
    </ContextMenu>
  );
}

let externalNewFile: (() => void) | null = null;
let externalNewFolder: (() => void) | null = null;
export const treeActions = {
  newFile: () => externalNewFile?.(),
  newFolder: () => externalNewFolder?.(),
};
function TreeActions({
  onNewFile,
  onNewFolder,
}: {
  onNewFile: () => void;
  onNewFolder: () => void;
}) {
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
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      autoComplete="off"
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
