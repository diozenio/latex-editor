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
  Sparkles,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import { useShortcut } from "@/lib/keybinds";
import { useApp } from "@/stores/app";
import { flatten, useProject } from "@/stores/project";
import { fileIcon, treeActions } from "./FileTree";
import { importZipFlow } from "./Home";
import { downloadPdf } from "./PdfViewer";
import { TABS } from "./Settings";
import { exportZipFlow } from "./Workspace";

export function CommandPalette() {
  const t = useT();
  const kCompile = useShortcut("compile");
  const kChat = useShortcut("toggle-chat");
  const kSettings = useShortcut("settings");
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
        <Command.Input autoFocus placeholder={project ? t("palette.placeholderProject") : t("palette.placeholder")} />
        <Command.List>
          <Command.Empty>{t("palette.empty")}</Command.Empty>
          {project && files.length > 0 && (
            <Command.Group heading={t("common.files")}>
              {files.map((f) => (
                <Command.Item key={f.path} value={`file ${f.path}`} onSelect={run(() => openFile(f.path))}>
                  {fileIcon(f.name)}
                  <span>{f.path}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading={t("palette.actions")}>
            {project && (
              <>
                <Command.Item value={`compile ${t("common.compile")}`} onSelect={run(() => compile())}>
                  <Play size={15} /> {t("common.compile")} <span className="right">{kCompile}</span>
                </Command.Item>
                <Command.Item value={`new file ${t("common.newFile")}`} onSelect={run(() => {
                  setUi({ sidebar: true, sidebarTab: "files" });
                  setTimeout(() => treeActions.newFile(), 50);
                })}>
                  <FilePlus2 size={15} /> {t("common.newFile")}
                </Command.Item>
                <Command.Item value={`download pdf ${t("common.downloadPdf")}`} onSelect={run(downloadPdf)}>
                  <Download size={15} /> {t("common.downloadPdf")}
                </Command.Item>
                <Command.Item value={`export zip ${t("common.exportZip")}`} onSelect={run(exportZipFlow)}>
                  <FileArchive size={15} /> {t("common.exportZip")}
                </Command.Item>
                <Command.Item value={`source control git ${t("common.sourceControl")}`} onSelect={run(() => setUi({ sidebar: true, sidebarTab: "git" }))}>
                  <GitBranch size={15} /> {t("common.sourceControl")}
                </Command.Item>
                <Command.Item value={`toggle pdf preview ${t("common.togglePdfPreview")}`} onSelect={run(() => toggle("pdf"))}>
                  <PanelRight size={15} /> {t("common.togglePdfPreview")}
                </Command.Item>
                <Command.Item value={`publish github ${t("common.publishToGithub")}`} onSelect={run(() => openDialog({ kind: "publish", project: project.name }))}>
                  <Github size={15} /> {t("common.publishToGithub")}
                </Command.Item>
              </>
            )}
            <Command.Item value={`ai assistant chat claude ${t("common.aiAssistant")}`} onSelect={run(() => toggle("chat"))}>
              <Sparkles size={15} /> {t("common.aiAssistant")} <span className="right">{kChat}</span>
            </Command.Item>
            <Command.Item value={`new project ${t("common.newProject")}`} onSelect={run(() => openDialog({ kind: "new-project" }))}>
              <Plus size={15} /> {t("common.newProject")}
            </Command.Item>
            <Command.Item value={`import zip ${t("common.importZip")}`} onSelect={run(importZipFlow)}>
              <FileArchive size={15} /> {t("common.importZip")}
            </Command.Item>
            <Command.Item value={`clone github ${t("common.cloneFromGithub")}`} onSelect={run(() => openDialog({ kind: "clone" }))}>
              <Github size={15} /> {t("common.cloneFromGithub")}
            </Command.Item>
            <Command.Item value={`all projects home ${t("common.allProjects")}`} onSelect={run(() => openProject(null))}>
              <LayoutGrid size={15} /> {t("common.allProjects")}
            </Command.Item>
          </Command.Group>
          <Command.Group heading={t("common.settings")}>
            {TABS.map(([id, label, icon]) => (
              <Command.Item key={id} value={`settings preferences ${id} ${t(label)}`} onSelect={run(() => setUi({ settings: id }))}>
                {icon} {t(label)}
                {id === "general" && kSettings && <span className="right">{kSettings}</span>}
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading={t("common.projects")}>
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
