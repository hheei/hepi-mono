# @hheei/pi-ext-tools

Canonical owner for Pi `read`, `grep`, `find`, `edit`, `write`, `bash`, strict Codex V4A
`apply_patch`, `todo`, and FFF-only `fff_multi_grep`. Todo includes `/todos`, task scheduling,
reminders, and the editor widget. `apply_patch` uses package-bundled mpatch workers; it never
requires a user-managed executable. `@hheei/pi-ext-core` is a production dependency,
not a separately loaded Pi extension. Install `@hheei/pi-settings` separately for
the Settings and Loadout UI.

FFF runtime, commands, autocomplete, and enhancement settings are included.

## Native bridge

`src/native-bridge.ts` is the JavaScript facade for the HEPI-owned N-API bridge in
`crates/pi-ext-bridge`. It exposes two package-owned native contracts without exposing
Rust types:

- `MpatchRun` is one cancellable, single-use invocation of vendored `mpatch`. The
  `apply_patch` layer supplies an isolated staging directory and maps its `AbortSignal`
  to `abort()`, removing the listener after completion.
- `PtySession`, backed by `portable-pty`, owns one child pseudo-terminal. It accepts the
  caller's command, arguments, cwd, optional environment, and dimensions; callers read
  raw chunks serially, write input, resize, then close and wait to reap the child.
  `close()` is idempotent and also runs when the wrapper is dropped.

The bridge does not provide an embedded Brush/uutils shell or a shell-state abstraction.
The interactive Bash surface chooses the command and owns its UI, input forwarding, and
output retention.

## Installation and source builds

Release packages must include `native/pi-ext-tools-bridge.node`; installation does
not run Cargo or require an `mpatch` executable. A source checkout must build the native
module before importing this facade:

```bash
pnpm --filter @hheei/pi-ext-tools run build:native
```

The command uses stable Rust and Cargo's incremental `local` profile to write
`native/pi-ext-tools-bridge.node` for the current host platform. The file is not
committed; if it is missing or does not export the expected bridge contract, the loader
throws.

Run the focused native contract test with:

```bash
pnpm --filter @hheei/pi-ext-tools run test:native
```
