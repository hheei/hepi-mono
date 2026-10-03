# @hheei/pi-ext-core

`@hheei/pi-ext-core` 为独立 `pi-<name>` extension 提供 session lifecycle、Service、
ExtensionPoint、Subagent execution contract 和 cleanup primitives。它不是 Pi extension，不声明
`pi.extensions`；导入本包没有 Pi runtime 副作用。

需要在 worker 或子进程里用 error shaping helper 时，导入 `@hheei/pi-ext-core/errors` 子路径：它只带 error helper，不会把整套 ext-core 模块图载入新线程（每次新线程载入桶入口实测约 220ms）。

`getBackgroundDelivery` 提供 session-runtime 内的完成门控与单次唤醒协调：具体 extension
注册活动计数源和交付通道，保留各自的结果队列、消息、紧急原因、分支规则与交付确认。
注册必须随 lifecycle 清理；跨独立加载的 ext-core 实例共享同一 lazy registry。
契约见 [`background-tasks.md`](../../docs/architecture/background-tasks.md)。

完整架构与组合语义见仓库的
[`docs/architecture/pi-ext-core.md`](../../docs/architecture/pi-ext-core.md)；维护与 consumer
开发约定见 [`docs/development/pi-ext-core.md`](../../docs/development/pi-ext-core.md)。

Subagent API 已实现 root-session-scoped 的 completion、task 与 conversation execution：
`configureSubagentCoordinator`、`startSubagent`、`lookupSubagent` 与 `redeliverTask` 通过
consumer-owned resolved child-session factory 协调 admission、取消、terminal retention、steer、idle
compaction、usage 与 bounded transcript snapshot。完整 ownership、failure 与 concurrency 语义见
[`docs/architecture/subagents.md`](../../docs/architecture/subagents.md)。
