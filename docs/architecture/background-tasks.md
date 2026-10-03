# 后台任务契约（background tasks）

## 状态

本文记录已实现的统一后台任务契约：Bash 命令与 Agent 委派共用同一套登记、控制、等待与通知路径。

## 为什么统一

同一段父 turn 里，两条独立路径曾各自处理“长时间运行的工作”：Bash 有 job registry 与
`async` 参数，subagent 有 child/session 语义与 `contact_parent`。结果是同一件事（一个还没
结束、结果稍后要回到父上下文的工作）有两套 ID、两套状态和两套通知策略。统一后的目标不是
把所有执行改造成同一种运行时，而是让“一次有明确结果的执行”只有一个契约。

## 抽象：Task、child session 与 runner 是三种东西

- **Task**：一次有明确终态的执行。只进入终态一次；之后的新工作是新 task ID。
- **Child session**：可被复用的上下文（`spawn_agent` 的会话模式）。
- **Runner**：承载该会话的进程。

`task` 第一版每次创建**专属 child**：它执行一次、提交一次结果、随后被终止。因此
`task` 不提供复用 child 的参数，也不允许 attach、完成后唤醒或再次投喂输入；需要这些语义
时使用会话模式。进程槽位在确认退出后才释放，只收到终态或只发出通知都不算释放。

## Ownership

| Owner | 职责 | 不承担 |
| --- | --- | --- |
| ext-core `TaskRegistry` | task identity、状态、wait/stop 契约、终态保留、纯终态通知 | 启动进程、Pi 消息文案、模型路由、产品交付策略 |
| ext-core `BackgroundDelivery` | 同一 runtime 的后台活动源与交付通道协调、单次唤醒 | 结果存储、执行、模型路由 |
| pi-ext-tools task-control | 创建并 `provideService` 当前 session 的唯一 registry；注册 list/wait/stop；结果消息与交付确认 | 解析 agent 定义、管理 child |
| Bash producer | Bash 进程、日志、timeout、停止与退出确认 | Agent 并发队列 |
| pi-subagents | agent 解析、RPC 生命周期、agent admission、软提示、schema 结果校验、`task` 入口 | Bash 进程、第二套 registry |

通过 ext-core Service（`TASK_REGISTRY_SERVICE_KEY`）共享实例，provider 与 consumer 之间没有
新的 orchestrator 框架，也不允许出现第二个 registry。单独安装 pi-subagents 时，会话工具照常
可用，`task` 入口不激活并明确说明缺少集成服务；它不会静默回退到 `spawn_agent`。

## 状态与终态

`queued → starting → running → terminal`。terminal 为 `completed | failed | cancelled |
timed_out`。受理时冻结的是任务身份与输入：id、`type`、`purpose`、显式 `cwd`、完整 `agent` 名、
`task` 文本、result contract（`outputSchema` 与 soft hint 阈值）与 inline/background 交付方式。
排队期间父模型与磁盘配置的变化不会改变这些字段，也不会让一个任务变成另一个任务。

不冻结的是**解析后的启动策略**：工具权限、模型、thinking 与 agent 定义正文在真正启动时解析
（`queued` 任务出队时才解析 agent 文件与父模型）。因此并发已满、任务在队列中等待时，父会话期间切换
模型或修改 agent 定义会作用于该任务。这是有意的取舍：把解析提前到受理会改动 `SubagentManager.spawn`
的既有契约与状态机，而"任务排队期间有人改父模型"在实践中几乎不会发生。需要绝对冻结时应避免超过并发上限
的排队，或先 `stop_tasks` 后重新发起。

- 取消是请求：请求一旦发出，任务状态即为 `stopping`（活动状态，`list_tasks` 可见），只有执行停止被确认后
  才提交 `cancelled`；未 attach 控制面的任务也会记住该请求，迟到的 binding 会立即被停掉而不是开始无人取消的工作。
  已终结的 task 不会被迟到事件改写。
- 自然完成与取消竞态：若执行先自然结束，保留真实 `completed`/`failed`。
- Agent 任务只有在**匹配当前执行的 `agent_settled`**、且已提交被校验的最终结果时才
  `completed`；`agent_end` 不足以终结。静止但没有合法结果时为 `invalid_result` 失败（终态 `status`
  仍是 `failed`，原因记在生产者 detail 的 `reason`），而不是
  反复唤醒 child 修复。
