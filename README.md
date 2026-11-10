# QuillTex

A lightweight, local-first LaTeX editor (Tauri 2 + React) with Git/GitHub sync and an AI assistant (Claude Code or OpenRouter).

- **Projects are plain folders** in `~/Documents/QuillTex/<project>` (configurable). Open them in Finder or any editor.
  Per-project settings live in `.quilltex/project.json`; build output in `.quilltex/build/` (git-ignored).
- **Compiles isolated** with a bundled [Tectonic](https://tectonic-typesetting.github.io), or with pdfLaTeX/XeLaTeX/LuaLaTeX
  from QuillTex's own TeX Live ([TinyTeX](https://yihui.org/tinytex/), shipped inside the app and unpacked into the app
  data dir). Both come ready for the project templates, so new projects compile offline. Other packages are installed
  on demand, in batches: what the sources name before the first run, then whatever a run still reports missing. Neither is ever put on your PATH, and a TeX installed on the computer is
  never used. Imported projects that bring a `.latexmkrc` compile with TeX Live the way Overleaf would.
- **Documents without LaTeX**: the *Document* template creates a `main.md` written in plain Markdown (headings,
  bold/italic/<u>underline</u>, `<span style="color: …">` color, lists, checklists, tables, images, links, quotes), with page setup (title, author,
  date, font, size, spacing, margins, paper, numbered headings) in the file's front matter. Where the PDF usually is,
  a live preview lays the document out in pages as it will print, updating as you type. It is still plain text, so
  Git history and the AI assistant work as usual; for the PDF download QuillTex turns it into LaTeX
  (`crates/core/src/markdown.rs`) and compiles it with the same engines.
- **Overleaf basics**: new/template projects, import ZIP (drag a .zip onto the home screen), export ZIP, download PDF,
  file tree with drag & drop, logs with clickable errors, SyncTeX (⌘-click in editor or PDF), `\ref`/`\cite` completion.
- **Git** via the `git` installed on your computer, so your own config, credential helpers and SSH keys apply: stage,
  commit, branches, merge with conflict resolution, pull, push. Background fetch keeps a sync badge current (synced / ↑ to push / ↓ to pull / diverged).
- **GitHub** via your [GitHub CLI](https://cli.github.com) (`gh`) sign-in; QuillTex stores no tokens. Publish a project as a
  new repo or clone one.
- **AI assistant**: pick a provider in *Settings → AI*. With **Claude Code** the side chat drives your installed CLI
  (`claude -p`) with only QuillTex's MCP tools enabled (no shell/file/web tools, neutral working dir). With
  **OpenRouter** you paste your own API key and choose a model; the app runs the same tools in-process, and shows the
  key's credits and clear errors (invalid key, no credits, model without tool support…). Either way it can manage
  projects but nothing else. Optionally register the MCP server with Claude Code to use it from your terminal.
- **AI commit**: one click in Source Control groups the pending changes into commits by scope and writes each message
  as a plain sentence about the document, in the app's language.

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
crates/mcp      quilltex-mcp: QuillTex tools, as an MCP stdio server for Claude Code and a library for OpenRouter
src-tauri       desktop app: IPC commands, watcher, sync loop, GitHub, chat, uninstall
src             React UI
```
