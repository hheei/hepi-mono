# pi-subagents

`@hheei/pi-subagents` is the concrete extension for independent, reconnectable Pi
child sessions. Live contract: [`docs/pi-subagents/spec.md`](../pi-subagents/spec.md).
Design sources: `PLAN.md` and `PLAN-delivery-presentation.md` in the same folder.

Ownership:

- Parent branch: agent policy, the sqlite ledger, SubagentManager, model-facing tools, UX.
- Child branch: command dispatch, lifecycle reporting, `contact_parent`. Not a manager, and it never closes its own panel.
- HostAdapter: Herdr tab / cmux surface open/observe/cleanup (including the `focused` answer and the
  `reportsFocus` capability). Not identity, and never a second Pi argv builder: the parent builds the
  LaunchSpec, the host only runs it and reports what it observes.

This package does **not** use ext-core `startSubagent`. That contract cancels children
when the parent shuts down, which cannot provide surviving, reconnectable runtimes.

Control is one sqlite file (`state.sqlite`): child rows are the ledger, command rows are the mailbox.
Parent and child both open it. A dropped poll is not a dead child. Each child holds an exclusive lock
file while it is that child's writer; the kernel releases it on process death. The lock is the only
liveness fact — there is no presence row. A lock file that is already free at reconcile, or a background pid that is already dead, is a gone
runtime. A child that was still running is marked blocked and reported once. Panel and pid still say whether a surface should be opened again. Parent reload drops only
local state (timers, projectors, subscriptions); a surviving child keeps writing the same file, and a
background child is held by its stdin pipe, so it ends with the parent process.

