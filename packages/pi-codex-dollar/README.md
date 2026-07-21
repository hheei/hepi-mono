# @hheei/pi-codex-dollar

`@hheei/pi-codex-dollar` adds `$skill-name` autocomplete, cyan prompt highlighting, prompt-time skill path expansion, and `pi-loadout`-aware skill ordering to Pi.

It is intentionally different from `/skill:name`: it does not expand `SKILL.md` into the prompt. When you send a prompt, each recognized `$skill-name` token is replaced with the loaded skill's `sourceInfo.path`.

## Behavior

Type `$` in the prompt editor to list loaded skills, or keep typing to filter by skill-name prefix.

```text
Review this using $lib
```

Selecting a suggestion inserts the token:

```text
Review this using $librarian
```

If `$librarian` matches a loaded skill, the token is highlighted while editing. Unknown tokens such as `$UNKNOWN` are left alone. When the prompt is sent, Pi transforms the known token into the skill file path:

```text
Review this using /Users/me/.pi/agent/skills/librarian/SKILL.md
```

Multiple references in one prompt are supported, and unknown `$NAME` tokens remain unchanged.

## pi-loadout Support

When `@hheei/pi-loadout` has an active skill selection and Respect loadout is enabled, active skills are listed first. Inactive skills remain available lower in the picker and render with muted autocomplete styling.

## Settings

Run `/extension-setting` in Pi and open `PI Codex Dollar` to configure:

| Setting | Default | Meaning |
| --- | ---: | --- |
| Inline picker | `true` | Show skill suggestions after typing `$` in the TUI editor. |
| Suggestion limit | `30` | Maximum number of suggestions shown by the inline picker. |
| Expand references | `true` | Replace `$skill` references with `SKILL.md` paths before input is submitted. |
| Highlight references | `true` | Highlight valid `$skill` references while editing. |
| Respect loadout | `true` | Rank active `pi-loadout` skills before inactive skills. |

Settings are stored under `pi-codex-dollar` in `~/.pi/agent/ext-settings.json`.

## Development

```bash
bun test packages/pi-codex-dollar/test
bun run typecheck
bun run pi:dev -- codex-dollar
```

The development wrapper loads `pi-extcore` with this package because it owns `/extension-setting`.
