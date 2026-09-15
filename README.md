# hepi-mono

Node/pnpm monorepo for HEPI Pi Coding Agent extensions. Every publishable workspace under `packages/` is maintained under the `@hheei` scope.

## Documentation

[Documentation index](docs/README.md) links user, development, and architecture topics. [DESIGN.md](DESIGN.md) is the required specification for HEPI UI and UX work.

## Install

Install only the extensions you need:

```bash
pi install npm:@hheei/pi-ext-tools
```

Independent extensions install separately:

```bash
pi install npm:@hheei/pi-t2s
```

Concrete extensions use `@hheei/pi-ext-core` as a shared foundation dependency;
ext-core is not itself an installable Pi extension. See the
[package catalogue](docs/user/packages.md) for available extensions and local-only packages.

For a local checkout, use Node.js >=22.19.0, pnpm >=12.4.1, and stable Rust for
the `pi-ext-tools` native bridge. Run from the repository root:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @hheei/pi-ext-core run build
pnpm --filter @hheei/pi-ext-tools run build:native
pnpm --filter @hheei/pi-ext-tools run build
pi install ./packages/pi-ext-tools
```

Use `pi install -l ...` for project-local installation. For an uninstalled development
run, see [Getting started](docs/user/getting-started.md).

## Repository Layout

```text
packages/       Extension workspaces, ext-core foundation, and local-only packages

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
crates/         Native bridge and vendored Rust dependencies
```

## Local State and References

`graphify-out/`, `outputs/`, and `.pi/` are local generated state and are not versioned. External source clones under `references/repos/` are references only: they are not workspace packages, dependencies, or behavior contracts.
