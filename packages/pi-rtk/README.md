# @hheei/pi-rtk

RTK shell rewrite and output compaction integration. Requires
`@hheei/pi-basics`; an external `rtk` executable is optional and is never
installed by this package.

Configure `RTK Mode` and `RTK Compaction` in `/ext-settings`. Project settings
persist under `settings.json` in the global Pi agent directory (`getAgentDir()`;
commonly `~/.pi/agent/settings.json`, or `PI_CODING_AGENT_DIR/settings.json`). `/rtk` exposes
`show`, `verify`, `stats`, `clear-stats`, `reset`, `path`, and `help`.

Unsupported native `find` predicates remain unmodified. Do not load another RTK
rewriter in the same Pi process.

The package root exports the extension loader plus the `RtkIntegrationConfig`
and `RuntimeStatus` contracts. Rewrite, compaction, persistence, and metrics
implementations are internal.
