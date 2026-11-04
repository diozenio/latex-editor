import { Command } from "cmdk";
import {
  Download,
  FileArchive,
  FilePlus2,
  GitBranch,
  Github,
  LayoutGrid,
  PanelRight,
  Play,
  Plus,
  Settings,
  Sparkles,
} from "lucide-react";
import { useApp } from "@/stores/app";
import { flatten, useProject } from "@/stores/project";
import { mod } from "@/lib/format";
import { importZipFlow } from "./Home";
import { downloadPdf } from "./PdfViewer";
import { exportZipFlow } from "./Workspace";
import { fileIcon, treeActions } from "./FileTree";

export function CommandPalette() {
  const { ui, setUi, projects, openProject, openDialog, toggle } = useApp();
  const { project, tree, openFile, compile } = useProject();
  if (!ui.palette) return null;
  const close = () => setUi({ palette: false });
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const files = flatten(tree).filter((n) => !n.isDir);

  return (
    <>
      <div className="dialog-overlay" style={{ background: "transparent" }} onClick={close} />
      <Command className="palette" loop onKeyDown={(e) => e.key === "Escape" && close()}>
        <Command.Input autoFocus placeholder={project ? `Search files, projects and commands…` : "Search projects and commands…"} />
        <Command.List>
          <Command.Empty>No results</Command.Empty>
          {project && files.length > 0 && (
            <Command.Group heading="Files">
              {files.map((f) => (
                <Command.Item key={f.path} value={`file ${f.path}`} onSelect={run(() => openFile(f.path))}>
                  {fileIcon(f.name)}
                  <span>{f.path}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Actions">
            {project && (
              <>
                <Command.Item value="compile" onSelect={run(() => compile())}>
                  <Play size={15} /> Compile <span className="right">{mod}↵</span>
                </Command.Item>
                <Command.Item value="new file" onSelect={run(() => {
                  setUi({ sidebar: true, sidebarTab: "files" });
                  setTimeout(() => treeActions.newFile(), 50);
                })}>
                  <FilePlus2 size={15} /> New file
                </Command.Item>
                <Command.Item value="download pdf" onSelect={run(downloadPdf)}>
                  <Download size={15} /> Download PDF
                </Command.Item>
                <Command.Item value="export zip" onSelect={run(exportZipFlow)}>
                  <FileArchive size={15} /> Export as ZIP
                </Command.Item>
                <Command.Item value="source control git" onSelect={run(() => setUi({ sidebar: true, sidebarTab: "git" }))}>
                  <GitBranch size={15} /> Source control
                </Command.Item>
                <Command.Item value="toggle pdf preview" onSelect={run(() => toggle("pdf"))}>
                  <PanelRight size={15} /> Toggle PDF preview
                </Command.Item>
                <Command.Item value="publish github" onSelect={run(() => openDialog({ kind: "publish", project: project.name }))}>
                  <Github size={15} /> Publish to GitHub
                </Command.Item>
              </>
            )}
            <Command.Item value="ai assistant chat claude" onSelect={run(() => toggle("chat"))}>
              <Sparkles size={15} /> AI assistant <span className="right">{mod}J</span>
            </Command.Item>
            <Command.Item value="new project" onSelect={run(() => openDialog({ kind: "new-project" }))}>
              <Plus size={15} /> New project
            </Command.Item>
            <Command.Item value="import zip" onSelect={run(importZipFlow)}>
              <FileArchive size={15} /> Import ZIP
            </Command.Item>
            <Command.Item value="clone github" onSelect={run(() => openDialog({ kind: "clone" }))}>
              <Github size={15} /> Clone from GitHub
            </Command.Item>
            <Command.Item value="all projects home" onSelect={run(() => openProject(null))}>
              <LayoutGrid size={15} /> All projects
            </Command.Item>
            <Command.Item value="settings preferences" onSelect={run(() => setUi({ settings: "general" }))}>
              <Settings size={15} /> Settings <span className="right">{mod},</span>
            </Command.Item>
          </Command.Group>
          <Command.Group heading="Projects">
            {projects.map((p) => (
              <Command.Item key={p.name} value={`project ${p.name}`} onSelect={run(() => openProject(p.name))}>
                <span className="dot" style={{ background: p.meta.color }} />
                {p.name}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </>
  );
}
