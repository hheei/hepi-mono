# hepi-mono

Bun monorepo for HEPI Pi Coding Agent extensions. Every publishable workspace under `packages/` is maintained under the `@hheei` scope.

## Documentation

- [Getting started](docs/user/getting-started.md)
- [Package catalogue](docs/user/packages.md)
- [Extension development](docs/development/extension-development.md)
- [Documentation index](docs/README.md)
- [TUI design](DESIGN.md)
- [TypeScript design](DESIGN_TS.md)

Package-specific commands, settings, persistence, requirements, and incompatibilities live in each `packages/*/README.md` so the documentation ships with the package.

## Install

```bash
bun install
```

Install local extensions through Pi:

```bash
pi install ./packages/pi-basics
pi install ./packages/pi-todo
```

Use `-l` for project-local installation.

## Development

```bash
bun run typecheck
bun test
bun run check
```

Run Pi with automatic extension discovery disabled:

```bash
bun run pi:dev                         # pi-basics only
bun run pi:dev -- basics todo          # selected workspaces
bun run pi:dev -- --all                # every workspace extension
bun run pi:dev -- basics -- --model openai/gpt-5
```

Load `pi-basics` before feature packages. Loadout must run after Pi Basics so both use the same tool-activation coordinator.

Create a package from the extension template:

```bash
bun run new:extension -- pi-my-extension
```

## Repository Layout

```text
packages/       HEPI-owned publishable workspaces

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
