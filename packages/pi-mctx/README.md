# @hheei/pi-mctx

`@hheei/pi-mctx` is the single Magic Context package for HEPI. Its Pi adapter
lives in `src/`; shared Magic Context implementation lives in `src/core/` and
is private to this package through `#core/*` imports.

The package is an upstream source baseline copied from
[`cortexkit/magic-context`](https://github.com/cortexkit/magic-context) at
`7dcd2e5726a1466126b2eea460482cca2b53283b`. It has no `pi.extensions` entry
and remains unloadable until its first HEPI-adapted slice is designed and
verified.

The previous implementation remains excluded at `packages/xpi-mctx/` for
historical comparison.

Pi MCTX owns its persistence. Runtime settings are stored in Pi's global
`settings.json` under `pi-mctx`; the database is stored under
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/../pi-mctx/` (default `~/.pi/pi-mctx/`).
It does not read, write, migrate, or merge the upstream CortexKit
`magic-context.jsonc` files or `~/.local/share/cortexkit/magic-context/`.
