# @hheei/pi-mctx

Pi extension package for parent-session context management. It remains inactive by default; enabled,
valid configuration opens the MCTX store, binds a session partition, schedules historian completion at
`turn_end`, and applies only verified compartment projections during `context`. Store failures block the
parent turn by default; user configuration may opt back into Pi-native behavior with
`fail_closed_blocking: false`. The package does not register MCTX commands or status UI.
