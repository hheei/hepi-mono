# @hheei/pi-loadout

HEPI fork of `pi-loadout`.

This package keeps the original loadout implementation and registers it as a top-level `[PI Loadout]` pane inside the shared `/extension-setting` panel from `@hheei/pi-extcore`.

## Local Testing

Load `pi-extcore` together with this package because `pi-extcore` owns `/extension-setting`:

```bash
pi -e packages/pi-extcore/src/extension.ts -e packages/pi-loadout/src/index.ts
```

## Main Flow

Open the shared settings panel:

```text
/extension-setting
```

Then switch to `[PI Loadout]` and open one of:

```text
Tools
Skills
Presets
```

Those subpanels use the copied `pi-loadout` picker behavior: tools, skills, presets, global default save/apply, and session branch persistence. Inside each picker, Tab still switches between Tools, Skills, and Presets.

## Compatibility Commands

The `/loadout` command is still present as a shortcut and for scripted use:

```text
/loadout                 Open interactive picker
/loadout full            Enable every available tool and skill
/loadout minimal         Enable only built-in tools and skills
/loadout default         Apply saved global default loadout
/loadout save <name>     Save current loadout as a user preset
/loadout use <name>      Apply built-in, default, or user preset
/loadout list            List built-in and user presets
/loadout delete <name>   Delete a user preset
/loadout status          Print current active tools and skills
/loadout reset           Alias for /loadout full
/loadout help            Show subcommand list
```

## Centralized Settings

`@hheei/pi-loadout` contributes plain settings and picker subpanels to its `[PI Loadout]` pane in `/extension-setting`.

Plain settings:

- `Status bar`: show active tool and skill counts in the Pi footer.
- `Use global default`: use `~/.pi/agent/loadout.json` when a session branch has no saved loadout.
- `Filter skills`: remove disabled skills from the model system prompt.
- `Session change log`: write visible session log entries when a loadout change has a diff.
- `Prompt cache warning`: show prompt-cache miss warnings in the interactive picker.

Settings are stored in:

```text
~/.pi/agent/ext-settings.json
```

If `~/.pi/agent/ext-settings.json` has no `pi-loadout` entry yet, the extension copies a valid legacy `~/.pi/agent/pi-loadout-settings.json` value into the shared settings file on first load.

The original loadout files are still used:

```text
~/.pi/agent/loadout.json
~/.pi/agent/loadout-profiles.json
```

## Fork Notes

Source started from `pi-loadout@0.0.35`. Keep behavioral changes small and reviewable; prefer adapting the copied implementation over rewriting it.
