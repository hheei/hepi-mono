# Extension Development Guide

This guide covers repository-wide package conventions. For the foundational HEPI extension, continue with [Pi Basics Development](pi-basics-development.md).

## Package Layout

Use one package per extension:

```text
packages/
  pi-my-extension/
    package.json
    README.md
    src/index.ts
```

Package names use `@hheei/pi-xxxx`; directories use the matching unscoped name, such as `packages/pi-my-extension`.

Create a package from the template:

```bash
bun run new:extension -- pi-my-extension
```

The script also accepts `my-extension` and adds the `pi-` prefix.

## Extension Entry Point

Pi loads TypeScript extension entries through `jiti`, so packages normally expose `src/index.ts` directly:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI) {
  pi.registerCommand("pi-my-extension", {
    description: "Run my extension command",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Loaded", "info");
    },
  });
}
```

Declare the entry in `package.json`:

```json
{
  "name": "@hheei/pi-my-extension",
  "type": "module",
  "main": "src/index.ts",
  "pi": {
    "extensions": ["src/index.ts"]
  }
}
```

Publishable packages should also declare `files`, `keywords`, repository metadata, license, and Pi peer dependencies.

## Pi Basics Integration

`@hheei/pi-basics` owns the current HEPI runtime, `/hepi` Settings/Loadout shell, shared lifecycle, and foundational workflow features. New packages that integrate with HEPI should use its package-root APIs.

Use `registerHePiSettings()` to contribute settings to `/hepi setting`. Use `registerHePiModule()` only when a feature needs a distinct `/hepi` module. See [Pi Basics Development](pi-basics-development.md) for registration timing, persistence, lifecycle, TUI primitives, and tests.

Do not register a competing `/hepi` command, footer/editor rail, or active-tool owner without first defining how ownership composes. In particular, `@hheei/pi-basics` and `@hheei/pi-loadout` must not be loaded in the same Pi process.

`@hheei/pi-extcore`, `/extension-setting`, and the helpers in [TUI Panel Layout Helpers](tui-panel-layouts.md) remain available to packages that already depend on them. Treat them as legacy-compatible infrastructure; new HEPI integrations should target Pi Basics unless there is a concrete compatibility requirement.

## Forking Existing Extensions

When forking an existing extension, copy the upstream implementation and adapt it in small, reviewable steps. Preserve upstream behavior until a HEPI-specific difference is intentional and tested.

Keep upstream attribution and license files. Document where HEPI behavior diverges and avoid silently replacing a package's persistence or runtime ownership model.

## Local Testing

Install dependencies:

```bash
bun install
```

Run Pi with automatic extension and skill discovery disabled through the repository wrapper:

```bash
bun run pi:dev -- basics
bun run pi:dev -- inturl
bun run pi:dev -- --all
```

Pass Pi flags after a second `--`:

```bash
bun run pi:dev -- basics -- --model openai/gpt-5
```

Use only the packages required by the scenario. Avoid combinations with known ownership conflicts.

## Verification

Repository checks:

```bash
bun run typecheck
bun test
bun run check
```

Run package-focused tests while iterating, for example:

```bash
bun test packages/pi-basics/test
```

Format or apply safe lint fixes:

```bash
bun run format
bun run check:fix
```

A package README should document its commands, tools, persistence, host/version requirements, incompatible packages, and local test command.

## TUI Work

For Pi Basics interfaces, [DESIGN.md](../DESIGN.md) is normative. Use the shared primitives under `packages/pi-basics/src/ui/` and test narrow and wide terminal widths.

For other extensions:

- use Pi and `@earendil-works/pi-tui` components where possible
- keep every rendered line within the supplied cell width
- call `requestRender()` after state changes
- implement `invalidate()` when caching rendered content
- obtain theme functions from the custom UI context
- keep non-obvious keyboard actions visible in concise hint text

Existing `pi-extcore` table helpers are documented in [TUI Panel Layout Helpers](tui-panel-layouts.md), with examples in [examples/tui-panels.ts](examples/tui-panels.ts).

## Completion Checklist

- Package manifest declares the Pi entry and required metadata.
- Public commands and tools have stable names and documented behavior.
- HEPI settings/modules use Pi Basics package-root APIs.
- Runtime resources are session-scoped and cleanup is idempotent.
- TUI output is ANSI- and cell-width-safe.
- README covers usage, persistence, compatibility, and local testing.
- Focused tests and repository checks pass.
- New proposals live under `docs/plans/`; completed plans are not presented as current specifications.
