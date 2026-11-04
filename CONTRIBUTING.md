# Contribuindo

## Setup

```sh
pnpm install  # instala as dependências e ativa os hooks do husky
```

## Convenção de commits e releases

O projeto usa [Conventional Commits](https://www.conventionalcommits.org) e [SemVer](https://semver.org). A versão, o `CHANGELOG.md`, a tag e o GitHub Release são gerados automaticamente pelo [release-please](https://github.com/googleapis/release-please).

### Formato

```
tipo(escopo): descrição curta no imperativo
```

Escopos permitidos: `app`, `core`, `mcp`, `ui`, `chat`, `deps`, `scripts`, `release`, `readme`, `config`.

### Tipos e efeito na versão

| Tipo | Efeito | Exemplo |
|---|---|---|
| `fix` | patch (1.0.0 → 1.0.1) | `fix(core): refuse writes into a missing folder` |
| `feat` | minor (1.0.0 → 1.1.0) | `feat(ui): add dark mode` |
| `feat!` / `BREAKING CHANGE:` | major (1.0.0 → 2.0.0) | `feat(core)!: change project metadata format` |
| `perf`, `revert` | aparecem no changelog | `perf(core): cache tex live lookup` |
| `docs`, `refactor`, `build`, `chore`, `test`, `ci`, `style` | não geram release | `docs(readme): rename project` |

### Como fazer commits

- `pnpm commit` abre um assistente interativo (commitizen).
- Ou escreva a mensagem manualmente. O hook `commit-msg` (commitlint) rejeita mensagens fora do padrão, e o `pre-commit` roda o Biome nos arquivos staged.
- Com Claude Code, os commits são feitos pela skill `staged-atomic-commits` (ver `CLAUDE.md`).

### Pull requests e squash merge

O merge é **squash** e o **título do PR vira a mensagem do commit na `main`**. Por isso o título do PR precisa seguir o formato acima; o workflow `PR title` valida isso. É o título do PR que decide o tipo de versão.

### Como o release funciona

1. A cada merge na `main`, o release-please abre ou atualiza o PR **"chore(main): release X.Y.Z"** com a versão nova e o changelog.
2. Quando você faz merge desse PR, ele cria a tag `vX.Y.Z` e o GitHub Release.
3. O mesmo workflow chama `release.yml`, que compila os instaladores (macOS, Windows, Linux) e publica os artefatos e o `latest.json` do updater no release.

Versão e changelog ficam em `package.json`, `Cargo.toml`, `Cargo.lock`, `src-tauri/tauri.conf.json` e `CHANGELOG.md`, atualizados apenas pelo PR de release. Não edite à mão.

## Estilo de código

O Biome cuida de formatação e lint. O pre-commit aplica `biome check --write` nos arquivos staged.
