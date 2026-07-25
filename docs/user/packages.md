# Package Catalogue

Every workspace under `packages/` is maintained by HEPI and published under the `@hheei` scope. Feature packages require `@hheei/pi-basics` unless noted otherwise.

| Package | Purpose | HEPI prerequisite |
| --- | --- | --- |
| [`pi-basics`](../../packages/pi-basics/README.md) | Session lifecycle, settings UI, status, shared TUI, and runtime coordination | None |
| [`pi-advisor`](../../packages/pi-advisor/README.md) | Read-only turn review advisor | Pi Basics |
| [`pi-ask`](../../packages/pi-ask/README.md) | Structured interactive questions | Pi Basics |
| [`pi-auto-title`](../../packages/pi-auto-title/README.md) | Automatic session naming | Pi Basics |
| [`pi-btw`](../../packages/pi-btw/README.md) | Isolated side questions | Pi Basics |
| [`pi-caveman`](../../packages/pi-caveman/README.md) | Concise response mode | Pi Basics |
| [`pi-debug`](../../packages/pi-debug/README.md) | Cache diagnostics and deterministic TUI replay | None |
| [`pi-dollar-skill`](../../packages/pi-dollar-skill/README.md) | Dollar-prefixed skill references | Pi Basics |
| [`pi-fix`](../../packages/pi-fix/README.md) | Host and provider compatibility fixes | Pi Basics |
| [`pi-goal`](../../packages/pi-goal/README.md) | Branch-local objective tracking | Pi Basics |
| [`pi-loadout`](../../packages/pi-loadout/README.md) | Tool, skill, and MCP activation | Pi Basics |
| [`pi-plan`](../../packages/pi-plan/README.md) | Planning workflow | Pi Basics |
| [`pi-ponytail`](../../packages/pi-ponytail/README.md) | Minimal engineering mode and companion skills | Pi Basics |
| [`pi-rtk`](../../packages/pi-rtk/README.md) | Shell rewriting and output compaction | Pi Basics |
| [`pi-sshfs`](../../packages/pi-sshfs/README.md) | SSHFS mount tool | Pi Basics |
| [`pi-t2s`](../../packages/pi-t2s/README.md) | Traditional-to-Simplified Chinese input conversion | Pi Basics |
| [`pi-todo`](../../packages/pi-todo/README.md) | Ordered task-list workflow | Pi Basics |

The package README is the behavior contract for users. Cross-package architecture and contribution rules belong under `docs/development/` and `docs/architecture/`.
