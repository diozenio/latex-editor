# QuillTex

Editor LaTeX local-first (Tauri 2 + React + Rust). Veja o `README.md` para a visão geral do produto.

## Estrutura

- `src/` — frontend React/TypeScript (Vite, zustand, CodeMirror).
- `src-tauri/` — app Tauri (comandos, updater).
- `crates/core` (`quilltex-core`) — lógica de projetos, compilação, git.
- `crates/mcp` (`quilltex-mcp`) — servidor MCP usado pelo assistente.
- `scripts/` — `fetch-sidecars.mjs` baixa Tectonic, compila o sidecar MCP e coloca os motores embutidos em `src-tauri/resources/` (cache do Tectonic e TinyTeX com os pacotes dos templates). Os motores prontos ficam na release `engines-<hash>` do GitHub (pré-release, nunca latest); o hash muda com as versões do Tectonic/TinyTeX, `templates.rs`, `prepare-engines.rs` ou `ENGINES_REVISION`. Sem release para o hash atual, o script prepara do zero e o CI publica.

## Comandos

```sh
pnpm install
pnpm app:dev                             # desenvolvimento (tauri dev)
pnpm build                               # tsc + vite build
cargo test -p quilltex-core -p quilltex-mcp
pnpm exec biome check --write <arquivos> # formata e lint (Biome)
```

## Commits e releases

- **Todo commit passa pela skill `staged-atomic-commits`** (`.claude/skills/`). Nunca rode `git commit` direto: o hook `.claude/hooks/require-commit-skill.sh` bloqueia commits sem o marcador da skill. Não adicione `Co-Authored-By` nem menção a IA.
- O workflow de release (`.github/workflows/release.yml`) roda só manualmente (Actions → Release → Run workflow, ou `gh workflow run release.yml`): builda as três plataformas e publica como latest. A versão é `major.minor` do `src-tauri/tauri.conf.json` mais o número do run como patch; para mudar major/minor, edite só o `tauri.conf.json`.
- Release local (sem Actions): `pnpm release:local` em cada máquina, no mesmo commit já enviado. A primeira cria a release como rascunho, as seguintes reaproveitam, e quando Windows e macOS estiverem no `latest.json` ela é publicada como latest.

## Convenções de código

- TypeScript/React: aspas duplas, ponto e vírgula, indentação de 2 espaços (Biome). O lint tem regras de a11y e hooks desligadas de propósito para manter a base atual limpa.
- Mensagens de commit em inglês, modo imperativo, minúsculas, sem ponto final.
