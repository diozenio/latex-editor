import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  CalendarDays,
  Copy,
  FileArchive,
  FolderOpen,
  Github,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { timeAgo } from "@/lib/format";
import { getLanguage, t, useT } from "@/lib/i18n";
import { api } from "@/lib/ipc";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import { SyncBadge, syncState } from "./SyncBadge";
import { ContextMenu, Dropdown, type MenuEntry } from "./ui/Menu";

function dayPart() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

export async function importZipFlow() {
  const app = useApp.getState();
  const file = await openDialog({ multiple: false, filters: [{ name: t("home.zipArchive"), extensions: ["zip"] }] });
  if (!file) return;
  try {
    const p = await api.importZip(file);
    await app.refreshProjects();
    app.openProject(p.name);
    app.toast(t("toast.imported", { name: p.name }), "success");
  } catch (e) {
    app.fail(e);
  }
}

export function projectMenu(name: string): MenuEntry[] {
  const app = useApp.getState();
  return [
    { label: t("common.open"), icon: <FolderOpen size={14} />, onSelect: () => app.openProject(name) },
    {
      label: t("common.showInFinder"),
      icon: <FolderOpen size={14} />,
      onSelect: async () => revealItemInDir(await api.projectPath(name)),
    },
    { separator: true },
    {
      label: t("common.renameEllipsis"),
      icon: <Pencil size={14} />,
      onSelect: () =>
        app.openDialog({
          kind: "prompt",
          title: t("home.renameProject"),
          initial: name,
          confirm: t("common.rename"),
          onSubmit: async (to) => {
            const renamed = await api.renameProject(name, to);
            await useProject.getState().followRename(name, renamed.name);
          },
        }),
    },
    {
      label: t("common.duplicate"),
      icon: <Copy size={14} />,
      onSelect: async () => {
        try {
          await api.duplicateProject(name, await api.uniqueProjectName(t("home.copyName", { name })));
          await app.refreshProjects();
        } catch (e) {
          app.fail(e);
        }
      },
    },
    { separator: true },
    {
      label: t("common.moveToTrash"),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () =>
        app.openDialog({
          kind: "confirm",
          title: t("home.trashTitle", { name }),
          message: t("home.trashMessage"),
          confirm: t("common.moveToTrash"),
          danger: true,
          onConfirm: async () => {
            const id = await api.projectSummary(name).then((p) => p.meta.id, () => "");
            await api.deleteProject(name);
            if (id) void api.chatSave(`project-${id}`, null);
            if (useApp.getState().current === name) app.openProject(null);
            await app.refreshProjects();
          },
        }),
    },
  ];
}

export function Home() {
  const t = useT();
  const { projects, settings, sync, openProject, openDialog: open } = useApp();
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    [projects, query],
  );
  const name = settings?.githubUser?.name?.split(" ")[0] || settings?.githubUser?.login || "";
  const toPull = projects.filter((p) => syncState(sync[p.name]?.status) === "behind").length;
  const toPush = projects.filter((p) => ["ahead", "diverged"].includes(syncState(sync[p.name]?.status))).length;
  const recent = projects[0];

  return (
    <div className="home">
      <div className="home-inner">
        <h1>
          {name ? t(`home.greetingNamed.${dayPart()}`, { name }) : t(`home.greeting.${dayPart()}`)}
        </h1>
        <p className="subtitle">{t("home.subtitle", { path: useApp.getState().info?.projectsRoot ?? "" })}</p>

        <div className="hero-card">
          <div className="hero-head">
            <CalendarDays size={16} />
            {new Date().toLocaleDateString(getLanguage(), { weekday: "long", month: "long", day: "numeric" })}
          </div>
          <div className="hero-body">
            <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.015em", lineHeight: 1.45 }}>
              <span className="muted">{t("home.youHave")}</span>
              {t("home.projectCount", { count: projects.length })}
              {toPull > 0 && (
                <>
                  <span className="muted">, </span>
                  <span style={{ color: "var(--orange)" }}>{t("home.toPull", { count: toPull })}</span>
                </>
              )}
              {toPush > 0 && (
                <>
                  <span className="muted">{toPull ? t("home.and") : ", "}</span>
                  <span style={{ color: "var(--accent-text)" }}>{t("home.toPush", { count: toPush })}</span>
                </>
              )}
              <span className="muted">.</span>
              {recent && (
                <>
                  <span className="muted">{t("home.pickUp")}</span>
                  <a
                    onClick={() => openProject(recent.name)}
                    style={{ textDecoration: "underline", textUnderlineOffset: 4, cursor: "pointer" }}
                  >
                    {recent.name}
                  </a>
                  <span className="muted">.</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="home-actions">
          <button className="btn primary" onClick={() => open({ kind: "new-project" })}>
            <Plus size={15} /> {t("common.newProject")}
          </button>
          <button className="btn" onClick={importZipFlow}>
            <FileArchive size={15} /> {t("common.importZip")}
          </button>
          <button className="btn" onClick={() => open({ kind: "clone" })}>
            <Github size={15} /> {t("common.cloneFromGithub")}
          </button>
          <div className="grow" />
          <div className="search-field" style={{ width: 240 }}>
            <Search size={14} />
            <input
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              placeholder={t("home.filter")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>{t("common.projects")}</h2>
            <span className="count">{projects.length}</span>
          </div>
          {filtered.length === 0 ? (
            <div className="empty" style={{ padding: 48 }}>
              <div className="empty-icon">
                <Sparkles size={20} />
              </div>
              <h3>{projects.length ? t("home.noMatches") : t("home.noProjects")}</h3>
              <p>{t("home.emptyHint")}</p>
            </div>
          ) : (
            <div style={{ paddingBottom: 6 }}>
              {filtered.map((p) => {
                const s = sync[p.name];
                return (
                  <ContextMenu key={p.name} items={projectMenu(p.name)}>
                    <div className="project-row" onDoubleClick={() => openProject(p.name)} onClick={() => openProject(p.name)}>
                      <span className="dot" style={{ background: p.meta.color }} />
                      <span className="title">{p.name}</span>
                      <span className="muted mono" style={{ fontSize: 11 }}>
                        {p.meta.mainFile}
                      </span>
                      {p.hasGit && <SyncBadge status={s?.status} error={s?.error} checkedAt={s?.checkedAt} />}
                      <span className="muted" style={{ width: 80, textAlign: "right" }}>
                        {timeAgo(p.modified)}
                      </span>
                      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                        <Dropdown
                          align="end"
                          items={projectMenu(p.name)}
                          trigger={
                            <button className="icon-btn framed sm">
                              <MoreHorizontal size={14} />
                            </button>
                          }
                        />
                      </div>
                    </div>
                  </ContextMenu>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