- child 有尚未结束的自身后台工作时不得提交成功结果。

## 容量与背压

受理时预留结果槽位与单结果字节预算，直到通知被观察到或任务归属结束：64 条终态保留、64 条未
确认结果、单条通知 10,000 字符、合并消息 24,000 字符、结构化结果约 32 KiB（超限拒绝而非截断）。
结构化结果在通知里只会**完整内联或被指路**：超过单条上限时通知只说明结果大小并指向
`wait_tasks`，绝不截断成半份 JSON。终态记录本身也在写入时按同一上限收敛输出（保留生产者的
`truncated` 标记），不只在读取时收敛。
交付积压占满预算时拒绝新的后台任务并给出原因；Bash 的 60 秒自动转换若无法预留槽位则保持前台
并说明转换未发生。Agent 侧并发上限 4、等待队列 32，队列满时在受理阶段报错。容量预留在受理时占用，
直到该结果被确认为 `observed` 才释放（见“交付”）：未确认的结果既不会被淘汰，也不会让位给新任务。

## 选择 blocking 还是后台

`blocking` 只决定调用者怎么拿到结果，不改变执行路径、并发上限或进程模型。`task` 默认等待：受理后在同一
次调用里返回结果（review、审计、verification、scout 侦查都属于这一类），只有显式 `blocking: false` 才
后台启动并立刻返回 task id，结果稍后经通知到达。`bash` 的缺省方向不同：本地命令默认前台等待，只有超过
`autoAsyncSeconds`（60s）才自动转后台，显式 `blocking: true` 会关掉这次自动转换。两个工具的 schema 与
guideline 都要各自说明这一点。

## 交付

不再使用固定时间窗口。Bash/task 结果与 `spawn_agent` 的报告共用同一 runtime 的完成门控：

- 父 agent 正在运行时，待交付内容立即以 `steer` 进入下一模型步骤，不打断当前工具批次。
- 父 agent 空闲时，普通结果与报告等待所有活动后台工作结束，再统一触发一次新回合。TaskRegistry 的 queued/starting/running/stopping 均为活动；child 的启动与运行直到 `agent_settled` 才结束，`agent_end` 不算最终完成。
- `need_decision` / `blocked` 是例外：空闲父 agent 只先接收紧急报告并立即被唤醒，避免 child 等待父回复而门控又等待 child 的死锁。普通结果不借紧急报告绕过空闲门控，父 agent 开始运行后才以 `steer` 进入下一步。
- 同一轮检查先追加所有消息，只有最后一条请求新回合；忙时所有消息都走 `steer`。同一事件批次通过微任务合并检查，不引入新的秒级窗口。
- 工作源与通道由各具体 extension 注册并清理；ext-core 只协调，不拥有队列或 transcript。单独安装任一 extension 仍成立。lifecycle signal 中止后，通道不能请求新回合；拆卸时 subagent 报告只追加，Task 结果仍遵循原交付确认规则。

合并仍受总字节与条目数约束，小结果很多时拆成多条消息。`wait_tasks` 直接返回终态与受限结果，不消费、不提前 flush 自动通知。阻塞调用（`task` 的缺省方式）在受理时就登记为
“结果由调用方自己上报”，因此终态不预留通知容量、也不会再被通知一次；它的结果只走本次 tool_result。
若该调用被中断，调用方在返回前显式放弃这份内联结果（`releaseInlineResult`），此后无论任务以
`completed`（结果已提交）还是 `cancelled` 收尾，都会走正常的后台通知通道，而不是把结果留在已经返回的
调用里；已结算的记录会因此重新变成待交付结果。交付记录区分
`pending → submitted → observed`：`submitted` 只表示已调用 host API，`observed` 由匹配 task/batch 的
custom message 生命周期事件确认，都不声称模型已理解结果。只有未交付（`pending`/`submitted`）的结果会被
刻意保留：它们可能还没进入模型上下文，所以既不会被保留上限淘汰，也一直占用受理预算（`wait_tasks` 因此
始终能读到它们）。只有 `observed` 或从未需要通知（`inlineResult`）的记录才参与保留上限淘汰。
host 明确拒收（`sendMessage` 同步抛错）时会把该批次退回 `pending` 重发；但**不承诺**为“已交给 host 却
始终等不到生命周期确认”的结果自动重发，也不会为此引入持久化 outbox——那类结果在 session 内仍可直接读取。

