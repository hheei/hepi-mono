# @hheei/pi-mctx

Pi extension package for parent-session context management. Enabled, valid configuration opens the MCTX
store, binds a session partition, schedules historian completion at `turn_end`, and applies only verified
compartment projections during `context`. Store failures block the parent turn by default; user
configuration may opt back into Pi-native behavior with `fail_closed_blocking: false`.

`/ctx-status` is always registered and opens a read-only TUI snapshot when TUI is available. It reports
inactive or failed runtime reasons without exposing store payloads. Durable memory, notes, search,
Dreamer, embedding, and related commands remain parked and are not active.
