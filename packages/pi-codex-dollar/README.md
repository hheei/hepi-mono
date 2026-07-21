# @hheei/pi-codex-dollar

`@hheei/pi-codex-dollar` adds `$skill-name` autocomplete, cyan prompt highlighting, and prompt-time skill path expansion to Pi.

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

## Development

```bash
bun test packages/pi-codex-dollar/test/*.test.ts
```
