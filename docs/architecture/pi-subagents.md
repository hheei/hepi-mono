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
afterwards. `spawn_agent` prefers a panel (a new Herdr tab or cmux surface
running the child's own Pi TUI) targeting the parent's current workspace, and falls back to a headless
background process when this parent has no host. Panel launches pass Pi's `--approve` flag so project-file
trust cannot interrupt startup. The presentation is frozen in the registry as `panel` | `background` (see
[`PLAN-panel-bridge.md`](../pi-subagents/PLAN-panel-bridge.md)).
Native `/resume` of the same session outside the managed path is not intercepted.

系统确认成功的 idle 回收保留可恢复身份：后续 `send_agent` 使用同一 session。人工关闭 panel、
panel 中 child 的外部退出与 `stop_agent` 则落终态 `stopped`：send 明确失败、不可直接重试，
提示新建 child；session 文件仍保留。runtime 死活不明时同样明确拒绝，不启动第二个 writer，
不增加 panel 身份持久化或恢复探测。

启动失败必须写回 registry 的 `error` 状态，工具结果保留 child ID、已发生的副作用和安全重试条件。
已确认退出的启动尝试删除 runtime 证据与 token；仍可能存活的 runtime 保留证据，不允许直接重试。
新 runtime 的 bridge 启动窗口为 20 秒，旧 runtime 的恢复窗口仍为 5 秒；启动包含宿主命令和清理，
manager 的默认启动 deadline 为 60 秒。`forkFrom` 只是上下文文件引用，bridge 启动失败不等于引用解析失败。
自动汇报读取 transcript 后必须重新核对工作版本、入站活动和当前状态；过期汇报不能覆盖新 turn 或触发回收。
widget 在终态冻结 elapsed，保留展示 15 秒后隐藏并停止刷新计时器。宿主确认进程退出不能说明是人工关闭，
诊断不得将退出原因归到用户。

## Unified background tasks

子 Agent 的生命周期由 `SubagentManager` 通过 `bindTaskRegistry` 统一接入 ext-core 的 `TaskRegistry`，与后台 Bash 任务共享同一套 `wait_tasks` 跟踪与管理体系（契约见 [`background-tasks.md`](background-tasks.md)）。

- 子 Agent 在 `spawn_agent` 时向 `TaskRegistry` 登记任务；任务完成、沉降并汇报后标记为 `completed`，发生不可恢复错误或主动报告 blocked 时标记为 `failed`。
- 子 Agent 报告与后台 Bash 结果共用 ext-core 完成门控。parent 忙时以 `steer` 进入下一模型步骤；空闲时普通消息等所有后台工作结束再统一唤醒一次，只有最后一条消息设置 `triggerTurn: true`。
- `blocked` 报告不等待完成门控，立即唤醒空闲 parent。
- 内置定义（`scout`/`worker`/`reviewer`）是最后发现层，不写入用户 home，也不会被自动派发。其中 `scout` 默认禁用（需用户显式配置模型），`worker` 与 `reviewer` 继承父模型。
- `skills` 是白名单：`all`（缺省）/ `none` / 名单；名单条目可以是 skill 名字，按 parent 已加载的 skill 列表解析成绝对路径，未知名字只 warning 并丢弃。
