import {
  Check,
  ChevronDown,
  FilePlus2,
  Files,
  FolderPlus,
  GitBranch,
  LayoutGrid,
  Plus,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { useShortcut } from "@/lib/keybinds";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import { FileTree, treeActions } from "./FileTree";
import { GitPanel } from "./GitPanel";
import { UpdateButton } from "./UpdateButton";
import { Dropdown } from "./ui/Menu";

export function Sidebar() {
  const t = useT();
  const kPalette = useShortcut("command-palette");
  const { ui, setUi, projects, current, openProject, openDialog } = useApp();
  const project = useProject((s) => s.project);
  const changes = useProject((s) => s.git?.files.length ?? 0);

  return (
    <aside className={`sidebar${ui.sidebar ? "" : " collapsed"}`}>
      <div className="sidebar-head drag" data-tauri-drag-region />

      <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 10 }}>
        <Dropdown
          items={[
            { label: t("common.allProjects"), icon: <LayoutGrid size={14} />, onSelect: () => openProject(null) },
            { separator: true },
            { heading: t("common.projects") },
            ...projects.slice(0, 12).map((p) => ({
              label: p.name,
              icon: <span className="dot" style={{ background: p.meta.color }} />,
              right: p.name === current ? <Check size={13} /> : undefined,
              onSelect: () => openProject(p.name),
            })),
            { separator: true },
            { label: `${t("common.newProject")}…`, icon: <Plus size={14} />, onSelect: () => openDialog({ kind: "new-project" }) },
          ]}
          trigger={
            <button className="nav-item" style={{ height: 36 }}>
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 7,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 650,
                  fontSize: 12,
                  color: project ? "#fff" : "var(--accent-text)",
                  background: project ? project.meta.color : "var(--accent-soft)",
                  flex: "none",
                }}
              >
                {project ? project.name[0]?.toUpperCase() : "Q"}
              </span>
              <span className="label" style={{ fontSize: 14, color: "var(--text)" }}>
                {project?.name ?? "QuillTex"}
              </span>
              <ChevronDown size={14} />
            </button>
          }
        />
        <button className="search-field" onClick={() => setUi({ palette: true })}>
          <Search size={14} />
          <span>{t("sidebar.quickSearch")}</span>
          {kPalette && <span className="kbd">{kPalette}</span>}
        </button>
      </div>

      <div className={`sidebar-body${project && ui.sidebarTab === "files" ? " files" : ""}`}>
        {project ? (
          <>
            <div className="seg">
              <button title={t("common.files")} className={ui.sidebarTab === "files" ? "on" : ""} onClick={() => setUi({ sidebarTab: "files" })}>
                <Files size={13} />
                <span className="seg-label">{t("common.files")}</span>
              </button>
              <button title={t("common.sourceControl")} className={ui.sidebarTab === "git" ? "on" : ""} onClick={() => setUi({ sidebarTab: "git" })}>
                <GitBranch size={13} />
                <span className="seg-label">{t("common.sourceControl")}</span>
                {changes > 0 && <span className="count" style={{ height: 16, minWidth: 16 }}>{changes}</span>}
              </button>
            </div>
            {ui.sidebarTab === "files" ? (
              <>
                <div className="section-label">
                  <span>{t("common.files")}</span>
                  <span className="row" style={{ gap: 0 }}>
                    <button className="icon-btn sm" title={t("common.newFile")} onClick={() => treeActions.newFile()}>
                      <FilePlus2 size={18} />
                    </button>
                    <button className="icon-btn sm" title={t("common.newFolder")} onClick={() => treeActions.newFolder()}>
                      <FolderPlus size={18} />
                    </button>
                  </span>
                </div>
                <FileTree />
              </>
            ) : (
              <GitPanel />
            )}
          </>
        ) : (
          <>
            <div className="section-label">
              <span>{t("common.projects")}</span>
              <span className="count">{projects.length}</span>
            </div>
            {projects.map((p) => (
              <button key={p.name} className="nav-item" onClick={() => openProject(p.name)}>
                <span className="dot" style={{ background: p.meta.color }} />
                <span className="label">{p.name}</span>
              </button>
            ))}
          </>
        )}
      </div>

      <div className="sidebar-foot">
        <button className="nav-item" onClick={() => setUi({ settings: "general" })}>
          <SettingsIcon size={16} />
          <span className="label">{t("common.settings")}</span>
        </button>
        <UpdateButton />
      </div>
    </aside>
  );
}
