# @hheei/pi-auto-title

Automatic Pi session titles. Requires `@hheei/pi-basics` and at least one authenticated model.

Enable automatic titles and select a model in `/ext-settings`. Title generation always uses thinking level `off`. Use `/auto-title` to generate or replace a title manually. Automatic generation runs only on startup and new sessions. Settings persist under `pi-basics.auto-title` in global `~/.pi/agent/settings.json`.

The title agent is isolated and receives no tools. It generates a searchable title in the same language as the first user request, normally two to six words and always at most 60 characters. The prompt prioritizes the first request, then uses the first assistant result and latest user clarification as supporting context. Exact package names, files, commands, and code identifiers are preserved when useful.
