# @hheei/pi-auto-title

Automatic Pi session titles. Requires `@hheei/pi-basics` and at least one authenticated model.

Enable automatic titles and select a model in `/ext-settings`. Use `/auto-title` to generate or replace a title manually. Automatic generation runs only on startup and new sessions. Settings persist under `pi-basics.auto-title` in `<cwd>/.pi/settings.json`.

The title agent is isolated, receives no tools, and returns at most six English words.
