# pi-subagents

`@hheei/pi-subagents` is the concrete extension for independent, reconnectable Pi
child sessions. Live contract: [`docs/pi-subagents/spec.md`](../pi-subagents/spec.md).
Design sources: `PLAN.md` and `PLAN-delivery-presentation.md` in the same folder.

Ownership:

- Parent branch: agent policy, registry, SubagentManager, model-facing tools, UX.
- Independent runner: child stdio, IPC, single controller, RPC/TUI writer replacement.
- Child branch: `contact_parent` and session-leave reporting only.
- HostAdapter: Herdr/cmux pane create/observe/cleanup. Not identity.

This package does **not** use ext-core `startSubagent`. That contract cancels children
when the parent shuts down, which cannot provide surviving, reconnectable runtimes.
Parent reload only drops local connectors, watches, widgets, and status; live runners
stay up.

Idle handoff is landed. Running-child pause waits for the current Pi turn then holds `turn_end`/`finishTurn` (Pi >= 0.87.0); implementation is SUB-08.
Native `/resume` of the same session outside the managed attach path is not
intercepted.

## Unified background tasks

`task` 是本包对共享后台任务契约的 producer，与 Bash 后台任务走同一套 registry、`wait_tasks`
与通知窗口（契约见 [`background-tasks.md`](background-tasks.md)）。它解析 agent、冻结结果契约、
以有界队列管理 agent 并发，并把结果只通过 `submit_task_result` 收回。

- 一个 `task` 调用对应一个专属 child：不进入会话模式的 30 秒空闲缓冲，不 attach，不接收
  follow-up，结果与静止确认后立即终止 runner；进程槽位在确认退出后释放。
- 会话模式（`spawn_subagent` / `send_subagent` / `attach`）与 Task 模式互不越界：Task child 的
  `send`、`attach` 与恢复被明确拒绝，而不是悄悄降级成会话语义。
- 共享 registry 缺失时 `task` 入口不激活，并说明缺少 `@hheei/pi-ext-tools` 集成；本包不会因此
  创建第二个 registry。
- 会话模式 child 的 `contact_parent` 报告也以 `deliverAs: "followUp"` 投递：parent 空闲时
  立即开启新 turn，运行中排入当前 run（busy 时由 host 合并 follow-up）；不用 `nextTurn`，那会把
  报告扣到用户下一次发言，也不用只追加的 `triggerTurn: false`，那会让报告停着等下一条用户输入。
- parent 空闲时第一条报告开启固定 30 秒合并窗口：多 agent 同时回报时合成一条 follow-up、只叫醒
  一次；parent 自己开始活动则把暂存报告排入该 run。合并只影响空闲路径，运行中的报告立即投递。
- `outputSchema` 在启动前按 allowlist 校验，未通过校验的结果不会以成功终态交付；内置只读
  内置定义（`scout`/`worker`/`reviewer`）是最后发现层，不写入用户 home，也不会被自动派发；
  `reviewer` 依赖 child 自己的 skill 发现来读取审查 skill（`--skill` 只接受路径）。
