# hepi-mono

Bun monorepo for HEPI Pi Coding Agent extensions. HEPI packages live under `packages/`; Magic Context is a Pi-only fork submodule at `packages/hepi-mctx`.

## Documentation

- [Getting started](docs/user/getting-started.md)
- [Package catalogue](docs/user/packages.md)
- [Extension development](docs/development/extension-development.md)
- [Documentation index](docs/README.md)
- [TUI design](DESIGN.md)
- [Pi source design](.pi/skills/pi-development/references/DESIGN.md)

Package-specific commands, settings, persistence, requirements, and incompatibilities live in each `packages/*/README.md` so the documentation ships with the package.

## Install

Install all current runtime modules:

```bash
pi install npm:@hheei/hepi-mono
```

Install individual packages when you need a selective composition:

```bash
pi install npm:@hheei/hepi-basics
pi install npm:@hheei/hepi-tools
pi install npm:@hheei/hepi-skills
pi install npm:@hheei/hepi-aft
pi install npm:@hheei/hepi-mctx
```

Do not install an individual package with `hepi-mono`, because their
implementations overlap.

For a local checkout:

```bash
bun install
pi install ./packages/hepi-mono
```

Use `-l` for project-local installation.

## Development

For a code change, run Biome on changed paths and only its affected tests:

```bash
bunx biome check packages/<package>/src/<file>.ts packages/<package>/test/<file>.test.ts
bun test packages/<package>/test/<file>.test.ts
```

Repeat those checks before committing. Run the full suite only when explicitly
requested or in CI. Build aggregates when testing an extension entry locally:

```bash
bun run build:aggregates
```

Run a local aggregate entry directly with Pi:

```bash
bun run build:aggregates
pi --no-extensions --no-skills -e packages/hepi-mono/dist/extension.js
pi --no-extensions --no-skills -e packages/hepi-basics/dist/extension.js
pi --no-extensions --no-skills -e packages/hepi-tools/dist/extension.js
pi --no-extensions --no-skills -e packages/hepi-skills/dist/extension.js
```

`hepi-mono` is the full runtime bundle. `hepi-debug` remains development-only.

## Release

Published npm tarballs contain generated `dist` output. Git tracks source only.

```bash
bun run pack:check
```

## Repository Layout

```text
packages/       HEPI-owned publishable workspaces

third_party/     Pinned external fork submodules, excluded from workspaces
  magic-context/  Shared Magic Context core bundled by hepi-mctx
  pi-subagents/   @hheei/hepi-subagents npm package source and Mono runtime dependency

docs/
  user/         Cross-package usage
  development/  Contributor workflows
  architecture/ Current architecture notes
  research/     Evidence and prior design research
  plans/        Completed implementation context

 scripts/        Repository development commands
templates/      Extension generator inputs
```

`graphify-out/`, `outputs/`, `.pi/`, and `.pi-subagents/` are local generated state and are not versioned.
