# pi-ext-core 接入

## 目标

`pi-hindsight` 使用 ext-core 管理 session 生命周期、取消、工具 Loadout 注册和 settings provider 注册。Hindsight client、bank、队列、记忆策略与 TUI 仍由本包拥有。

## 边界

- Pi host：派发 `session_start`、`context`、`agent_end` 与 `session_shutdown`。
- ext-core：以 `@hheei/pi-hindsight` 为稳定 key 串行 lifecycle，提供 abort signal 和 cleanup registry。
- pi-hindsight：创建 memory lifecycle；仅在当前 lifecycle signal 未 abort 时处理 recall、retain 与命令。
- Hindsight settings：作为 ext-core provider 注册；写入用户级 `~/.pi/agent/hindsight.json`。项目级 bank、API secret、导入配置不进入 settings host。

## 流程

```text
Pi host session_start -> ext-core start -> hindsight initialize
Pi host context       -> active signal guard -> hindsight recall
Pi host agent_end     -> active signal guard -> hindsight retain
Pi host shutdown      -> ext-core abort -> hindsight shutdown/queue flush
```

Pi 不注销 reload 前的事件 handler。cleanup 清除 active session；旧 handler 因 signal 已 abort 而不再执行。

## 工具与命令

所有 `hindsight_*` 工具在 extension factory 中通过 ext-core managed Loadout 注册，默认 active、无 conflict。命令仍由 Pi host 注册，但 handler 先检查当前 lifecycle；ext-core 没有 command registry，因为命令语义属于具体 extension。

## 验证

- lifecycle start、shutdown、reload 后旧 handler 不执行。
- 工具由 managed Loadout 注册且默认 active。
- settings provider 随 lifecycle 注册与清理。
- `bun run typecheck` 与 Hindsight focused tests 通过。
