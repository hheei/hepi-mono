# @hheei/pi-loadout

Loadout activation policy and Settings page for Pi.

Install with `@hheei/pi-ext-core`. The package resolves global/project `pi-loadout` JSON deltas and
provides `/loadout`, opening the shared router at the `Loadout` page. When `@hheei/pi-settings` is
also installed, `/ext-settings loadout` opens the same page with other registered Settings tabs.
Saved Loadout selections take effect after Pi `/reload`.

Tool owners can declare named `conflictSets` or symmetric name-level `conflictsWith` metadata.
Loadout resolves explicit project/global selections before defaults, then exposes only compatible tools.
