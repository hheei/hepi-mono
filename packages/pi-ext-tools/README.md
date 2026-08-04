# @hheei/pi-ext-tools

Canonical owner for Pi `read`, `grep`, `find`, `edit`, `write`, `bash`, strict Codex V4A
`apply_patch`, and FFF-only `fff_multi_grep`. `apply_patch` uses package-bundled mpatch workers;
it never requires a user-managed executable. Install with `@hheei/pi-ext-core` and
`@hheei/pi-loadout`.

FFF runtime, commands, autocomplete, and enhancement settings are included; this package absorbed
the retired standalone FFF extension.

## Native bridge

`src/native-bridge.ts` exposes the HEPI-owned N-API bridge for selected vendored
oh-my-pi primitives (`runMpatch` and the bridge version sentinel). The native
module is built from the repository root with nightly Rust because the pinned
upstream `pi-natives` crate uses `alloc_error_hook`:

```bash
bun run --cwd packages/pi-ext-tools build:native
```

This writes `native/pi-ext-tools-bridge.node` for the current host platform. The
native file is a local/release artifact and is not committed.
