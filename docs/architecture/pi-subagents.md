# pi-subagents

`@hheei/pi-subagents` is the concrete extension for independent, reconnectable Pi
child sessions. Live contract: [`docs/pi-subagents/spec.md`](../pi-subagents/spec.md).
Design sources: `PLAN.md` and `PLAN-delivery-presentation.md` in the same folder.

Ownership:

- Parent branch: agent policy, registry, BridgeServer, SubagentManager, model-facing tools, UX.
- Child branch: request dispatch, Pi event forwarding, `contact_parent`/lifecycle/task-result
  reporting, reconnect with a bounded report buffer. Not a manager, and it never closes its own panel.
- HostAdapter: Herdr tab / cmux surface open/observe/cleanup (including the `focused` answer and the
  `reportsFocus` capability). Not identity, and never a second Pi argv builder: the parent builds the
  LaunchSpec, the host only runs it and reports what it observes.

This package does **not** use ext-core `startSubagent`. That contract cancels children
when the parent shuts down, which cannot provide surviving, reconnectable runtimes.

Control is a child bridge, not an RPC writer: the parent listens on one socket per parent session and
every child dials in, so the connection is both the control plane and the liveness answer. Parent
reload drops only local state (timers, projectors, subscriptions); a surviving child reconnects and is
adopted, and a background child is held by its stdin pipe, so it ends with the parent process.

There is no attach or detach: a child is presented where it was spawned and never switches
afterwards. `spawn_agent` and the `task` tool prefer a panel (a new Herdr tab or cmux surface
running the child's own Pi TUI) and fall back to a headless background process when this parent
has no host. Panel launches pass Pi's `--approve` flag so project-file trust cannot interrupt the
startup. Task remains a one-shot execution settled by its parent; its panel is only the child's
runtime presentation. The presentation is frozen in the registry as `panel` | `background` (see
[`PLAN-panel-bridge.md`](../pi-subagents/PLAN-panel-bridge.md)).
Native `/resume` of the same session outside the managed path is not intercepted.

系统确认成功的 idle 回收保留可恢复身份：后续 `send_agent` 使用同一 session。人工关闭 panel、
panel 中 child 的外部退出与 `stop_agent` 则落终态 `stopped`：send 明确失败、不可直接重试，
提示新建 child；session 文件仍保留。runtime 死活不明时同样明确拒绝，不启动第二个 writer，
不增加 panel 身份持久化或恢复探测。

## Unified background tasks

`task` 是本包对共享后台任务契约的 producer，与 Bash 后台任务走同一套 registry、`wait_tasks`
与完成门控（契约见 [`background-tasks.md`](background-tasks.md)）。它解析 agent、冻结结果契约、
以有界队列管理 agent 并发，并把结果只通过 `submit_task_result` 收回。

- 一个 `task` 调用对应一个专属 child：不进入会话模式的空闲回收，不接收
  follow-up，结果与静止确认后立即终止 runtime；进程槽位在确认退出后释放。
- 会话模式（`spawn_agent` / `send_agent`）与 Task 模式互不越界：Task child 的 `send` 与恢复
  被明确拒绝，而不是悄悄降级成会话语义。
- 共享 registry 缺失时 `task` 入口不激活，并说明缺少 `@hheei/pi-ext-tools` 集成；本包不会因此
  创建第二个 registry。
- 会话 child 报告与 Task/Bash 结果共用 ext-core 完成门控。parent 忙时以 `steer` 进入下一模型步骤；
  空闲时普通消息等所有后台工作结束再统一唤醒一次，只有最后一条消息设置 `triggerTurn: true`。
- `need_decision` / `blocked` 立即唤醒空闲 parent；parent 自己开始活动则把暂存报告送入该 run。
  不使用固定时间窗口或 `nextTurn`。child 的活动计数与空闲回收以 `agent_settled` 为准，避免在
  `agent_end` 后仍有重试、压缩或 continuation 时误判完成。
- `outputSchema` 在启动前按 allowlist 校验，未通过校验的结果不会以成功终态交付；内置只读
  内置定义（`scout`/`worker`/`reviewer`）是最后发现层，不写入用户 home，也不会被自动派发。
  `skills` 是白名单：`all`（缺省）/ `none` / 名单；名单条目可以是 skill 名字，按 parent 已加载的 skill
  列表（`before_agent_start` 的 `systemPromptOptions.skills`）解析成绝对路径，未知名字只 warning 并丢弃。
