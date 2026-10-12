# @hheei/pi-loadout

Visual resource management extension for Pi Coding Agent.

Provides the `/ext-loadout` interactive TUI command to inspect, enable, disable, and override native Pi resources across **Global** (`~/.pi/agent/settings.json`) and **Project** (`.pi/settings.json`) scopes:

- **Skills**
- **Extensions**
- **Prompts**
- **Themes**

All changes write directly to Pi's native `settings.json`. Reload using `/reload` to apply changes.

## Interaction

| Key | Action |
| --- | --- |
| `↕` | Move the selection |
| `␣` / `↵` | Toggle the resource, or cycle the project override |
| `⇥` | Switch the write scope between Global and Project |
| typing | Filter by name, category, or origin |
| `⎋` | Clear the filter, then close and save |

The list groups resources by category under a heading, and the detail pane reports the global value, the project decision, and the effective result as three separate facts. Status is drawn with Nerd Font glyphs — `4` enabled, `0` disabled, `9` project-enabled, `7` project-disabled — so a row reads correctly without relying on color. A resource contributed by a package is named after the package rather than its `dist/extension.js` entry point, and two resources that would otherwise share a label are qualified by the directory that owns them.
