# Package Catalogue

HEPI distributes its unified package from pinned Git tags. Top-level `pi-*`
feature packages are deprecated and are no longer part of the workspace.

| Package | Purpose | Requirements |
| --- | --- | --- |
| [`hepi-mono`](../../packages/hepi-mono/README.md) | Unified self-contained bundle for all current runtime modules | Pi host, `ffi-rs` |
| [`hepi-basics`](../../packages/hepi-basics/README.md) | Foundational local composition bundle | Pi host |
| [`hepi-tools`](../../packages/hepi-tools/README.md) | Tool and agent local composition bundle | Pi host, `ffi-rs` |
| [`hepi-skills`](../../packages/hepi-skills/README.md) | Skills local composition bundle | Pi host |
| [`hepi-debug`](../../packages/hepi-debug/README.md) | Development diagnostics and deterministic TUI replay | Pi host |

Install `hepi-mono` with `pi install git:github.com/hheei/hepi-mono@<tag>`.
The package README is the behavior contract for users. Cross-package
architecture and contribution rules belong under `docs/development/` and
`docs/architecture/`.
