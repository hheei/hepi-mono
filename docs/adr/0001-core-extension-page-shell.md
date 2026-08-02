# Core Extension Page Router

`@hheei/pi-ext-core` will add a global terminal extension page router for the first planned
consumer, Loadout. The router has a bounded, feature-neutral middle-layer scope: it centralizes page
registration, tabs, Pi TUI lifecycle, theme, layout, focus, key routing and render-host safety, while
each page contributor retains its visible content, actions, state and policy.

## Consequences

The public API must stay limited to routing and page-shell contracts, and must not become a
schema-driven view model or own page content/policy. Current core convention permits a valuable,
feature-neutral API before a second consumer, but does not permit generic page-content or policy
abstractions without their own demonstrated boundary and proposal.
