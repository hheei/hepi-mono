# @hheei/pi-advisor

Read-only turn reviewer for Pi. Requires `@hheei/pi-basics` and an authenticated model.

Use `/advisor` or `/advisor status` to inspect the runtime. Use `/advisor on` and `/advisor off` to enable or disable it for the current session branch. Model and thinking level are configured through `/ext-settings` and stored under `pi-basics.advisor` in global `~/.pi/agent/settings.json`.

Advisor receives only read-only inspection tools and never edits files. It sends resolved session context, turn evidence, and files it reads to the selected model provider; read-only does not mean local-only. Primary assistant thinking and arbitrary tool-result metadata are excluded. Successful edit diffs may be included.

Runtime state is session-scoped and follows the selected branch's latest Advisor boundary. Turning Advisor off disposes its model context. Repeated advice is suppressed unless its severity increases. The footer status rail shows `Advisor` only while Advisor is enabled.