控制工具（list/wait/stop）在任何活动任务存在、或任何结果尚未被 `observed` 时保持可用：host 接受了消息
不等于模型读到了它，`/tree` 等边界也不会把它卸载。

## session 与分支

registry 是 session runtime 状态，不新增持久化调度器。session 替换/reload 会通过
`session_shutdown` 清理旧 timer、waiter、订阅与队列。`/tree` 不触发 session_shutdown，因此任务
记录启动分支的 entry anchor：当前分支不再包含该 anchor 时暂停自动投递，任务仍可显式查看/停止；回到该分支
（`session_tree`）时重新按完成门控检查待交付结果，已经交给 host 队列的消息无法撤回。

## 失败与恢复边界

- 启动失败（launch 抛出）在受理阶段结算为 `failed`，不留下永久 `running` 的假任务。
- 排队中取消不启动进程；启动中取消会清理迟到的 runner，且在该 runner 退出确认前不释放进程槽位。
- 停止（`stop`）只有在进程退出被确认后才算完成：只收到 shutdown 回执或 socket 断开都不算，未确认时
  保留 runtime 证据并让调用方看到未确认，进程槽位继续占用。我们自己 spawn 的 runner 用进程句柄直接
  观察退出；确认退出后 claim 才会释放，未确认则保留 claim，避免为同一 session 启动第二个 runner。
- runner 退出未确认时保留 runtime 证据并把任务留在可观察状态，不释放进程槽位、不盲目启动第二次执行。
- 同理，spawn 之后、runner 自己写入 runtime 元数据之前的那段窗口只有 claim 里的 pid 作为证据：此时停止不算
  已确认，也不会释放 session 让第二个 runner 启动；确认进程已退出后才算完成。
- 因为该原因而 `failed` 的子代理不是永久废弃：后续 `send` 会重新确认进程已死亡，此时释放死 claim 并回到可继续
  使用的 `done`；仍可能存活时继续拒绝。没有留下任何进程证据（未记录 runner pid）的启动只能保守拒绝：无法证伪的
  进程不能被第二个 runner 覆盖，这是有意的残留限制。
- 不承诺跨进程崩溃的 exactly-once，也不为此新增持久化 outbox。

## 完成门控的不变量

- 初始输入投递未确认不能推导出工作结束；已开始的 child 保持活动计数，直到最终 settled、确认退出或实际状态查询确认空闲。
- child 状态查询与 transcript 获取独立。transcript 获取失败不妨碍确认忙闲；实际状态也无法确认时明确报告恢复失败，不伪装成已恢复。后续 bridge 重连重新确认。
- 活动计数按启动版本保护；旧 `agent_settled` 或 adoption 的异步写回不能覆盖更新的 `agent_start`。
- 交付前重新确认通道仍注册且未取消。若最后的唤醒通道在同步交付中被取消，不能为了补唤醒而制造额外消息或请求已取消的回合。

## Agent 结果契约

`outputSchema` 是 JSON Schema。开始前用 allowlist 校验其形态：TypeBox 会静默忽略不认识的关键字、
未知 format 与部分非法结构，因此不支持的关键字、外部 `$ref`、无法终止的 `$ref` 环、超大 schema
都在启动前拒绝，而不是悄悄少校验。指定 schema 时成功结果必须通过校验；未指定时可以返回文本。
两者都只通过 Task child 专属的 `submit_task_result` 提交：它必须是该 assistant 消息唯一的
tool call，提交前校验并保存候选，随后返回 Pi 原生 `terminate: true`。普通 `contact_parent` 只承载
进度、发现与求助。

软提示只在跨过阈值时提醒一次，提醒目标、进展与收敛建议，不 abort、不切模型、不改变终态，也不在
已有合法候选后注入。阈值是策略常量（当前 60 轮），不是硬轮次上限。

内置定义有三个：只读侦查 `scout`、实现 `worker`、审查 `reviewer`。都可被发现但不会被自动派发，定义随包
发布而不写入用户 home，优先级低于项目与用户目录中的同名定义；都继承父模型与 thinking，各自只启用定义里
列出的工具。`worker`/`reviewer` 的 `bash` 不是沙箱：它们能跑验证命令，也就能改文件。
