import { Copy, Eye, History, RotateCcw, Scissors, Undo2 } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Commit } from "@/lib/ipc";
import { api } from "@/lib/ipc";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import type { MenuEntry } from "./ui/Menu";

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

function confirm(
  title: string,
  message: string,
  confirmLabel: string,
  danger: boolean,
  onConfirm: () => Promise<void>,
) {
  useApp
    .getState()
    .openDialog({
      kind: "confirm",
      title,
      message,
      confirm: confirmLabel,
      danger,
      onConfirm,
    });
}

export function commitMenu(
  project: string,
  c: Commit,
  isHead: boolean,
  open = true,
): MenuEntry[] {
  const quoted = `“${c.summary}” (${c.short})`;
  const items: MenuEntry[] = [];
  if (open) {
    items.push({
      label: t("git.viewChanges"),
      icon: <Eye size={14} />,
      onSelect: () =>
        useApp.getState().openDialog({ kind: "commit", project, commit: c }),
    });
    items.push({ separator: true });
  }
  items.push(
    {
      label: t("git.restore"),
      icon: <History size={14} />,
      disabled: isHead,
      onSelect: () =>
        confirm(
          t("git.restoreTitle"),
          t("git.restoreMessage", { commit: quoted }),
          t("git.restoreConfirm"),
          false,
          () =>
            run(
              () => api.gitRestoreVersion(project, c.id),
              t("git.restored", { short: c.short }),
            ),
        ),
    },
    {
      label: t("git.undo"),
      icon: <Undo2 size={14} />,
      onSelect: () =>
        confirm(
          t("git.undoTitle"),
          t("git.undoMessage", { commit: quoted }),
          t("git.undoConfirm"),
          false,
          () =>
            run(() => api.gitRevertCommit(project, c.id), t("git.undid", { short: c.short })),
        ),
    },
    {
      label: t("git.reset"),
      icon: <RotateCcw size={14} />,
      danger: true,
      disabled: isHead,
      onSelect: () =>
        confirm(
          t("git.resetTitle"),
          t("git.resetMessage", { commit: quoted }),
          t("git.resetConfirm"),
          true,
          () => run(() => api.gitResetTo(project, c.id), t("git.resetDone", { short: c.short })),
        ),
    },
    {
      label: t("git.deleteCommit"),
      icon: <Scissors size={14} />,
      danger: true,
      onSelect: () =>
        confirm(
          t("git.deleteCommitTitle"),
          `${t("git.deleteCommitMessage", { commit: quoted })}${
            c.pushed ? t("git.deleteCommitPushed") : ""
          }`,
          t("common.delete"),
          true,
          () =>
            run(() => api.gitDeleteCommit(project, c.id), t("git.deleted", { short: c.short })),
        ),
    },
    { separator: true },
    {
      label: t("git.copyId"),
      icon: <Copy size={14} />,
      onSelect: () => {
        void navigator.clipboard.writeText(c.id);
        useApp.getState().toast(t("git.idCopied"));
      },
    },
  );
  return items;
}
