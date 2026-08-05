# @hheei/hepi-basics

Self-contained transitional HEPI foundation bundle for Pi. Its published `dist`
entry contains the remaining aggregate runtime modules behind one extension entry
and one JIT boundary.

Included modules:

- `pi-basics`
- `pi-retry`
- `pi-rtk`
- `pi-dollar-skill`
- `pi-fix`
- `pi-auto-title`

While `pi-auto-title` generates a session title, the editor top rail shows a
grey-to-white shimmer over `Generating title` at its right edge. The completed
title uses the dim theme color in the same position. Either is omitted when the
full text does not fit.

The tail rail always begins with the current working directory, followed by
extension statuses when present.

`pi-retry` classifies empty-detail provider failures and known retryable Codex
errors for Pi's native retry path. Install `@hheei/pi-settings` to edit its helper
switch and stalled-stream timeout (default 90 seconds; zero disables the watchdog).
`--retry-stall-timeout-ms <ms>` and `PI_RETRY_STALL_TIMEOUT_MS=<ms>` override
that timeout. Pi's `retry.enabled` setting remains the switch for retries and
retry backoff. The provider persists values at `hepi.retry`.

Included themes:

- `catppuccin-latte`
- `catppuccin-mocha`

Install it with:

```bash
pi install npm:@hheei/hepi-basics
```

Build locally with `bun run build` from this package or
`bun run build:aggregates` from the repository root.

Do not install it together with `@hheei/hepi-mono`; the unified bundle already
includes it.

Install `@hheei/pi-loadout` for managed tool and skill activation policy.
