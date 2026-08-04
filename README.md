# hepi-mono

Bun monorepo for HEPI Pi Coding Agent extensions. Every publishable workspace under `packages/` is maintained under the `@hheei` scope.

## Documentation

[Documentation index](docs/README.md) links user, development, and architecture topics. [DESIGN.md](DESIGN.md) is the required specification for HEPI UI and UX work.

## Install

`@hheei/hepi-mono` is deprecated. Install only the extensions you need:

```bash
pi install npm:@hheei/hepi-basics
pi install npm:@hheei/hepi-tools
pi install npm:@hheei/hepi-mctx
pi install npm:@hheei/hepi-skills
pi install npm:@hheei/pi-ponytail
pi install npm:@hheei/pi-caveman
```

`@hheei/hepi-skills` is transitional; choose it or the independent mode
packages, not both.

These aggregate packages are transitional. Independent extensions install separately:

```bash
pi install npm:@hheei/pi-t2s
```

New features will be published as independent extensions built on
`@hheei/pi-ext-core`.

For a local checkout:

```bash
bun install
pi install ./packages/hepi-basics
```

Use `-l` for project-local installation.

## Repository Layout

```text
packages/       HEPI-owned publishable workspaces
  hepi-subagents/  Pinned external fork submodule, excluded from workspaces

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

`graphify-out/`, `outputs/`, `.pi/`, and `.pi-subagents/` are local generated state and are not versioned. External source clones under `references/repos/` are references only: they are not workspace packages, dependencies, or behavior contracts.
