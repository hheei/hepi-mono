# @hheei/pi-advisor

Read-only turn reviewer for Pi. Requires `@hheei/pi-basics` and an authenticated model.

Use `/advisor` or `/advisor status` to inspect the runtime. Use `/advisor on` and `/advisor off` to enable or disable it for the current session branch. Model and thinking level are configured through `/ext-settings` and stored under `pi-basics.advisor` in global `~/.pi/agent/settings.json`.

Advisor receives only read-only inspection tools and never edits files. It sends resolved session context, turn evidence, and files it reads to the selected model provider; read-only does not mean local-only. Primary assistant thinking and arbitrary tool-result metadata are excluded. Successful edit diffs may be included.

Runtime state is session-scoped and follows the selected branch's latest Advisor boundary. Turning Advisor off disposes its model context. Repeated advice is suppressed unless its severity increases. While Advisor is enabled, Pi Basics places `✦` after the model in the header: accent/blue means the latest review returned no concern or blocker, yellow means concern, and red means blocker. Advisor does not add a footer label.
