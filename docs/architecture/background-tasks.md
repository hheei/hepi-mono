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
- **Child session**：可被复用的上下文（`spawn_subagent` 的会话模式）。
- **Runner**：承载该会话的进程。

`task` 第一版每次创建**专属 child**：它执行一次、提交一次结果、随后被终止。因此
`task` 不提供复用 child 的参数，也不允许 attach、完成后唤醒或再次投喂输入；需要这些语义
时使用会话模式。进程槽位在确认退出后才释放，只收到终态或只发出通知都不算释放。

## Ownership

| Owner | 职责 | 不承担 |
| --- | --- | --- |
| ext-core `TaskRegistry` | task identity、状态、wait/stop 契约、终态保留、纯终态通知 | 启动进程、Pi 消息文案、模型路由、5 秒产品策略 |
| pi-ext-tools task-control | 创建并 `provideService` 当前 session 的唯一 registry；注册 list/wait/stop；固定通知窗口与父会话消息 | 解析 agent 定义、管理 RPC child |
| Bash producer | Bash 进程、日志、timeout、停止与退出确认 | Agent 并发队列 |
| pi-subagents | agent 解析、RPC 生命周期、agent admission、软提示、schema 结果校验、`task` 入口 | Bash 进程、第二套 registry |

通过 ext-core Service（`TASK_REGISTRY_SERVICE_KEY`）共享实例，provider 与 consumer 之间没有
新的 orchestrator 框架，也不允许出现第二个 registry。单独安装 pi-subagents 时，会话工具照常
可用，`task` 入口不激活并明确说明缺少集成服务；它不会静默回退到 `spawn_subagent`。

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

- 取消是请求：只有执行停止被确认后才提交 `cancelled`；已终结的 task 不会被迟到事件改写。
- 自然完成与取消竞态：若执行先自然结束，保留真实 `completed`/`failed`。
- Agent 任务只有在**匹配当前执行的 `agent_settled`**、且已提交被校验的最终结果时才
  `completed`；`agent_end` 不足以终结。静止但没有合法结果时为 `invalid_result` 失败，而不是
  反复唤醒 child 修复。
- child 有尚未结束的自身后台工作时不得提交成功结果。

## 容量与背压

受理时预留结果槽位与单结果字节预算，直到通知被观察到或任务归属结束：64 条终态保留、64 条未
确认结果、单条通知 10,000 字符、合并消息 24,000 字符、结构化结果约 32 KiB（超限拒绝而非截断）。
交付积压占满预算时拒绝新的后台任务并给出原因；Bash 的 60 秒自动转换若无法预留槽位则保持前台
并说明转换未发生。Agent 侧并发上限 4、等待队列 32，队列满时在受理阶段报错。

## 交付

第一个待交付结果在 t0 到达时开启**固定**窗口，t0+5s 提交；窗口内完成的结果合并，后续完成不延长
窗口。合并同时受总字节与条目数约束，小结果很多时也会拆成多条消息，而不是堆成一条无法阅读的
长消息。`wait_tasks` 直接返回终态与受限结果，不消费、不提前 flush 自动通知。阻塞调用（`blocking: true`）在受理时就登记为
“结果由调用方自己上报”，因此终态不预留通知容量、也不会再被通知一次；它的结果只走本次 tool_result。交付记录区分
`pending → submitted → observed`：`submitted` 只表示已调用 host API，`observed` 由匹配
task/batch 的 custom message 生命周期事件确认，都不声称模型已理解结果。同步 task 的结果只走原
tool_result，不进入后台队列。

## session 与分支

registry 是 session runtime 状态，不新增持久化调度器。session 替换/reload 会通过
`session_shutdown` 清理旧 timer、waiter、订阅与队列。`/tree` 不触发 session_shutdown，因此任务
记录启动分支的 entry anchor：当前分支不再包含该 anchor 时暂停自动投递，任务仍可显式查看/停止；回到该分支
（`session_tree`）时重新开启窗口投递待交付结果，已经交给 host 队列的消息无法撤回。

## 失败与恢复边界

- 启动失败（launch 抛出）在受理阶段结算为 `failed`，不留下永久 `running` 的假任务。
- 排队中取消不启动进程；启动中取消会清理迟到的 runner。
- runner 退出未确认时保留 runtime 证据并把任务留在可观察状态，不释放进程槽位、不盲目启动第二次执行。
- 不承诺跨进程崩溃的 exactly-once，也不为此新增持久化 outbox。

## Agent 结果契约

`outputSchema` 是 JSON Schema。开始前用 allowlist 校验其形态：TypeBox 会静默忽略不认识的关键字、
未知 format 与部分非法结构，因此不支持的关键字、外部 `$ref`、无法终止的 `$ref` 环、超大 schema
都在启动前拒绝，而不是悄悄少校验。指定 schema 时成功结果必须通过校验；未指定时可以返回文本。
两者都只通过 Task child 专属的 `submit_task_result` 提交：它必须是该 assistant 消息唯一的
tool call，提交前校验并保存候选，随后返回 Pi 原生 `terminate: true`。普通 `contact_parent` 只承载
进度、发现与求助。

软提示只在跨过阈值时提醒一次，提醒目标、进展与收敛建议，不 abort、不切模型、不改变终态，也不在
已有合法候选后注入。阈值是策略常量（当前 60 轮），不是硬轮次上限。

内置 `scout` 是只读发现的默认定义：可被发现但不会被自动派发，定义随包发布而不写入用户 home，
优先级低于项目与用户目录中的同名定义；它继承父模型与 thinking，只启用读取/搜索与报告工具。
这是工具能力限制，不是操作系统沙箱。
