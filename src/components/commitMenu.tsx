import { Copy, Eye, History, RotateCcw, Scissors, Undo2 } from "lucide-react";
import { api } from "@/lib/ipc";
import type { Commit } from "@/lib/ipc";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import type { MenuEntry } from "./ui/Menu";

/** Run a history action, then bring the status and file tree up to date. */
async function run(fn: () => Promise<unknown>, success: string) {
  const app = useApp.getState();
  try {
    await fn();
    app.toast(success, "success");
  } catch (e) {
    app.fail(e);
  } finally {
    await useProject.getState().refreshGit();
    await useProject.getState().refreshTree();
  }
}

function confirm(title: string, message: string, confirmLabel: string, danger: boolean, onConfirm: () => Promise<void>) {
  useApp.getState().openDialog({ kind: "confirm", title, message, confirm: confirmLabel, danger, onConfirm });
}

/** Actions for one entry of the history, shared by its menu and its dialog. */
export function commitMenu(project: string, c: Commit, isHead: boolean, open = true): MenuEntry[] {
  const quoted = `“${c.summary}” (${c.short})`;
  const items: MenuEntry[] = [];
  if (open) {
    items.push({
      label: "View changes",
      icon: <Eye size={14} />,
      onSelect: () => useApp.getState().openDialog({ kind: "commit", project, commit: c }),
    });
    items.push({ separator: true });
  }
  items.push(
    {
      label: "Restore this version",
      icon: <History size={14} />,
      disabled: isHead,
      onSelect: () =>
        confirm(
          "Restore this version?",
          `The files will go back to how they were at ${quoted}. This is saved as a new commit, so nothing is lost from the history.`,
          "Restore",
          false,
          () => run(() => api.gitRestoreVersion(project, c.id), `Restored ${c.short}`),
        ),
    },
    {
      label: "Undo this commit",
      icon: <Undo2 size={14} />,
      onSelect: () =>
        confirm(
          "Undo this commit?",
          `A new commit will reverse only the changes made in ${quoted}. Later work is kept.`,
          "Undo",
          false,
          () => run(() => api.gitRevertCommit(project, c.id), `Undid ${c.short}`),
        ),
    },
    {
      label: "Reset branch to here",
      icon: <RotateCcw size={14} />,
      danger: true,
      disabled: isHead,
      onSelect: () =>
        confirm(
          "Reset the branch to this commit?",
          `Every commit after ${quoted} will be removed from the branch, along with its changes. This cannot be undone.`,
          "Reset",
          true,
          () => run(() => api.gitResetTo(project, c.id), `Reset to ${c.short}`),
        ),
    },
    {
      label: "Delete commit",
      icon: <Scissors size={14} />,
      danger: true,
      onSelect: () =>
        confirm(
          "Delete this commit?",
          `${quoted} will be removed from the history and its changes will be gone. Later commits are kept.${
            c.pushed ? " It was already pushed, so this will be refused." : ""
          }`,
          "Delete",
          true,
          () => run(() => api.gitDeleteCommit(project, c.id), `Deleted ${c.short}`),
        ),
    },
    { separator: true },
    {
      label: "Copy commit id",
      icon: <Copy size={14} />,
      onSelect: () => {
        void navigator.clipboard.writeText(c.id);
        useApp.getState().toast("Commit id copied");
      },
    },
  );
  return items;
}
