# @hheei/pi-fff

FFF-backed file discovery, approximate path resolution, and content search for Pi.

Install with `@hheei/pi-ext-core` and `@hheei/pi-loadout`. Publish this package together with the
HEPI release that removes FFF from `hepi-tools`; mixing it with an older aggregate is unsupported.

FFF runtime settings are registered through `@hheei/pi-ext-core`. Tool activation remains owned by
`@hheei/pi-loadout`; settings changes apply on the next session start or `/reload`.
