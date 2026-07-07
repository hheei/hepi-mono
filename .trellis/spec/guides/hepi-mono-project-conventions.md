# HEPI Mono Project Conventions

Use this guide when changing any package in `hepi-mono`. These rules are based on the current repository docs and source, not aspirational cleanup goals.

## Monorepo Layout

- The root is a Bun workspace with one Pi extension package per directory under `packages/*`.
- Publishable packages use the `@hheei/pi-*` package name pattern and an unscoped matching directory name, for example `@hheei/pi-inturl` in `packages/pi-inturl`.
- Extension package manifests should keep `type: "module"`, `main: "src/index.ts"`, and a `pi.extensions` entry pointing at the TypeScript source entry.
- Shared reusable extension infrastructure belongs in `packages/pi-extcore`. Do not move one-off package behavior into `pi-extcore` unless another extension is expected to reuse it.

Examples:

- `packages/pi-inturl/package.json`
- `packages/pi-loadout/package.json`
- `packages/pi-extcore/src/extension.ts`

## Development Commands

Run project checks from the repository root:

```bash
bun run check
```

The root check runs Biome, TypeScript, and Bun tests. Use package-local test scripts only when intentionally narrowing the feedback loop; the root check remains the release-quality signal.

Formatting and lint conventions are controlled by `biome.json`:

- tabs for indentation
- double quotes in JavaScript and TypeScript
- 100-column formatter width
- recommended lint rules
- unused imports are errors
- unused variables are warnings
- explicit `any` and non-null assertions are allowed when needed

TypeScript conventions are controlled by `tsconfig.base.json`:

- `strict: true`
- `module` and `moduleResolution`: `Node16`
- `target`: `ES2022`
- `noUncheckedIndexedAccess: true`
- no emitted output from type checking

## Extension Entry Points

Pi loads extension TypeScript entries directly. A normal extension exports a default function that accepts `ExtensionAPI` and registers commands, tools, hooks, or settings.

Examples:

- `packages/pi-codex-dollar/src/index.ts` registers settings, a session editor modifier, and input transformation.
- `packages/pi-inturl/src/index.ts` registers settings and a `tool_call` path expansion hook.
- `packages/pi-ssh/src/index.ts` registers tools and shared settings.
- `packages/pi-extcore/src/extension.ts` registers the shared `/extension-setting` command.

## Settings Conventions

Extension settings are centralized through `@hheei/pi-extcore`.

- Use `registerExtensionSettings()` for extension settings.
- Do not create package-specific settings commands when the setting belongs under `/extension-setting`.
- Use `groups` for settings in the extension pane.
- Use `generalGroups` only when a setting belongs in the global General pane.
- Use `display: "plain"` for groups whose fields should render directly.
- Use `display: "hidden"` for state controlled by a custom subpanel.
- Settings parsers should tolerate missing or malformed persisted state and fall back to defaults.

Examples:

- `packages/pi-extcore/src/settings/register.ts`
- `packages/pi-extcore/src/settings/types.ts`
- `packages/pi-loadout/src/index.ts`
- `packages/pi-inturl/src/index.ts`
- `packages/pi-ssh/src/index.ts`

## TUI Conventions

Prefer Pi and `@earendil-works/pi-tui` primitives over custom terminal rendering.

Common choices:

- settings and toggles: `/extension-setting` through `pi-extcore`
- reusable grouped toggles: `createGroupedTogglePicker()` from `pi-extcore`
- row/detail layouts: `renderRowsWithSidePanel()` and related helpers from `pi-extcore`
- structured components: `Container`, `Text`, `Input`, `SettingsList`, `DynamicBorder`

Custom TUI components should:

- fit every rendered line to the provided width
- call `requestRender()` after state changes
- use the `theme` object from the UI callback
- implement `invalidate()` when they cache or delegate rendering
- keep non-obvious keyboard shortcuts visible in hint text

Examples:

- `packages/pi-extcore/src/tui/grouped-toggle-picker.ts`
- `packages/pi-extcore/src/tui/panels.ts`
- `packages/pi-loadout/src/tui.ts`
- `docs/tui-panel-layouts.md`

## Validation and Safety Patterns

Validate unknown inputs at package boundaries before mutating state or spawning processes.

Examples:

- `packages/pi-ssh/src/ssh-exec.ts` validates SSH tool args and rejects host values with whitespace, control characters, or leading `-`.
- `packages/pi-inturl/src/index.ts` rejects absolute `tmp://` paths, path traversal, null bytes, and invalid URL encoding.
- `packages/pi-loadout/src/index.ts` parses persisted branch/global state defensively and falls back when malformed.

Long-running or output-heavy process helpers should cap retained output and report truncation metadata instead of returning unbounded streams. SSH output should pass through the `SessionManager` sanitizer before being returned to the model or UI.

Examples:

- `packages/pi-ssh/src/stream-output.ts`
- `packages/pi-ssh/src/session-manager.ts`
- `packages/pi-ssh/src/ssh-exec.ts`

## Test Conventions

Tests use `bun:test` and live under each package's `test/` directory. Prefer focused behavior tests around exported functions, extension integration seams, safety validation, and TUI render helpers.

Current examples:

- parser/rendering/editor tests in `packages/pi-codex-dollar/test/`
- settings state/storage/panel tests in `packages/pi-extcore/test/`
- path shortcut safety tests in `packages/pi-inturl/test/path-shortcuts.test.ts`
- loadout storage and TUI tests in `packages/pi-loadout/test/`
- SSH process/session/output tests in `packages/pi-ssh/test/`

Before reporting a change as complete, run `bun run check` from the repository root unless the task explicitly only changes non-code docs and the user accepts narrower verification.
