# @hheei/pi-advisor

Read-only turn reviewer for Pi. Requires `@hheei/pi-basics` and an authenticated model.

Use `/advisor`, `/advisor on`, `/advisor off`, or `/advisor status`. Model and thinking level are configured through `/ext-settings` and stored under `pi-basics.advisor` in global `~/.pi/agent/settings.json`.

Advisor receives only read-only inspection tools and never edits files. Runtime state is session-scoped.
