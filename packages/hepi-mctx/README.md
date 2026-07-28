# @hheei/hepi-mctx

Self-contained Magic Context bundle for Pi. It bundles the fixed
`@hheei/pi-magic-context@0.33.1-hepi.0` fork and registers its tools with the
HEPI Loadout.

Magic Context is disabled in `pi-subagents` child sessions. The parent session
records each completed child as a `pi_subagent` invocation with status,
duration, and input/output token totals. Child descriptions and results are not
stored by Magic Context.

When `@hheei/pi-magic-context` or the legacy `@cortexkit/pi-magic-context` is
already listed in global Pi package settings, this package reuses that separate
extension and skips its bundled copy so the same tools are not registered twice.

Install it with:

```bash
pi install npm:@hheei/hepi-mctx
```

Do not install it together with `@hheei/hepi-mono`; the unified bundle already
contains this module.
