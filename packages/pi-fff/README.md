# @hheei/pi-fff

FFF-backed file discovery and content search for Pi.

Install with `@hheei/pi-ext-core` and `@hheei/pi-loadout`. Publish this package together with the
HEPI release that removes FFF from `hepi-tools`; mixing it with an older aggregate is unsupported.

FFF runtime settings are registered through `@hheei/pi-ext-core`. Tool activation remains owned by
`@hheei/pi-loadout`; settings changes apply on the next session start or `/reload`.

This split release owns only `grep`, `find_files`, and `fff_multi_grep`. Install it with
`@hheei/pi-ext-tools`, which is the sole owner of `read`; older `pi-fff` releases that register
`read` are incompatible with `pi-ext-tools`.
