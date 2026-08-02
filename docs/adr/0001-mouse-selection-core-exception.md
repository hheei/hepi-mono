# Mouse and selection core exception

HEPI will publish the full `pi-ext-core` mouse and selection API before two real product consumers exist. `pi-debug` is the simulated verification consumer. This is an explicit exception to the normal shared-core admission rule, accepted to establish a reusable terminal interaction contract now; its public API must therefore be kept deliberately small and tested through replay.

## Considered Options

- Wait for two product consumers before extracting shared contracts.
- Keep the first implementation local to one extension.

## Consequences

`pi-debug` verifies transport and lifecycle behavior but does not prove that future product-page selection semantics are suitable. Any later widening of the contract requires a new design decision rather than treating this exception as precedent.
