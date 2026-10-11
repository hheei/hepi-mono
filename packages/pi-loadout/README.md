# @hheei/pi-loadout

Visual resource management extension for Pi Coding Agent.

Provides the `/ext-loadout` interactive TUI command to inspect, enable, disable, and override native Pi resources across **Global** (`~/.pi/agent/settings.json`) and **Project** (`.pi/settings.json`) scopes:

- **Skills**
- **Extensions**
- **Prompts**
- **Themes**
- **Packages**
- **Default Tools**

All changes write directly to Pi's native `settings.json`. Reload using `/reload` to apply changes.
