# @hheei/pi-ext-core

`@hheei/pi-ext-core` 为独立 `pi-<name>` extension 提供 session lifecycle、Service、
ExtensionPoint、Subagent execution contract 和 cleanup primitives。它不是 Pi extension，不声明
`pi.extensions`；导入本包没有 Pi runtime 副作用。

完整架构与组合语义见仓库的
[`docs/architecture/pi-ext-core.md`](../../docs/architecture/pi-ext-core.md)；维护与 consumer
开发约定见 [`docs/development/pi-ext-core.md`](../../docs/development/pi-ext-core.md)。

Subagent API 目前只有 TypeScript interface framework：`configureSubagentCoordinator`、
`startSubagent`、`lookupSubagent` 与 `redeliverTask` 均会抛出 not implemented，不能用于 production
execution。完整设计见 [`docs/architecture/subagents.md`](../../docs/architecture/subagents.md)。
