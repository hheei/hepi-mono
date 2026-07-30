# Core Extension Page Router

`@hheei/pi-ext-core` will add a global terminal extension page router for the first planned
consumer, Loadout. This is an explicit exception to the normal two-consumer promotion threshold:
the router centralizes page registration, tabs, Pi TUI lifecycle, theme, layout, focus, key routing
and render-host safety, while each page contributor retains its visible content, actions, state and
policy.

## Consequences

The public API must stay limited to routing and page-shell contracts, and must not become a
schema-driven view model or own page content/policy. A second consumer remains required before
adding generic page-content or policy abstractions.
