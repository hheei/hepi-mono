# Core Loadout Contract

`@hheei/pi-ext-core` will publicly own Loadout inventory and managed-tool registration contracts,
while `pi-loadout` remains the sole owner of activation policy and UI. This explicitly expands core
beyond feature-neutral primitives because independently installed extensions must register tools
without importing a concrete `pi-loadout` package.

## Consequences

The contract is limited to registration metadata, executable handler delegation and lifecycle
ownership. It must not move Loadout persistence, conflict resolution, groups, rendering or command
policy into core. Core always directly registers a managed executable tool, making extension load
order irrelevant; when `pi-loadout` is absent it leaves activation behavior to Pi defaults and does
not apply Loadout policy metadata.
