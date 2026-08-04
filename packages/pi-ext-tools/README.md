# @hheei/pi-ext-tools

Canonical owner for Pi `read`, `grep`, `find`, `edit`, `write`, `bash`, strict Codex V4A
`apply_patch`, and FFF-only `fff_multi_grep`. `apply_patch` uses package-bundled mpatch workers;
it never requires a user-managed executable. Install with `@hheei/pi-ext-core` and
`@hheei/pi-loadout`.

FFF runtime, commands, autocomplete, and enhancement settings are included; this package absorbed
the retired standalone FFF extension.

## Native bridge

`src/native-bridge.ts` exposes the HEPI-owned N-API bridge for package-owned
mpatch execution and session-scoped Brush shell execution. The shell retains
its cwd, exported environment and background jobs, and uses upstream's patched
uutils builtin set without exposing upstream Rust types to TypeScript. The
bridge builds with stable Rust:

```bash
bun run --cwd packages/pi-ext-tools build:native
```

This writes `native/pi-ext-tools-bridge.node` for the current host platform with
Cargo's incremental `local` profile. The native file is not committed.

Run the focused native contract test with:

```bash
bun run --cwd packages/pi-ext-tools test:native
```
