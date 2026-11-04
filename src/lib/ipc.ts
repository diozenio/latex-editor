import { invoke } from "@tauri-apps/api/core";

export type Engine = "tectonic" | "latexmk-pdflatex" | "latexmk-xelatex" | "latexmk-lualatex";

export interface ProjectMeta {
  id: string;
  mainFile: string;
  engine: Engine;
  color: string;
  autoCompile: boolean;
}

export interface ProjectSummary {
  name: string;
  path: string;
  meta: ProjectMeta;
  modified: number;
  hasGit: boolean;
}

export interface UsageWindow {
  kind: "five_hour" | "seven_day";
  /** 0..1 of the plan limit. */
  utilization: number;
  /** Unix seconds. */
  resetsAt: number;
  totalTokens: number;
  folioTokens: number;
  /** Claude Code doesn't report a token limit; this is derived from spend / utilization. */
  estimatedLimit: number | null;
}

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  file: string | null;
  line: number | null;
  message: string;
}

export interface CompileResult {
  ok: boolean;
  pdf: string | null;
  log: string;
  diagnostics: Diagnostic[];
  durationMs: number;
}

export interface FileStatus {
  path: string;
  kind: "new" | "modified" | "deleted" | "renamed" | "typechange" | "conflicted";
  staged: boolean;
  unstaged: boolean;
}

export interface RepoStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  remoteUrl: string | null;
  ahead: number;
  behind: number;
  files: FileStatus[];
  merging: boolean;
}

export interface Commit {
  id: string;
  short: string;
  summary: string;
  author: string;
  time: number;
  pushed: boolean;
}

export interface CommitFile {
  path: string;
  kind: "new" | "modified" | "deleted" | "typechange";
}

export interface Branch {
  name: string;
  isRemote: boolean;
  isHead: boolean;
}

export type MergeOutcome =
  | { type: "UpToDate" }
  | { type: "FastForward" }
  | { type: "Merged"; commit: string }
  | { type: "Conflicts"; files: string[] };

export interface GithubUser {
  login: string;
  name: string;
  email: string;
  avatarUrl: string;
}

export interface Settings {
  projectsRoot: string;
  githubUser: GithubUser | null;
  gitName: string;
  gitEmail: string;
  syncIntervalSecs: number;
  mcpRegistered: boolean;
  claudePath: string;
  editorFontSize: number;
  theme: "system" | "light" | "dark";
  chatModel: string;
}

export interface AppInfo {
  version: string;
  platform: "macos" | "windows" | "linux";
  projectsRoot: string;
  tectonic: boolean;
  systemTex: string | null;
  claude: string | null;
  ghInstalled: boolean;
  githubConnected: boolean;
}

export interface GithubStatus {
  installed: boolean;
  user: GithubUser | null;
}

export interface LoginCode {
  userCode: string;
  verificationUri: string;
}

export interface Repo {
  fullName: string;
  name: string;
  private: boolean;
  cloneUrl: string;
  description: string;
  updatedAt: string;
}

export interface PdfSpot {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SyncStatus {
  project: string;
  status: RepoStatus | null;
  error: string | null;
  checkedAt: number;
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),

  listProjects: () => invoke<ProjectSummary[]>("list_projects"),
  listTemplates: () => invoke<[string, string][]>("list_templates"),
  uniqueProjectName: (base: string) => invoke<string>("unique_project_name", { base }),
  createProject: (name: string, template: string) => invoke<ProjectSummary>("create_project", { name, template }),
  projectSummary: (name: string) => invoke<ProjectSummary>("project_summary", { name }),
  setProjectMeta: (name: string, meta: ProjectMeta) => invoke<void>("set_project_meta", { name, meta }),
  renameProject: (from: string, to: string) => invoke<ProjectSummary>("rename_project", { from, to }),
  duplicateProject: (from: string, to: string) => invoke<ProjectSummary>("duplicate_project", { from, to }),
  deleteProject: (name: string) => invoke<void>("delete_project", { name }),
  projectPath: (name: string, rel?: string) => invoke<string>("project_path", { name, rel }),
  importZip: (zipPath: string, name?: string) => invoke<ProjectSummary>("import_zip", { zipPath, name }),
  exportZip: (name: string, dest: string, includeGit: boolean) => invoke<void>("export_zip", { name, dest, includeGit }),

  fileTree: (project: string) => invoke<FileNode[]>("file_tree", { project }),
  readText: (project: string, path: string) => invoke<string>("read_text", { project, path }),
  readBinary: (project: string, path: string) => invoke<ArrayBuffer>("read_binary", { project, path }),
  writeText: (project: string, path: string, content: string) => invoke<void>("write_text", { project, path, content }),
  createDir: (project: string, path: string) => invoke<void>("create_dir", { project, path }),
  renamePath: (project: string, from: string, to: string) => invoke<void>("rename_path", { project, from, to }),
  deletePath: (project: string, path: string) => invoke<void>("delete_path", { project, path }),
  importFiles: (project: string, paths: string[], destDir: string) =>
    invoke<string[]>("import_files", { project, paths, destDir }),

