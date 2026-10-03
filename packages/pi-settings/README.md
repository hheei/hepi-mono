# @hheei/pi-settings

Interactive settings-surface host and Loadout policy manager for HEPI Pi extensions.

```bash
pi install npm:@hheei/pi-settings
```

The package hosts registered settings pages from various extensions (e.g. `pi-ext-tools`, `pi-optimizer`, `pi-ext-addon`, `pi-ext-memory`), manages skill and agent-profile activation loadouts, and suspends editor widgets while the configuration surface is open.

## Features

- **Interactive Settings Surface**: Run `/ext-settings` in Pi TUI mode to access an organized multi-page configuration router.
- **Direct Page Navigation**: Open specific settings pages directly, e.g.:
  - `/ext-settings loadout` — manage tool, skill, and subagent activation loadouts.
  - `/ext-settings optimizer` — configure input conversions and prompt modes.
  - `/ext-settings tools` — configure tool execution and collapse preferences.
- **Hierarchical Persistence**:
  - **Global**: `<agentDir>/ext_settings.json` (e.g. `~/.pi/agent/ext_settings.json`)
  - **Project Local**: `<cwd>/.pi/ext_settings.json`
  - Project configuration overrides global settings cleanly with clear inheritance semantics.
- **Provider Registry**: Extensions register isolated, unique top-level group IDs without namespace collisions or global state pollution.
