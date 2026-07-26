# hepi-mono

Bun monorepo for HEPI Pi Coding Agent extensions. Every publishable workspace under `packages/` is maintained under the `@hheei` scope.

## Documentation

- [Getting started](docs/user/getting-started.md)
- [Package catalogue](docs/user/packages.md)
- [Extension development](docs/development/extension-development.md)
- [Documentation index](docs/README.md)
- [TUI design](DESIGN.md)
- [TypeScript design](DESIGN_TS.md)

Package-specific commands, settings, persistence, requirements, and incompatibilities live in each `packages/*/README.md` so the documentation ships with the package. The optional `pi-magic-context` fork is a git submodule and is maintained upstream; HEPI only provides the repository compatibility wiring.

## Install

Install all current runtime modules through the unified package:

```bash
pi install npm:@hheei/hepi-mono
```

Or install one-entry groups when you want a smaller selection:

```bash
pi install npm:@hheei/hepi-basics
pi install npm:@hheei/hepi-tools
pi install npm:@hheei/hepi-skills
```

Each group is self-contained. Do not install a group together with the same
individual packages:

```bash
pi install npm:@hheei/pi-basics
pi install npm:@hheei/pi-todo
```

Do not enable `@hheei/hepi-mono` together with the same individual packages. That can register duplicate commands, handlers, status entries, or Settings providers.

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

Load `@hheei/pi-basics` before feature packages. Loadout must run after Pi Basics so both use the same tool-activation coordinator. The three group packages and unified `@hheei/hepi-mono` preserve this order. Each group has one Pi extension entry; `hepi-mono` remains the one-entry full profile.

Create a package from the extension template:

```bash
bun run new:extension -- pi-my-extension
```

## Repository Layout

```text
packages/       HEPI-owned publishable workspaces
  pi-magic-context/  upstream Magic Context git submodule

docs/
  user/         Cross-package usage
  development/  Contributor workflows
  architecture/ Current architecture notes
  research/     Evidence and prior design research
  plans/        Completed implementation context

references/
  README.md     Public source catalogue and pinned revisions
  repos/        Ignored local clones

scripts/        Repository development commands
templates/      Extension generator inputs
```

`graphify-out/`, `outputs/`, `.pi/`, and `.pi-subagents/` are local generated state and are not versioned. External source clones are references only: they are not workspace packages, dependencies, or behavior contracts.
