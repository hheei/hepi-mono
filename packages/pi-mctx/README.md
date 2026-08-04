# @hheei/pi-mctx

Pi extension package for parent-session context management. `pi-mctx.enabled` opens the MCTX store, binds a
session partition, and applies only verified compartment projections during `context`. Historian is an
optional producer: `pi-mctx.historian.enabled` plus an exact configured model schedules completions at
`turn_end`; without it, the active runtime retains tools, status, Sidekick, and projections but writes no new
compartments. Store failures block the parent turn by default; user configuration may opt back into Pi-native
behavior with `fail_closed_blocking: false`. When `@hheei/pi-settings` is installed, its combined Settings tree
exposes the separate MCTX runtime and Historian controls. Saved values apply after Pi reload or in a new session.

`/mctx` is the sole slash command. Bare `/mctx` and `/mctx status` open a read-only TUI snapshot; `/mctx aug
<query>` runs Sidekick augmentation. Native argument autocomplete suggests active subcommands with descriptions.
It reports
inactive or failed runtime reasons without exposing store payloads. Durable memory, notes, search,
Dreamer, embedding, and related commands remain parked and are not active.
