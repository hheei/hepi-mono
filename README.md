# hepi-mono

Bun monorepo for HEPI Pi Coding Agent extensions. Every publishable workspace under `packages/` is maintained under the `@hheei` scope.

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

```bash
bun run typecheck
bun test
bun run check
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
  pi-subagents/   Optional external Pi extension source

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
