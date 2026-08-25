# Independent Settings Host

> Superseded in part: `pi-settings` now owns both the Settings host and Loadout policy/UI. This
> record preserves the original router-host boundary.

`pi-settings` will own the sole `/ext-settings [page-id]` command and open the core Extension page
router. `pi-loadout` and future packages contribute tabs without registering competing commands or
hosting the router, keeping Loadout policy separate from shared navigation ownership.
