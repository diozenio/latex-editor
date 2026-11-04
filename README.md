# QuillTex

A lightweight, local-first LaTeX editor (Tauri 2 + React) with Git/GitHub sync and a Claude Code assistant.

- **Projects are plain folders** in `~/Documents/QuillTex/<project>` (configurable). Open them in Finder or any editor.
  Per-project settings live in `.quilltex/project.json`; build output in `.quilltex/build/` (git-ignored).
- **Compiles isolated** with a bundled [Tectonic](https://tectonic-typesetting.github.io), or with pdfLaTeX/XeLaTeX/LuaLaTeX
  from QuillTex's own TeX Live ([TinyTeX](https://yihui.org/tinytex/), shipped inside the app and unpacked into the app
  data dir). Both come ready for the project templates, so new projects compile offline. Other packages are installed
  on demand, in batches: what the sources name before the first run, then whatever a run still reports missing. Neither is ever put on your PATH, and a TeX installed on the computer is
  never used. Imported projects that bring a `.latexmkrc` compile with TeX Live the way Overleaf would.
- **Overleaf basics**: new/template projects, import ZIP (drag a .zip onto the home screen), export ZIP, download PDF,
  file tree with drag & drop, logs with clickable errors, SyncTeX (⌘-click in editor or PDF), `\ref`/`\cite` completion.
- **Git** via the `git` installed on your computer, so your own config, credential helpers and SSH keys apply: stage,
  commit, branches, merge with conflict resolution, pull, push. Background fetch keeps a sync badge current (synced / ↑ to push / ↓ to pull / diverged).
- **GitHub** via your [GitHub CLI](https://cli.github.com) (`gh`) sign-in; QuillTex stores no tokens. Publish a project as a
  new repo or clone one.
- **AI assistant**: the side chat drives your installed Claude Code (`claude -p`) with only QuillTex's MCP tools enabled
  (no shell/file/web tools, neutral working dir), so it can manage projects but nothing else. Optionally register the
  same MCP server with Claude Code to use it from your terminal.

## Develop

```sh
pnpm install
pnpm app:dev         # fetches Tectonic, builds quilltex-mcp, prepares the bundled engine files, then `tauri dev`
cargo test -p quilltex-core -p quilltex-mcp
```

## Build installers

```sh
pnpm app:build      # .app/.dmg on macOS, NSIS .exe on Windows, .deb/.AppImage on Linux
```

Every push to `main` builds all platforms (`.github/workflows/release.yml`) and publishes them as the latest release.
The version is `major.minor` from `src-tauri/tauri.conf.json` plus the workflow run number as the patch.

## GitHub setup

Nothing to create. Install `git` and the GitHub CLI (`brew install gh` on macOS). If `gh auth login` was already run on
this computer, QuillTex picks it up; otherwise Settings → GitHub → *Sign in with GitHub* runs `gh auth login --web` and opens
the browser. For github.com remotes, git gets credentials from `gh` (like `gh auth setup-git`, but without changing
your git config).

## Uninstalling

- **macOS / Linux**: QuillTex menu → *Uninstall QuillTex…* removes app data, cache and the Claude Code MCP
  registration, and optionally moves your projects to the Trash. On macOS the app bundle goes to the Trash too.
- **Windows**: the standard uninstaller has a checkbox for app data and asks whether to delete your projects.

## Layout

```
crates/core     shared logic: path sandbox, projects, files, zip, compile, synctex, git, gh
crates/mcp      quilltex-mcp: MCP stdio server used by Claude Code
src-tauri       desktop app: IPC commands, watcher, sync loop, GitHub, chat, uninstall
src             React UI
```
