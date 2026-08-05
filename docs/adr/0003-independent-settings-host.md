# Independent Settings Host

`pi-settings` will own the sole `/ext-settings [page-id]` command and open the core Extension page
router. `pi-loadout` and future packages contribute tabs without registering competing commands or
hosting the router, keeping Loadout policy separate from shared navigation ownership.