  compile: (project: string) => invoke<CompileResult>("compile_project", { project }),
  cleanBuild: (project: string) => invoke<void>("clean_build", { project }),
  savePdfAs: (project: string, dest: string) => invoke<void>("save_pdf_as", { project, dest }),
  synctexForward: (project: string, file: string, line: number) =>
    invoke<PdfSpot[]>("synctex_forward", { project, file, line }),
  synctexInverse: (project: string, page: number, x: number, y: number) =>
    invoke<{ file: string; line: number } | null>("synctex_inverse", { project, page, x, y }),

  gitStatus: (project: string) => invoke<RepoStatus>("git_status", { project }),
  gitInit: (project: string) => invoke<void>("git_init", { project }),
  gitStage: (project: string, paths: string[]) => invoke<void>("git_stage", { project, paths }),
  gitStageAll: (project: string) => invoke<void>("git_stage_all", { project }),
  gitUnstage: (project: string, paths: string[]) => invoke<void>("git_unstage", { project, paths }),
  gitDiscard: (project: string, paths: string[]) => invoke<void>("git_discard", { project, paths }),
  gitCommit: (project: string, message: string) => invoke<string>("git_commit", { project, message }),
  gitLog: (project: string) => invoke<Commit[]>("git_log", { project }),
  gitCommitFiles: (project: string, id: string) => invoke<CommitFile[]>("git_commit_files", { project, id }),
  gitCommitDiff: (project: string, id: string, path: string) => invoke<string>("git_commit_diff", { project, id, path }),
  gitRestoreVersion: (project: string, id: string) => invoke<string>("git_restore_version", { project, id }),
  gitRevertCommit: (project: string, id: string) => invoke<string>("git_revert_commit", { project, id }),
  gitResetTo: (project: string, id: string) => invoke<void>("git_reset_to", { project, id }),
  gitDeleteCommit: (project: string, id: string) => invoke<void>("git_delete_commit", { project, id }),
  gitDiff: (project: string, path: string) => invoke<string>("git_diff", { project, path }),
  gitBranches: (project: string) => invoke<Branch[]>("git_branches", { project }),
  gitCreateBranch: (project: string, name: string) => invoke<void>("git_create_branch", { project, name }),
  gitCheckout: (project: string, name: string) => invoke<void>("git_checkout", { project, name }),
  gitDeleteBranch: (project: string, name: string) => invoke<void>("git_delete_branch", { project, name }),
  gitMerge: (project: string, from: string) => invoke<MergeOutcome>("git_merge", { project, from }),
  gitResolve: (project: string, path: string) => invoke<void>("git_resolve", { project, path }),
  gitAbortMerge: (project: string) => invoke<void>("git_abort_merge", { project }),
  gitSetRemote: (project: string, url: string) => invoke<void>("git_set_remote", { project, url }),
  gitFetch: (project: string) => invoke<RepoStatus>("git_fetch", { project }),
  gitPull: (project: string) => invoke<MergeOutcome>("git_pull", { project }),
  gitPush: (project: string) => invoke<void>("git_push", { project }),
  gitClone: (url: string, name: string) => invoke<ProjectSummary>("git_clone", { url, name }),
  syncNow: (project: string) => invoke<void>("sync_now", { project }),

  githubStatus: () => invoke<GithubStatus>("github_status"),
  githubLogin: () => invoke<GithubUser>("github_login"),
  githubLoginCancel: () => invoke<void>("github_login_cancel"),
  githubLogout: () => invoke<void>("github_logout"),
  githubRepos: () => invoke<Repo[]>("github_repos"),
  githubPublish: (project: string, repoName: string, isPrivate: boolean) =>
    invoke<string>("github_publish", { project, repoName, private: isPrivate }),

  chatSend: (chatId: string, message: string, sessionId: string | null, context: string) =>
    invoke<void>("chat_send", { chatId, message, sessionId, context }),
  chatCancel: (chatId: string) => invoke<void>("chat_cancel", { chatId }),
  claudeUsage: (refresh: boolean) => invoke<UsageWindow[]>("claude_usage", { refresh }),
  chatLoad: <T>(key: string) => invoke<T | null>("chat_load", { key }),
  chatSave: (key: string, data: unknown) => invoke<void>("chat_save", { key, data }),
  mcpRegister: () => invoke<void>("mcp_register"),
  mcpUnregister: () => invoke<void>("mcp_unregister"),

  uninstall: (deleteProjects: boolean) => invoke<string>("uninstall", { deleteProjects }),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
