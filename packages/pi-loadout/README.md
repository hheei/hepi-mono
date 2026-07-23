# @hheei/pi-loadout

Tool and skill activation UI for Pi. Requires `@hheei/pi-basics`.

Open `/loadout` or `/hepi loadout`. Global selections persist in `~/.pi/agent/setting.json`; project selections persist in `<cwd>/.pi/setting.json`, under `pi-basics-loadout`.

Loadout updates Pi's active tools and filters disabled skills before model start. Goal and Dollar Skill integration uses `pi-basics` capability bridges, so this package has no feature-package dependency.
