# Initial Scan and Health Review

Date: 2026-07-07
Task: `.trellis/tasks/00-bootstrap-guidelines/`

## Scope

Scanned the existing Trellis setup, monorepo layout, package manifests, project docs, TypeScript source, tests, and root quality commands. This report records the first-pass health review so later Trellis work does not depend on chat history.

## Repository Shape

- Root package: `hepi-mono`, private Bun workspace using `packages/*`.
- Runtime target: Pi Coding Agent extension packages loaded from TypeScript source entries through `jiti`.
- Packages detected by Trellis and root workspace:
  - `packages/pi-codex-dollar`
  - `packages/pi-extcore`
  - `packages/pi-inturl`
  - `packages/pi-loadout`
  - `packages/pi-ssh`
- Shared docs exist under `docs/`, especially `docs/extension-development.md` and `docs/tui-panel-layouts.md`.
- Existing convention file found: `AGENTS.md`; no CLAUDE, Cursor, CONTRIBUTING, or EditorConfig convention files were found in the scan.

## Tooling Signals

- Package manager: Bun, declared as `bun@1.3.14` with engine `bun >=1.3.0`.
- Root check command: `biome check . && tsc --noEmit -p tsconfig.base.json && bun test`.
- TypeScript is strict, Node16 module resolution, ES2022 target, `noUncheckedIndexedAccess` enabled.
- Biome is configured as the formatter and linter with tabs, double quotes, 100-column line width, recommended rules, unused imports as errors, unused variables as warnings, explicit `any` allowed, and non-null assertions allowed.

## Validation Run

Command run:

```bash
bun run check
```

Result: passed.

Observed output summary:

- Biome checked 59 files with no fixes applied.
- TypeScript completed with `tsc --noEmit -p tsconfig.base.json`.
- Bun tests ran across all package test suites and passed.

## Test Coverage Shape

Test files are present in all packages:

- `packages/pi-codex-dollar/test/*.test.ts`
- `packages/pi-extcore/test/*.test.ts`
- `packages/pi-inturl/test/path-shortcuts.test.ts`
- `packages/pi-loadout/test/*.test.ts`
- `packages/pi-ssh/test/*.test.ts`

The test suite covers parsing/rendering/editor behavior, settings storage and panels, path shortcut safety, loadout TUI/storage behavior, SSH execution, SSH mount/session behavior, and output tailing.

## Healthy Patterns Found

- Package manifests consistently use `type: "module"`, `main: "src/index.ts"`, and `pi.extensions` entries.
- Shared extension settings are centralized through `@hheei/pi-extcore` and `/extension-setting`.
- Extension packages register settings with `registerExtensionSettings()` rather than creating package-specific settings commands.
- TUI code generally uses Pi / `@earendil-works/pi-tui` primitives and shared helpers from `pi-extcore`.
- Input validation is explicit in security-sensitive code, for example `validateSshExecArgs()`, `validateHost()`, `expandTmpPath()`, and settings-state parsing helpers.
- SSH tooling sanitizes sensitive output through the `SessionManager` before returning tool results.
- Output-heavy process helpers cap and report truncation metadata instead of returning unbounded output.
- No `TODO`, `FIXME`, `HACK`, or `XXX` markers were found under `packages`, `scripts`, or `templates`.

## Health Risks and Gaps

### Resolved: Trellis package specs were unfilled

Initial scan found that package/layer specs had not yet captured project conventions. Follow-up initialization filled backend and frontend specs for all detected packages with concrete rules and real file examples.

Completed packages:

- `pi-codex-dollar`
- `pi-extcore`
- `pi-inturl`
- `pi-loadout`
- `pi-ssh`

### Low: Root README package list is stale

`README.md` still mentions `packages/pi-example` in the layout block, while the current packages are `pi-codex-dollar`, `pi-extcore`, `pi-inturl`, `pi-loadout`, and `pi-ssh`.

Recommended next step: update the root README layout during a docs cleanup task.

### Low: Per-package scripts are inconsistent

`pi-codex-dollar` and `pi-ssh` expose package-local `test` scripts, while other packages rely on root `bun test`. This is not currently breaking because the root check is authoritative.

Recommended next step: either document root-only checks as the convention or add consistent package-level scripts if package-local workflows matter.

### Low: Package license files are uneven

Root has `LICENSE`; `pi-codex-dollar`, `pi-loadout`, and `pi-ssh` also have package-local `LICENSE` files, while `pi-extcore` and `pi-inturl` do not. The manifests still declare MIT.

Recommended next step: decide whether each publishable package should include a local `LICENSE` file or rely on the root license.

## Overall Health

Status: healthy for active development, with Trellis initialization now populated.

The codebase has a coherent extension-package architecture, passing root checks, strict TypeScript, a working test suite, and practical docs for extension development. Trellis package/layer specs have now been filled from existing docs and real source examples, so future tasks can load project-specific guidance instead of the default scaffold.
