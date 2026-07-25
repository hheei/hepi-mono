# @hheei/pi-t2s

Traditional Chinese to Simplified Chinese input conversion for Pi. Requires
`@hheei/pi-basics` and bundles `opencc-js`.

Enable or disable `ZH translate` through `/ext-settings`. Settings persist at
`pi-basics.traditional-to-simplified.mode` in global `~/.pi/agent/settings.json`
(or `$PI_CODING_AGENT_DIR/settings.json`) and accept only `t2s` or `off`.
Malformed values and unknown fields are rejected and reported. Runtime state is
session-scoped and cleanup is idempotent.
