# @hheei/pi-loadout

Tool and skill activation UI for Pi. Requires `@hheei/pi-basics`.

Open `/loadout` or `/hepi loadout`. Items are grouped by source. Press `Tab`
to switch between tools and skills, and `Ctrl+Tab` to switch between global and
project settings. Global selections persist in `~/.pi/agent/setting.json`;
project selections persist in `<cwd>/.pi/setting.json`, under
`pi-basics-loadout`.

Loadout updates Pi's active tools and filters disabled skills before model
start. Goal and Dollar Skill integration uses `pi-basics` capability bridges,
so this package has no feature-package dependency.

The package root exports only `createLoadoutModule()` and its `LoadoutModule`
contract. Controllers, storage, rendering, and inventory implementations are
internal.
