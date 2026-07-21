# Pi Basics Development

This guide describes the current architecture and development workflow for `@hheei/pi-basics`. See the [package README](../packages/pi-basics/README.md) for user-facing commands and behavior, and [DESIGN.md](../DESIGN.md) for TUI rules.

## Responsibilities

Pi Basics is the foundational HEPI extension. Its entry point is `packages/pi-basics/src/index.ts`, which installs session-scoped features and coordinates their lifecycle:

- `/hepi` Settings and Loadout shell
- Goal, Ask, Plan Mode, and Todo
- statusbar and editor rail
- automatic session titles
- tool and skill activation through Loadout
- shared module, settings, registry, and lifecycle APIs

Do not load `@hheei/pi-loadout` in the same Pi process. Both packages own the host active-tool list.

## Source Layout

```text
packages/pi-basics/
  src/
    api/             Public settings, module, panel, and contribution contracts
    command/         /hepi command routing
    contributions/   Session UI contributions such as the statusbar
    modules/         Goal, Ask, Plan, Todo, Settings, Loadout, and shell features
    runtime/         Session context, lifecycle, registry, and tool activation
    ui/              Shared terminal text and structural TUI primitives
    index.ts          Pi extension entry point and public exports
  test/              Tests mirror the source areas
```

Feature code belongs in its module. Move code to `src/ui/` only when multiple TUI surfaces use the same structural rule. Move code to `src/runtime/` only when it coordinates multiple features or owns session lifecycle.

## Runtime Lifecycle

`HePiLifecycleController` creates one runtime context for the active Pi session. Features register cleanup through the runtime registry. Cleanup must be idempotent and must restore any host UI seam or state the feature replaced.

The extension entry point owns cross-feature startup order. A feature should expose a small start/dispose interface instead of subscribing independently to overlapping session events.

Runtime state is session-scoped unless a feature explicitly documents persistent storage. Do not add global mutable state that can leak between sessions.

## Public Integration APIs

Use the package root exports rather than importing internal files.

### Settings providers

```ts
import { registerHePiSettings, type HePiSettingsProvider } from "@hheei/pi-basics";

const provider: HePiSettingsProvider = {
  id: "my-extension",
  title: "My Extension",
  origin: "@hheei/pi-my-extension",
  groups: [],
};

registerHePiSettings(provider);
```

Providers are read when `/hepi setting` opens. Use stable provider, group, and field ids. Set `origin` to the owning package identifier shown in the Description panel. Choose storage according to the intended scope; do not treat session, project, and global persistence as interchangeable.

### HEPI modules

```ts
import { registerHePiModule } from "@hheei/pi-basics";

registerHePiModule({
  id: "my-module",
  label: "My Module",
  open: async (context) => {
    // Open the module in the active HEPI session.
  },
});
```

`registerHePiModule()` without an explicit registry requires exactly one active Pi Basics session. Registration before session startup or across ambiguous active sessions throws. Prefer settings providers unless the integration needs a distinct `/hepi` module.

Other public exports include lifecycle and registry helpers, Loadout inventory/storage/controller APIs, Goal and Plan contracts, settings modules, and the tool activation coordinator. Add a root export deliberately; it becomes supported package API.

## TUI Development

Follow [DESIGN.md](../DESIGN.md). Current shared primitives include:

- `renderDetailPanel()` for Description/detail framing, wrapping, padding, and clipping
- `createSplitLayout()` for the shared 75-column split breakpoint and three-cell gap
- `renderSelectableRow()` for a stable two-cell selection slot
- `keyGlyph` for `↕`, `↔`, `↵`, `⎋`, `␣`, and `⇥`

Use Pi TUI components for stateful composition and the helpers in `src/ui/` for cell-safe rendering. Every rendered line must fit the supplied terminal width. State changes must call `requestRender()`, and cached components must implement `invalidate()`.

Do not create a feature-local Description frame, breakpoint vocabulary, cursor slot, or hint glyph set. Ask, Plan, Settings, and Loadout may retain different information architecture while sharing these structural rules.

## Local Development

Install dependencies at repository root:

```bash
bun install
```

Run Pi with only Pi Basics loaded:

```bash
bun run pi:dev -- basics
```

Pass Pi flags after a second `--`:

```bash
bun run pi:dev -- basics -- --model openai/gpt-5
```

Useful interactive checks:

```text
/hepi setting
/hepi loadout
/goal <objective>
/plan <prompt>
/todos
```

Do not include `loadout` in the same invocation as `basics`.

## Verification

Run focused tests while iterating:

```bash
bun test packages/pi-basics/test/modules/ask
bun test packages/pi-basics/test/modules/loadout
bun test packages/pi-basics/test/ui
```

Before finishing a Pi Basics change, run:

```bash
bun run typecheck
bunx biome check packages/pi-basics/src packages/pi-basics/test
bun test packages/pi-basics/test
```

Use `packages/pi-basics/test/tui-replay.test.ts` for replay, resize, ANSI, and screenshot behavior. Add cell-width and narrow-terminal cases when changing rendering. Shared primitives need direct tests under `test/ui/`; feature behavior belongs in the matching module tests.

## Change Checklist

- Keep the extension entry point focused on wiring and lifecycle coordination.
- Preserve session isolation and idempotent cleanup.
- Use package-root exports for supported integrations.
- Keep rendered lines ANSI- and cell-width-safe.
- Test both narrow and wide layouts for TUI changes.
- Update the package README when commands or user-visible behavior change.
- Update `DESIGN.md` when changing a shared visual or interaction rule.
- Put new proposals under `docs/plans/`, not at the top level of `docs/`.
