# 进程内子代理协调器（已移除）

`@hheei/pi-ext-core` 不再提供 `startSubagent`，也不再拥有 completion、task、conversation 三种执行契约。
该协调器没有第二个生产调用方：`task` 与 `conversation` 只有测试，`completion` 只被 auto-title 包了一层。

当前归属：

- 一次性模型补全由调用方直接使用 `@earendil-works/pi-ai` 的 `completeSimple`。auto-title 走这条路径，自己持有 `AbortController`。
- 可重连的 child session 只属于 `@hheei/pi-subagents`。见 [pi-subagents 架构](pi-subagents.md)。
- 后台命令由 pi-ext-tools 的 BashJobs 独占管理，子代理由 SubagentManager 独占管理。结果送回主会话只共享 ext-core 的 `BackgroundDelivery`，不共享执行状态或任务服务。

[ADR 0004](../adr/0004-core-subagent-execution.md) 记录的是已撤销的决定，不是当前契约。
