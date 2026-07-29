# @hheei/hepi-basics

Self-contained foundational HEPI bundle for Pi. Its published `dist` entry
contains the implementation of `pi-basics`, Loadout, and the remaining
foundational runtime modules behind one extension entry and one JIT boundary.

Included modules:

- `pi-basics`
- `pi-loadout`
- `pi-retry`
- `pi-rtk`
- `pi-dollar-skill`
- `pi-fix`
- `pi-t2s`
- `pi-auto-title`

While `pi-auto-title` generates a session title, the editor top rail shows a
grey-to-white shimmer over `Generating title` at its right edge. The completed
title uses the dim theme color in the same position. Either is omitted when the
full text does not fit.

The tail rail always begins with the current working directory, followed by
extension statuses when present.

`pi-retry` classifies empty-detail provider failures and known retryable Codex
errors for Pi's native retry path. `/ext-settings` provides its helper switch
and stalled-stream timeout (default 90 seconds; zero disables the watchdog).
`--retry-stall-timeout-ms <ms>` and `PI_RETRY_STALL_TIMEOUT_MS=<ms>` override
that timeout. Pi's `retry.enabled` setting remains the switch for retries and
retry backoff. The provider persists values at `hepi.retry`.

Included themes:

- `catppuccin-latte`
- `catppuccin-mocha`

Install this bundle directly:

```bash
pi install npm:@hheei/hepi-basics
```

Build locally with `bun run build` from this package or
`bun run build:aggregates` from the repository root.

Do not install it together with `@hheei/hepi-mono`; the unified bundle already
includes it.

Feature extensions can expose Loadout grouping through the `HepiLoadoutGroup`
registry exported by the Basics core. A group supplies its own display label and
may select tool names or stable `tool:*` keys. Stable keys should be used when
multiple sources expose the same tool name. Tools without a matching group
continue to use Loadout's source-based grouping.
