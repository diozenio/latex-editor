import {
  ChevronDown,
  FilePlus2,
  FolderPlus,
  GitBranch,
  Files,
  Home as HomeIcon,
  PanelLeftClose,
  Search,
  Settings as SettingsIcon,
  Plus,
  Check,
  LayoutGrid,
} from "lucide-react";
import { useApp } from "@/stores/app";
import { useProject } from "@/stores/project";
import { mod } from "@/lib/format";
import { Dropdown } from "./ui/Menu";
import { FileTree, treeActions } from "./FileTree";
import { GitPanel } from "./GitPanel";

export function Sidebar() {
  const { ui, setUi, toggle, projects, current, openProject, openDialog } = useApp();
  const project = useProject((s) => s.project);
  const changes = useProject((s) => s.git?.files.length ?? 0);

  return (
    <aside className={`sidebar${ui.sidebar ? "" : " collapsed"}`}>
      <div className="sidebar-head drag" data-tauri-drag-region>
        <button className="icon-btn" title={`Hide sidebar (${mod}B)`} onClick={() => toggle("sidebar")}>
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div style={{ padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 10 }}>
        <Dropdown
          items={[
            { label: "All projects", icon: <LayoutGrid size={14} />, onSelect: () => openProject(null) },
            { separator: true },
            { heading: "Projects" },
            ...projects.slice(0, 12).map((p) => ({
              label: p.name,
              icon: <span className="dot" style={{ background: p.meta.color }} />,
              right: p.name === current ? <Check size={13} /> : undefined,
              onSelect: () => openProject(p.name),
            })),
            { separator: true },
            { label: "New project…", icon: <Plus size={14} />, onSelect: () => openDialog({ kind: "new-project" }) },
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
                {project ? project.name[0]?.toUpperCase() : "F"}
              </span>
              <span className="label" style={{ fontSize: 14, color: "var(--text)" }}>
                {project?.name ?? "Folio"}
              </span>
              <ChevronDown size={14} />
            </button>
          }
        />
        <button className="search-field" onClick={() => setUi({ palette: true })}>
          <Search size={14} />
          <span>Quick search</span>
          <span className="kbd">{mod}K</span>
        </button>
      </div>

      <div className={`sidebar-body${project && ui.sidebarTab === "files" ? " files" : ""}`}>
        {project ? (
          <>
            <div className="seg">
              <button className={ui.sidebarTab === "files" ? "on" : ""} onClick={() => setUi({ sidebarTab: "files" })}>
                <Files size={13} /> Files
              </button>
              <button className={ui.sidebarTab === "git" ? "on" : ""} onClick={() => setUi({ sidebarTab: "git" })}>
                <GitBranch size={13} /> Source control
                {changes > 0 && <span className="count" style={{ height: 16, minWidth: 16 }}>{changes}</span>}
              </button>
            </div>
            {ui.sidebarTab === "files" ? (
              <>
                <div className="section-label">
                  <span>Files</span>
                  <span className="row" style={{ gap: 0 }}>
                    <button className="icon-btn sm" title="New file" onClick={() => treeActions.newFile()}>
                      <FilePlus2 size={13} />
                    </button>
                    <button className="icon-btn sm" title="New folder" onClick={() => treeActions.newFolder()}>
                      <FolderPlus size={13} />
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
            <button className="nav-item active">
              <HomeIcon size={16} />
              <span className="label">Home</span>
            </button>
            <div className="section-label">
              <span>Projects</span>
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
        <button className="icon-btn" title="Settings" onClick={() => setUi({ settings: "general" })}>
          <SettingsIcon size={16} />
        </button>
        {project && (
          <button className="icon-btn" title="All projects" onClick={() => openProject(null)}>
            <HomeIcon size={16} />
          </button>
        )}
      </div>
    </aside>
  );
}
