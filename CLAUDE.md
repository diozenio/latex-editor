# QuillTex

Editor LaTeX local-first (Tauri 2 + React + Rust). Veja o `README.md` para a visão geral do produto.

## Estrutura

- `src/` — frontend React/TypeScript (Vite, zustand, CodeMirror).
- `src-tauri/` — app Tauri (comandos, updater).
- `crates/core` (`quilltex-core`) — lógica de projetos, compilação, git.
- `crates/mcp` (`quilltex-mcp`) — servidor MCP usado pelo assistente.
- `scripts/` — `fetch-sidecars.mjs` baixa Tectonic e compila o sidecar MCP.

## Comandos

```sh
npm install                              # também instala os hooks do husky (script prepare)
npm run app:dev                          # desenvolvimento (tauri dev)
npm run build                            # tsc + vite build
cargo test -p quilltex-core -p quilltex-mcp
npx biome check --write <arquivos>       # formata e lint (Biome)
npm run commit                           # assistente de commit (commitizen)
```

## Commits e releases

- Siga Conventional Commits; detalhes em `CONTRIBUTING.md`.
- Escopos permitidos (validados pelo commitlint): `app`, `core`, `mcp`, `ui`, `chat`, `deps`, `scripts`, `release`, `readme`, `config`.
- **Todo commit passa pela skill `staged-atomic-commits`** (`.claude/skills/`). Nunca rode `git commit` direto: o hook `.claude/hooks/require-commit-skill.sh` bloqueia commits sem o marcador da skill. Não adicione `Co-Authored-By` nem menção a IA.
- Os hooks do husky (`.husky/`) rodam `lint-staged` (Biome) no pre-commit e `commitlint` no commit-msg. Nunca use `--no-verify`.
- A versão é gerenciada pelo release-please a partir dos commits na `main`. Não edite a versão manualmente em `package.json`, `Cargo.toml`, `tauri.conf.json` nem os lockfiles, e não edite o `CHANGELOG.md` à mão.

## Convenções de código

- TypeScript/React: aspas duplas, ponto e vírgula, indentação de 2 espaços (Biome). O lint tem regras de a11y e hooks desligadas de propósito para manter a base atual limpa.
- Mensagens de commit em inglês, modo imperativo, minúsculas, sem ponto final.
