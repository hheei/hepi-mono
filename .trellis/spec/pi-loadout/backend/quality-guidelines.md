# Quality Guidelines

## Runtime Standards

- Normalize active tool and skill names against currently available Pi registries before applying state.
- Preserve skill behavior: all skills are active until the user explicitly sets a skill loadout.
- Keep built-in presets dynamic so they self-heal as installed tools/skills change.
- Keep command parsing explicit and warn on unknown subcommands.
- Update status after state changes when status display is enabled.

## Tests

- Cover migration behavior in `settings-storage.test.ts`.
- Cover status/footer/preset formatting in `tui.test.ts`.
- Add focused tests when changing serialization, profile selection, or prompt filtering.

## Forbidden Patterns

- Do not mutate Pi active tools before normalizing tool names.
- Do not filter skills from prompts unless `skillLoadoutExplicit` is true.
- Do not let session log entries survive compact/tree/context filtering.

## Examples

- `packages/pi-loadout/src/index.ts#restoreFromBranch`
- `packages/pi-loadout/src/index.ts#before_agent_start` hook
- `packages/pi-loadout/test/settings-storage.test.ts`
