# Package Catalogue

HEPI publishes its runtime packages to npm. `hepi-mono` is the full bundle;
the remaining packages support selective installation.

| Package | Purpose | Requirements |
| --- | --- | --- |
| [`hepi-mono`](../../packages/hepi-mono/README.md) | Unified bundle for all current runtime modules, including Subagents | Pi host, `ffi-rs` |
| [`hepi-basics`](../../packages/hepi-basics/README.md) | Foundational local composition bundle | Pi host |
| [`hepi-tools`](../../packages/hepi-tools/README.md) | Tool and agent local composition bundle | Pi host, `ffi-rs` |
| [`hepi-skills`](../../packages/hepi-skills/README.md) | Skills local composition bundle | Pi host |
| [`hepi-aft`](../../packages/hepi-aft/README.md) | AFT file tools and renderer | Pi host, AFT platform binary |
| [`hepi-mctx`](../../packages/hepi-mctx/packages/pi-plugin/README.md) | Magic Context memory and compaction | Pi host |
| [`hepi-subagents`](../../packages/hepi-subagents/README.md) | Standalone subagent orchestration, included by `hepi-mono` | Pi host |
| [`hepi-debug`](../../packages/hepi-debug/README.md) | Development diagnostics and deterministic TUI replay | Pi host |

Install `hepi-mono` with `pi install npm:@hheei/hepi-mono`.
The package README is the behavior contract for users. Cross-package
architecture and contribution rules belong under `docs/development/` and
`docs/architecture/`.
