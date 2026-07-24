# @hheei/pi-basics

Shared foundation for HEPI Pi extensions. It owns the session lifecycle, `/hepi` and `/ext-settings`, shared Settings TUI, statusbar, tool-activation coordination, loadout bridges, and ANSI/cell-width-safe TUI primitives.

Load this extension before any `@hheei/pi-*` feature package. Feature packages are intentionally not bundled: install and load only the modules needed by a Pi process. They may depend on `pi-basics`, but never on another feature package. `@hheei/pi-loadout` is a supported companion and coordinates active tools through Pi Basics.

## Built-in behavior

`/ext-settings` and `/hepi setting` show registered settings providers. `/hepi loadout` becomes available when `@hheei/pi-loadout` is loaded. Compatibility settings such as `Guard patch` are provided by `@hheei/pi-fix`.

The editor's top status rail contains only Pi Basics session context. The editor's closing rail remains intact, and text registered through `ui.setStatus()` is normalized into one compact footer row below it. Magic Context telemetry is omitted, MCP is rendered as `⛁ connected/total`, `receiving` becomes an animated Braille spinner, and Plan/Goal labels are uppercase.

## Public API

Import from the package root only. It exports Settings and module registries, session lifecycle/context helpers, shared TUI primitives, JSON section storage, tool activation, and the Loadout bridge contracts used for cross-feature support.

Cross-feature runtime state is keyed by Pi's shared event bus, not by `ExtensionAPI`: Pi creates a separate API facade for every extension. Tool disable handlers must have unique non-empty names, register during session start, and unregister during cleanup. Disabling an unregistered tool is a no-op.

Use `getHePiRuntimeModuleRegistry(pi)` and `getHePiRuntimeSettingsRegistry(pi)` for live extension contributions. They isolate concurrent Pi SDK sessions while sharing contributions across the API facades in one runtime. `registerHePiModule()` and `registerHePiSettings()` return idempotent disposers. Extensions must register contributions during `session_start` and add the disposer to their lifecycle registry so `/reload` and package removal do not retain stale modules or providers. Duplicate IDs in one active generation remain errors.

## Development

Run `bun run typecheck`, `bun test packages/pi-basics/test`, and `bunx biome check packages/pi-basics` from repository root.
