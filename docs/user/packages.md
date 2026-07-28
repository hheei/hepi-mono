# Package Catalogue

HEPI publishes aggregate bundles under the `@hheei` scope. Top-level `pi-*`
feature packages are deprecated and are no longer part of the workspace.

| Package | Purpose | Requirements |
| --- | --- | --- |
| [`hepi-mono`](../../packages/hepi-mono/README.md) | Unified self-contained bundle for all current runtime modules | Pi host, `ffi-rs` |
| [`hepi-basics`](../../packages/hepi-basics/README.md) | Foundational runtime bundle | Pi host |
| [`hepi-tools`](../../packages/hepi-tools/README.md) | Tool and agent bundle | Pi host, `ffi-rs` |
| [`hepi-mctx`](../../packages/hepi-mctx/README.md) | Magic Context bundle | Pi host |
| [`hepi-skills`](../../packages/hepi-skills/README.md) | Skills bundle | Pi host |
| [`hepi-debug`](../../packages/hepi-debug/README.md) | Development diagnostics and deterministic TUI replay | Pi host |

The package README is the behavior contract for users. Cross-package
architecture and contribution rules belong under `docs/development/` and
`docs/architecture/`.