There is no attach or detach: a child is presented where it was spawned and never switches
afterwards. `agent_spawn` prefers a panel (a new Herdr tab or cmux surface
running the child's own Pi TUI) targeting the parent's current workspace, and falls back to a headless
background process when this parent has no host. Panel launches pass Pi's `--approve` flag so project-file
trust cannot interrupt startup. The presentation is frozen in the registry as `panel` | `background` (see
[`PLAN-panel-bridge.md`](../pi-subagents/PLAN-panel-bridge.md)).
Native `/resume` of the same session outside the managed path is not intercepted.

系统确认成功的 idle 回收保留可恢复身份：后续 `agent_send` 使用同一 session。写者消失（进程锁已空，或本进程看见自己的后台进程退出）记 `blocked` 并回报一次，不改成 stopped intent；后续 `agent_send` 用同一 session 再起 runtime，调用方不要为此另 spawn。宿主已确认 panel 进程不在时关掉空标签；标签还在则留着，要收掉由调用方 `agent_stop`。只有本进程的进程句柄还活着时，send 才拒绝再起一个 runtime，并要求先 stop 这个 child。锁还被持有时输入交给当前写者，不另起一个。
`agent_stop` 仍先写 stopped intent。panel 身份按 [`spec.md`](../pi-subagents/spec.md) §7.7 写进会话租约。reload 只重绑还在的 tab 或 pid。宿主换代时，`before_agent_start` 之前把当时仍挂着的 panel 拉回。

启动失败必须写回 registry 的 `error` 状态，工具结果保留 child ID、已发生的副作用和安全重试条件。
已确认退出的启动尝试删除 runtime 证据与 token；仍可能存活的 runtime 保留证据，不允许直接重试。
新 runtime 的 bridge 启动窗口为 20 秒，旧 runtime 的恢复窗口仍为 5 秒；启动包含宿主命令和清理，
manager 的默认启动 deadline 为 60 秒。
自动汇报读取 transcript 后必须重新核对工作版本、入站活动和当前状态；过期汇报不能覆盖新 turn 或触发回收。
宿主确认进程退出不能说明是人工关闭，诊断不得将退出原因归到用户。

## 紧凑状态与交互报告

父会话通过原生 `setStatus("pi-subagents", text)` 发布机器人 emoji、运行 glyph 与正在运行的 child 编号；`agent-21` 显示为 `#21`，显示编号不改变真实工具 ID。`pi-status` 在 Footer 第二行右侧按 agent、TODO 顺序组合，以 ` ‧ ` 分隔。缺少 pi-status 时使用 Pi 原生状态展示，不需要修改 Pi host 或依赖具体扩展。

移除父会话的多行 Widget、elapsed 刷新和终态保留计时器。状态投影从 manager 读取，过期异步读取不能覆盖新快照；session 切换、reload 或 shutdown 移除状态并取消订阅。子会话自己的身份展示不受影响，完整管理仍通过 `/subagents`。

已确认的报告由原有 ParentChannel 交付后追加一个 `subagent-info` 原生 custom entry：折叠时只显示 glyph、编号、agent 名称和 done/error/blocked 状态，展开时显示完整报告。entry 支持 resume 和 Headless `entry_appended`，不进入模型上下文。对应的模型消息 `subagent-report` 使用 `display: false`，避免可见报告重复；原有后台完成门控、错误等待、自动重试取消和去重继续由 manager 与 ext-core BackgroundDelivery 拥有。加载时不重新生成历史终态 entry。交互渲染剥离终端控制序列与 C0/C1 字符（保留换行、将 tab 转为空格），持久化和模型仍保留完整原文。info 写入失败时使用原生 error 提示说明原因；已经提交的模型报告不重发。

## 子代理工具说明与动态启用

父会话通过 `tool_search` 按需加载 `agent_spawn`、`agent_send`、`agent_get`、`agent_stop`；已有协作说明由动态启用逻辑提供。`agent_spawn` 的工具描述直接列出父会话启动时发现的可用 agent 名称和职责，沿用发现优先级并排除 disabled/hidden 定义；没有可用定义时明确显示空列表。工具描述明确说明完成结果自动返回，派发后可继续独立工作或结束当前回合，无需轮询。`agent_send` 与 `agent_get` 同样说明自动返回结果。工具不通过 `promptSnippet` 或 `promptGuidelines` 注入额外内容。子会话仍独立提供 `contact_parent` 的阻塞报告指导。

`agent_get({ id, keys? })` 默认返回 `status,progress`，按需选择 `diagnostic`；keys 是逗号分隔字符串，未知 key 报错。查询只提供当前可观察状态和进展，不复述初始任务参数或历史最终回答，不跨族查询 Bash。`agent_spawn` 不接受调用方 ID，已有 child 只能通过 `agent_send` 继续。工具族没有 list 或等待入口。

未激活时在 `deferred_tools` 中介绍 subagents；激活后使用 `subagent_guidance`。动态声明与 provider 的 prompt 重建仍由 Pi host 负责。

## Unified background tasks

子 Agent 的生命周期由 `SubagentManager` 通过 `bindTaskRegistry` 统一接入 ext-core 的 `TaskRegistry`，与后台 Bash 共享内部活动登记和交付协调，模型工具按 ownership 分族（契约见 [`background-tasks.md`](background-tasks.md)）。

- 子 Agent 在 `agent_spawn` 时向 `TaskRegistry` 登记任务；任务完成、沉降并汇报后标记为 `completed`，发生不可恢复错误或主动报告 blocked 时标记为 `failed`。
- 子 Agent 报告与后台 Bash 结果共用 ext-core 完成门控。parent 忙时以 `steer` 进入下一模型步骤；空闲时普通消息等所有后台工作结束再统一唤醒一次，只有最后一条消息设置 `triggerTurn: true`。
- `blocked` 报告不等待完成门控，立即唤醒空闲 parent。
- 自动交付保留已确认的终态：失败为 `error`，可继续的中断或阻塞为 `blocked`，成功为 `done`；不能把失败统一改写为阻塞。重试成功的最终 assistant 消息清除旧错误，交付前在 child mutation 锁内读取最新状态。
- `pi-subagents` 的 `error` 在最终确认后等待 10 秒自动报告，只发送本次错误，不拼接历史回答；作为紧急报告绕过其他后台任务的等待，并请求主 agent 新回合。等待期间用户继续输入、parent 发送新消息或自动重试会取消旧错误报告；自动重试期间不报告暂时错误，成功与中断自动报告保持 5 秒等待。
- `agent_send` 接受已有 child 的各种状态，包括 `error` 和已停止的 child。写者还在就把输入交给它；写者已经没了就用同一 session 再起 runtime，调用方不要另 spawn。显式发送会重新激活 stopped intent。只有本进程的进程句柄还活着时才拒绝再起 runtime，并要求先 `agent_stop` 这个 child。失败不保证上游错误会恢复。
- 内置定义（`scout`/`worker`/`reviewer`）是最后发现层，不写入用户 home，也不会被自动派发。其中 `scout` 默认禁用（需用户显式配置模型），`worker` 与 `reviewer` 继承父模型。
- `skills` 是白名单：`all`（缺省）/ `none` / 名单；名单条目可以是 skill 名字，按 parent 已加载的 skill 列表解析成绝对路径，未知名字只 warning 并丢弃。
