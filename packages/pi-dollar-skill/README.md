# @hheei/pi-dollar-skill

`$skill-name` completion and path expansion for Pi. Requires `@hheei/pi-basics`.

Autocomplete is TUI-only; input expansion also applies to interactive and RPC/print input. Configure enablement and suggestion count in `/ext-settings`; values persist in global `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`).

When `pi-loadout` is present, disabled skills remain in autocomplete after enabled skills and render dimmed through the `pi-basics` bridge. This package does not depend on `pi-loadout`. Do not load another extension that transforms the same `$skill` syntax.
