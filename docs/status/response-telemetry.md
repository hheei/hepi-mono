# Response Telemetry

## 目标

`@hheei/pi-status` 在 Pi host 的交互式 session 中显示每个成功 assistant response 的输入 token、输出 token、缓存读取、总耗时与输出速率。

## 边界

- Pi host：拥有 agent、turn、message event 与通知 UI。
- ext-core：提供 session-scoped response telemetry backend，负责事件订阅、当前 session 校验与清理。
- `pi-status`：唯一 concrete extension；在 lifecycle 内启动和销毁 backend。
- 旧 aggregate package：不再拥有 response telemetry。

## 行为

- 仅 `tui` mode 显示；RPC、JSON、print 不显示。
- `error` 与 `aborted` assistant response 不显示。
- 每次 response 使用该 turn 的开始时间计算总耗时；没有开始时间时显示未知值。
- 不提供 settings、命令或持久化状态。

## 生命周期

Pi host `session_start` -> `pi-status` -> ext-core backend `start`。

Pi host `session_shutdown` / reload -> ext-core lifecycle cleanup -> backend `dispose`。

旧 handler 在 Pi host 保留时，backend 用 session ID 使其对后续 session 无效。
