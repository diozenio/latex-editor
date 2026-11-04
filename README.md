# Folio

A lightweight, local-first LaTeX editor (Tauri 2 + React) with Git/GitHub sync and a Claude Code assistant.

- **Projects are plain folders** in `~/Documents/Folio/<project>` (configurable). Open them in Finder or any editor.
  Per-project settings live in `.folio/project.json`; build output in `.folio/build/` (git-ignored).
- **Compiles offline-isolated** with a bundled [Tectonic](https://tectonic-typesetting.github.io); packages are cached
  in Folio's own cache dir. If TeX Live / MacTeX / MiKTeX is installed you can pick pdfLaTeX/XeLaTeX/LuaLaTeX per project.
- **Overleaf basics**: new/template projects, import ZIP (drag a .zip onto the home screen), export ZIP, download PDF,
  file tree with drag & drop, logs with clickable errors, SyncTeX (⌘-click in editor or PDF), `\ref`/`\cite` completion.
- **Git** via the `git` installed on your computer, so your own config, credential helpers and SSH keys apply: stage,
  commit, branches, merge with conflict resolution, pull, push. Background fetch keeps a sync badge current (synced / ↑ to push / ↓ to pull / diverged).
- **GitHub** via your [GitHub CLI](https://cli.github.com) (`gh`) sign-in; Folio stores no tokens. Publish a project as a
  new repo or clone one.
- **AI assistant**: the side chat drives your installed Claude Code (`claude -p`) with only Folio's MCP tools enabled
  (no shell/file/web tools, neutral working dir), so it can manage projects but nothing else. Optionally register the
  same MCP server with Claude Code to use it from your terminal.

## Develop

```sh
npm install
npm run app:dev      # fetches Tectonic + builds folio-mcp, then `tauri dev`
cargo test -p folio-core -p folio-mcp
```

## Build installers

```sh
npm run app:build    # .app/.dmg on macOS, NSIS .exe on Windows, .deb/.AppImage on Linux
```

CI (`.github/workflows/release.yml`) builds all platforms on tag push.

## GitHub setup

Nothing to create. Install `git` and the GitHub CLI (`brew install gh` on macOS). If `gh auth login` was already run on
this computer, Folio picks it up; otherwise Settings → GitHub → *Sign in with GitHub* runs `gh auth login --web` and opens
the browser. For github.com remotes, git gets credentials from `gh` (like `gh auth setup-git`, but without changing
your git config).

## Uninstalling

- **macOS / Linux**: Folio menu → *Uninstall Folio…* removes app data, cache and the Claude Code MCP
  registration, and optionally moves your projects to the Trash. On macOS the app bundle goes to the Trash too.
- **Windows**: the standard uninstaller has a checkbox for app data and asks whether to delete your projects.

## Layout

```
crates/core     shared logic: path sandbox, projects, files, zip, compile, synctex, git, gh
crates/mcp      folio-mcp: MCP stdio server used by Claude Code
src-tauri       desktop app: IPC commands, watcher, sync loop, GitHub, chat, uninstall
src             React UI
```
