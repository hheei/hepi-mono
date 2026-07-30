# Package Catalogue

This is the current transitional package list. Future features publish as
independently installable `pi-<name>` extensions under the `@hheei` scope.

| Package | Purpose | Requirements |
| --- | --- | --- |
| [`hepi-mono`](../../packages/hepi-mono/README.md) | **Deprecated.** Former unified bundle; do not install for new setups. | Pi host, `ffi-rs` |
| [`hepi-basics`](../../packages/hepi-basics/README.md) | Transitional foundational bundle | Pi host |
| [`hepi-tools`](../../packages/hepi-tools/README.md) | Transitional tool and agent bundle | Pi host, `ffi-rs` |
| [`hepi-mctx`](../../packages/hepi-mctx/README.md) | Transitional Magic Context bundle | Pi host |
| [`hepi-skills`](../../packages/hepi-skills/README.md) | Transitional skills bundle | Pi host |
| [`hepi-debug`](../../packages/hepi-debug/README.md) | Development diagnostics and deterministic TUI replay | Pi host |

Future features publish as independent extensions backed by `@hheei/pi-ext-core`.
Package READMEs cover installation and compatibility. Cross-package concepts,
architecture, and contribution rules belong under `docs/`; detailed TypeScript
API usage and implementation behavior are documented beside the code.
