# Subagent 接入统一 Task：实施计划

状态：设计审查已完成本轮修订；尚未实施运行时代码。本计划中的 task 指后台执行任务，与 todo 无关。已核对 Pi host 0.87.0 的消息与最终结束语义，以及固定 revision 的 oh-my-pi 预算机制。实施须通过文末契约测试，不以计划审查替代运行验证。

## 1. 已确认的约束

- Bash 与 agent task 使用 `blocking?: boolean`，删除 `async` 参数，不保留兼容别名。两者控制同一维度，但布尔方向相反：原 `async: true` 对应 `blocking: false`。
- 统一任务登记、查询、等待和停止；通用契约可移入 ext-core，具体执行仍归 producer。
- 后台完成通知使用 5 秒合并窗口；允许子 Agent 并发限流与排队。
- 通过 `outputSchema` 约束子 Agent 的 JSON 结果，不新增 artifact 存储体系。
- 只做软工作量提示，不设硬轮次上限，也不以“熔断”名义添加第二个硬上限。
- 内置 `scout`，作为默认可用 agent 定义；继承父模型，不自动启动或切换到低价模型。

## 2. 实现基线与参考范围

| 位置 | 已核实的行为 | 对设计的影响 |
| --- | --- | --- |
| `packages/pi-ext-tools/src/tasks/registry.ts` | 只登记后台任务；`begin` 同步返回 binding；通知使用 `triggerTurn: false`；等待只观察，不消费交付 | 不能把当前实现描述成自动唤醒父模型的全局调度器；RPC 异步启动还需适配 |
| `packages/pi-ext-tools/src/task-tools.ts` | pi-ext-tools 注册控制工具，按任务情况激活；registry 从 FFF session state 获取 | 移动类文件不会让两个 extension 自动共享同一个实例 |
| `packages/pi-ext-tools/src/bash.ts` | 本地无 timeout 命令默认 60 秒后转后台；远程不支持后台 | 显式 `blocking: true` 与既有自动转后台行为冲突，必须定义缺省与显式值 |
| `packages/pi-ext-core/src/subagents.ts` | `runSessionTurn` 达到 maxTurns 后 steer，额外 5 轮后 abort | 当前所谓 soft maxTurns 不符合本次“只软控制”；不能直接套用，不能顺带改变 memory 等既有消费者 |
| `packages/pi-subagents/src/manager.ts` | 持久化 child 会话、send、report、30 秒休眠、唤醒；contactParent 不代表终态 | task identity 不能等同 child identity，汇报不能直接触发 settle |
| `packages/pi-subagents/src/runner.ts` | shutdown 请求先应答，再执行关闭 | shutdown ACK 不等于进程已经退出 |
| `packages/pi-subagents/src/connector.ts` | close 仅关闭父连接，不终止 runner/child | 不能通过关闭连接证明休眠或停止成功 |
| `packages/pi-ext-core/src/service.ts` | 已有带生命周期的 provideService/getService | 优先复用现有跨 extension 协作机制，不新增 provider 总线 |
| Pi host 0.87.0 `dist/core/agent-session.js` | streaming 时 triggerTurn 未设为 false 的 followUp 在整次 agent run 结束后消费；公开 sendMessage 返回 void，异步错误在 host 内报告 | wait 必须直接返回结果，不能把 follow-up 入队等同于下一次模型请求已能读到结果 |
| Pi host 0.87.0 `docs/extensions.md`、`examples/extensions/structured-output.ts` | agent_end 后可能继续自动重试；agent_settled 才是最终静止通知；terminate 只在同批工具全部终止时生效 | 结构化提交与最终完成分开，不能看到 agent_end 或一个 terminate 就立刻杀 runner |

互斥锁只证明本地操作顺序；shutdown、落盘、重连和事件确认仍有独立边界。参数迁移须审计实际调用方，不能用局部搜索的命中数量代替影响范围分析。

本轮核对 [oh-my-pi executor.ts，revision e9f1da06f7b3320114d8020c5a08a3f6ccb848ac](https://github.com/can1357/oh-my-pi/blob/e9f1da06f7b3320114d8020c5a08a3f6ccb848ac/packages/coding-agent/src/task/executor.ts#L1630)：其 soft request budget 在阈值提示、1.5 倍阈值停止自由执行，宽限后仍可能硬取消。本项目只借鉴提示与明确结果提交的思路，明确不采用后两步。[structured-subagent.ts](https://github.com/can1357/oh-my-pi/blob/e9f1da06f7b3320114d8020c5a08a3f6ccb848ac/packages/coding-agent/src/task/structured-subagent.ts) 还包含 schema 来源、宽松模式和 artifact 等能力，本版不照搬这些分层。

[tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) 的通知聚合与 [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) 的默认角色仅作为产品参考。本版不依赖此前搜索摘要中的默认数值、具体工具白名单或内部实现。

## 3. 抽象：任务、会话与进程分别建模

**Task 是一次有明确结果的执行。Child session 是可以被复用的上下文。Runner 是运行该会话的进程。**

- 一个 Task 只进入一次终态；后续发起新工作生成新的 task ID，不把旧 task 从 completed 改回 running。
- 抽象允许一个 child 先后承担多个 Task，但第一版 `task` 每次创建专属 child，不暴露复用已有 child 的参数。同一 child 至多一个活动 Task，steer 属于当前执行。已有会话模式的 follow-up 保留会话语义，不自动映射成新 Task。
- 保留 child ID 供会话交互、恢复与诊断使用；task ID 用于统一控制，任务记录中明确关联二者。
- child 的 idle/done、进程退出、contact_parent 报告都不独立等价于 Task 成功。必须关联当前执行、确认最终结果与执行已静止。
- 不因 Task 抽象禁止执行中的纠偏；进度、求助和最终结果应有明确差别。只有合法的最终结果才可提交为成功终态。
- 当前 `contactParent` 使用 initialTask 作为报告锚点；复用 child 执行新任务时须携带当前 task ID/目的，防止后续结果仍归于最初任务。

第一条端到端路径使用已有 RPC runner，为一次委派建立 Task 记录。暂不将全部长期会话、TUI attach 和持久化恢复一并改造成任务系统；既有会话工具仍然可用。

Task 专属 child 的最终结果与执行静止确认后，立即请求清理 runner；不进入会话模式的 30 秒空闲缓冲。任务结果可先确定，进程槽位仍需在确认退出后释放。Task child 不开放 TUI attach、完成后自动唤醒或递归派发新 child；这些能力仍属于既有会话模式。所有命令/工具入口都须检查该归属，不能绕过限制。

第一版 `task` 输入只包含 `agent`、`task`、可选 `cwd`、`blocking`、`outputSchema`。agent 明确选择，scout 只是内置可选定义。受理时冻结任务身份与输入（id、type、purpose、显式 cwd、agent 名、task 文本、result contract、交付方式）；排队期间父模型或磁盘配置变化不改变这些字段。

> 实施偏差（已确认）：**解析后的** cwd、agent 定义、模型、thinking 与工具权限仍在该任务真正启动时解析，只有排队等待（并发已满）的任务会读到父会话当时的模型与磁盘定义。把解析提前到受理需要改动 `SubagentManager.spawn` 的既有契约与生命周期，收益不足以匹配成本，因此选择记录真实保证而不是扩大改动面。当前行为见 `docs/architecture/background-tasks.md`。

任务状态流为 `queued → starting → running → terminal`，无需排队或启动已经完成的 producer 可以跳过前置状态。terminal 包含 completed、failed、cancelled、timed_out；执行结果与交付状态分别记录。取消请求尚未确认时保留活动状态和停止进度，不提前伪造终态。

## 4. Ownership 与安装边界

| Owner | 职责 | 不承担 |
| --- | --- | --- |
| ext-core 的任务基础能力 | task identity、状态、wait/stop 契约、终态保留、纯状态通知；类型化 service key | 注册工具、Pi 消息文案、自动启动进程、模型路由、5 秒产品策略 |
| pi-ext-tools 的 task-control 集成 | 创建并提供当前 session 的 registry，注册 list/wait/stop，管理交付窗口与父会话消息 | 解析 agent 定义、管理 RPC child |
| Bash producer | Bash 进程、日志、timeout、停止与退出确认 | agent 并发队列 |
| pi-subagents | agent 解析、RPC 生命周期、agent admission、软提示、schema 结果校验与当前 Task 映射 | Bash 进程、另一套 task terminal 通知 |

通过 ext-core 现有 Service 提供 registry，由 pi-ext-tools 的 task-control 集成拥有实例和清理。pi-subagents 的统一 task 能力要求此服务存在；单独安装 pi-subagents 时保留既有会话工具，统一 task 入口不激活，并明确显示缺少集成服务的原因。不得创建第二个 registry。该协作为可选集成，不新增笼统的 TaskOrchestrator/TaskProvider 框架。

服务注册顺序不能造成 session_start 死锁；可复用 `waitForService` 的可取消 continuation，但不在串行启动 handler 中阻塞等待另一 extension。provider 退出时，consumer 不得继续向旧 registry 提交；清理须注销 listener、取消 queued 工作，并按 Task 所有权停止活动工作。

现有 Service 只保证注册时取得引用与 provider 清理时移除入口，不会自动通知已取得引用的 consumer。任务服务自身因此需要明确的关闭信号及幂等、可等待的清理契约；consumer 监听它停止 Task 专属 runner。关闭顺序为停止受理、关闭交付、取消排队/启动、确认执行清理、解除订阅并释放记录，不依赖各 extension handler 的注册先后。重复提供 service 必须报出冲突，不偷偷接管旧实例。

统一控制工具在 queued、starting、running、停止未确认、待交付任一状态存在时保持可用；不能再只用 runningCount 在 compaction/tree 边界停用。服务关闭后入口重新检查服务有效性，返回明确不可用错误。

共享能力保持无副作用，不负责模型目录或进程调度。当前 ext-core subagent execution runtime 与 pi-subagents RPC runtime 是两条不同路径，不能将前者的 mode 名称误写成后者已支持的配置开关。

公共契约只覆盖两个实际 producer 需要的登记、状态更新、终态提交、查询、等待、停止和生命周期清理；producer 保留执行控制权。Bash 与 Agent 的结果采用明确的文本/JSON 区分，registry 不负责解析 schema 或从 transcript 提取结果。交付 adapter 通过状态通知接收终态，并持有自己的待交付队列。

## 5. blocking 的精确语义与迁移

`blocking` 控制调用者如何接收结果，不决定任务是否受并发限制，也不意味着同步执行 JavaScript。

| 调用 | 确定行为 |
| --- | --- |
| `bash({ blocking: false })` | 本地立即返回后台 task ID；远程明确不支持 |
| `bash({ blocking: true })` | 等待完成、取消或显式 timeout；不再 60 秒自动转后台 |
| 本地 `bash` 省略 blocking | 保留当前前台优先、无 timeout 时 60 秒自动转后台策略，并在 schema 描述中公开 |
| 远程 `bash` 省略 blocking 或设为 true | 保持前台执行，不自动转后台 |
| `task({ blocking: false })` 或省略 | 后台启动/排队并返回 task ID |
| `task({ blocking: true })` | 同一执行路径与并发上限，直接返回结果；禁止同时再发送后台完成通知 |

省略 Bash blocking 与显式 true 的差别属于公开契约：省略值保留既有自动转后台体验，显式 true 则保证等待。两者不得在参数规范化时提前合并为同一个 true 值。60 秒转换须继续显示转换原因及 task ID。

迁移必须检查 schema、nullable 参数规范化、execute 分支、eval nested bash、提示词、README、相关设计文档和测试；旧会话中已经记录的 tool args 只作历史展示，不重写历史，不自动重放旧调用。旧 async 参数在新调用中明确拒绝。

直接阻塞启动的取消与 `wait_tasks` 的取消区别必须保留：前者取消所拥有的执行；后者仅取消观察，不自动停止后台任务。

## 6. 启动、队列和停止边界

- `begin` 目前同步，RPC spawn 异步。应先建立记录与可取消的启动状态，再异步创建 runner；异步启动失败必须 settle，不能留下永久 running 的假任务。
- `queued` 与 `starting` 需要可见。停止 queued 任务不得启动进程；停止 starting 任务后，迟到的启动成功必须清理新 runner，不能把任务复活。
- agent 并发限制由 pi-subagents 管理，覆盖 blocking/background 两条路径。上限应作用于实际存活资源；不能仅在发出 report 后提前释放进程槽位。
- 使用有界 FIFO 队列；队列满时返回清楚错误。第一版不扩张成跨 Bash/Agent 的统一优先级调度器，也不默认把所有长期会话送入新队列。
- stop 是请求，不能凭请求成功宣布 cancelled。只有执行停止被确认后才进入取消终态；停止失败保留可观察状态与原因。
- 自然完成与取消只允许一次终态提交；已终结则返回 already_terminal。stop 的 API 请求不保证取消赢得竞态：producer 若确认工作先自然结束，保留真实 completed/failed；若确认因取消而结束，才提交 cancelled。已提交终态不可被迟到事件覆盖。
- 重复事件、旧 runner 事件必须按当前执行与 runtime identity 过滤。不得使用 task 字符串 ID 向任意“当前 registry”回写。
- 子任务继承的 Bash 后台能力也受当前执行的生命周期约束。执行最终静止但仍有自己启动的后台工作时，先报告 outstanding work，不提交成功；退出与取消时清理这些工作。仅禁止嵌套 task 工具不足以防止孤儿进程。

## 7. 结果交付与 5 秒窗口

### 7.1 固定窗口，不滑动延长

第一个待交付结果在 t0 到达，固定 t0+5s flush；后续完成加入该窗口，但不重置计时器。连续任务流不会饿死最早结果。按同一父 session 的就绪结果聚合即可，第一版不引入“同 turn 派发组”的持久化抽象。

单任务或全部任务完成也不提前自动 flush。registry 的终态与 wait 观察立即更新，延迟仅影响自动通知。消息中保留每个 task 的 ID、目的、状态和结果，不只发送状态清单。

自动通知使用 `deliverAs: "followUp", triggerTurn: true`：父模型忙时排队，空闲时请求后续运行。5 秒是提交通知到 host 的窗口，不保证忙碌的父模型恰好在第 5 秒消费。此策略不以 steer 中断父模型。

### 7.2 等待与交付不是同一件事

`wait_tasks` Promise 完成不证明 tool_result 已进入父上下文。不能因此设置 delivered 或清空通知计时器；否则 wait 被取消或结果发送失败时会漏报，且误删其他任务通知。

`wait_tasks` 直接返回所等待任务的终态与完整的已受限结果，不依赖 follow-up 入队或消费，不提前 flush 自动通知，也不消费待通知记录。混合等待在所有已知指定任务终结后解除，未知 ID 逐项返回错误；重复 ID 去重。取消等待只解除本次观察，返回已知状态，不影响其他 wait 或后台工作。

自动通知仅自动提交一次；显式 wait 是主动读取，允许与通知包含同一份结果，并以 task ID 标明同一执行。这里有意接受显式读取的重复，避免为消除文本重复引入跨 tool result 与消息队列的事务协议。同步 task 的结果只走原 tool_result，不进入后台队列。

Pi host 0.87.0 的公开 `sendMessage` 返回 void，异步错误由 host 的 send_message 错误路径报告；调用返回不能证明已入上下文。交付记录区分 pending、submitted、observed：submitted 仅表示已调用 API，observed 由匹配 task/batch 标识的 custom message 生命周期事件确认，仍不声称模型已理解结果。先设置 submitted 再调用，避免同步 message 事件先到导致状态倒退。同步异常可以明确记录失败；异步未确认不能猜测成功或自动重发。未确认结果在保留期内可通过 wait 读取，UI 显示未确认状态。

不承诺跨进程崩溃的 exactly-once，也不为此新增持久化 outbox。批量通知只包含本 runtime/session 的结果，并明确结果是委派输出，不是新的用户指令。

### 7.3 容量、保留与 session 切换

- 当前 64 条终态保留策略会在 5 秒内大量完成时淘汰待交付记录；待交付项须被独立保留，不能按已交付终态规则删除。
- 为保证“有界”与“未交付不丢失”同时成立，受理时预留结果槽位和单结果最大字节预算，直到通知被观察到或任务归属结束。交付积压占满预算时拒绝新后台任务并给出原因，不等结果产生后才丢弃；Bash 60 秒自动转换若无法预留槽位则继续前台，并显示转换未发生。队列和容量只设必要常量，不引入通用配额框架。
- 同时限制合并消息总字节与条目数，不能只对每个结果限长；必要时分消息发送，合并父 turn 唤醒。
- 结构化结果不可截断成残缺 JSON；队列、结果与终态保留都须有明确边界，超过边界显式报告。
- 切换 session/reload 要取消旧 timer、waiters、订阅和队列；迟到结果不得注入新 session。父 turn 结束与 session 结束是不同生命周期。
- registry 为 session runtime 状态，不新增 task durable scheduler。恢复 child 会话不自动恢复或重放旧 Task；对外 ID 使用 `<type>-<runtime UUID>-<sequence>`，每次 registry 生命周期生成新的 UUID，控制入口只接受完整 ID。UI 可缩写，但复制/工具参数必须保留完整 ID；历史短 ID 不重定向到新任务。
- `/tree` 不触发 session_shutdown，不能只靠 session ID 防跨分支交付。任务记录启动分支的 entry anchor；若当前分支已不包含该 anchor，暂停自动投递并显示来自其他分支，任务仍可显式查看/停止。返回原分支后才恢复 pending 投递。已经 submitted 的 host 队列消息不能由 extension 撤回，必须保留来源标记，不能承诺撤销已交给 host 的结果。

## 8. JSON Schema 与软控制

`outputSchema` 是 JSON Schema，不是任意结构提示。指定时成功结果必须是通过该 schema 验证的 JSON 值；未指定时可以返回文本。使用仅在 Task child 启用的最终结果提交工具，不从混合 Markdown 中启发式抓取“看起来像 JSON”的片段；普通 contact_parent 进度/求助仍与最终提交分开。

提交先校验并保存候选结果，然后返回 Pi host 原生 `terminate: true`。该提交必须是当前 assistant 消息唯一的 tool call，且其启动的后台工作已结束；否则直接反馈错误，让 child 在当前运行中处理，不能接受提交后无限等待后台工作。这样也避免同批写操作尚在执行却先生成结论。只有匹配当前执行的 `agent_settled`、无 outstanding 后台工作、无晚到输入使结果失效时才提交 completed。普通 agent_end 不能终结 Task。终结与输入封口在同一 child 串行边界完成；已封口的新 steer 返回明确拒绝，不启动下一次任务。

Task 最终静止且没有合法候选结果时返回明确的 invalid_result 失败；未指定 schema 的文本结果也通过同一最终提交入口，不把普通进度文字猜作最终结果。不靠不断唤醒 child 维持修复循环。已有普通 report 通道对于 Task child 只承载进度/求助，最终结果唯一走 Task 通道，避免同时收到 pi-subagent-report 与 task-terminal。

- 启动前验证 schema 是否属于现有 validator 支持的范围；不支持的关键字、外部引用或过大 schema 明确拒绝，不能默默忽略校验。
- JSON Schema 不能自动限制结果长度。另设结果体积边界；超过限制给 child 可见反馈以收敛结果，仍不可提交则返回明确失败，不冒充有效 JSON、不引入 artifact。
- schema 校验失败反馈给 child 修正。未通过校验的原始输出可以留作诊断，但不得以成功结果降级交付。schema 修正本身不新增隐式模型切换或无限外部重试循环。
- 软提示只提醒目标、当前进展和建议收敛，不改变任务终态，不触发 abort，也不改 provider/model。每次 Task 跨过提示阈值最多提示一次，不在每轮持续注入，也不在已有合法最终候选结果后注入以致重新唤醒执行；提示内容与发生时机在 UI/记录中可检查。
- 用户 stop、session 关闭、明确的执行错误仍可终止工作；这些不属于轮次限制。提示阈值在实现时作为有测试的策略常量确定，不照搬上游阈值后的强制终止或添加默认运行时限。

求助不应被静默剥夺：Task 无法继续时返回带原因的失败终态（例如 needs_input），父模型取得结果后决定下一次任务；不让 child 无限等待正阻塞在 wait 的 parent。若以后要支持中途问答，应单独设计可中断等待协议，本版不加入。

## 9. scout 默认定义

- 默认可发现，非默认自动派发；内置定义不写入用户 home。
- 保持当前优先级：项目 `.pi/agents`、项目 `.agents/agents`、用户 `~/.pi/agent/agents`，最后才使用内置 scout；展示实际定义来源。
- 继承父模型与 thinking；不指定隐式低价模型。
- 仅启用已验证的读取/搜索与报告工具。检查 extension 加载和后续工具激活能否绕过 allowlist，尤其不能通过 eval/nested tools 绕回 bash/write。
- 这是工具能力限制，不是操作系统沙箱；读取工具缓存、第三方 extension 副作用与用户自定义覆盖要如实说明。
- 缺少必需读取工具时明确配置失败，不静默退回全工具；发布产物需包含内置定义并有发现测试。

## 10. RPC 生命周期修复前置项

1. `manager.ts #hibernate` 吞掉 shutdown 超时/错误并 close 连接，然后标记 done；而 runner 先 ACK 再关闭，close 不杀进程。存在旧进程仍退出中或仍存活、下一次 send 已尝试唤醒的窗口。先确认退出或记录终止未确认状态，再决定是否清理 runtime；不能单纯删除旧 PID 证据。
2. `send` 在启动前持久化 starting，launch 失败分支返回 failed，但该分支没有把记录更新为 failed。对外错误与后续 list 状态可能不一致；修复需保留“启动未确认”和“确认未启动”的差别，避免盲目重试产生重复执行。
3. `#currentPlacement` 将发现失败降为旧 placement。对于历史标记 never_flushed、实际会话已落盘的 child，不能把无法读取会话等同于不存在会话；恢复必须避免意外创建失去上下文的新会话。
4. 现有测试覆盖正常休眠与正常唤醒，不能据此证明 shutdown 超时、启动失败、恢复落盘失败和新旧事件交错都安全。

这些修复是任务化执行的前置工作。验收须覆盖超时、错误、迟到事件与恢复失败；只有确认旧执行退出或安全恢复后才允许后续唤醒。无法确认时保留 runtime 证据并返回明确错误，不盲目重启。当前尚未修改 manager/runner，也未通过测试复现所有进程竞态。

## 11. 实施顺序与验证门槛

| 阶段 | 工作与完成条件 |
| --- | --- |
| 1. 固定实现常量与验证范围 | 已核对 host 与上游机制；进一步用当前 TypeBox 验证支持的 schema 子集，不引入自制通用 validator。记录结果/队列容量、agent 并发与一次性软提示阈值，更新当前架构文档与 DESIGN.md，区分临时 Task 与可恢复 child session。 |
| 2. 修复 RPC 生命周期 | 修复退出确认、启动失败状态、会话定位失败处理；用失败路径测试证明不会错误宣告休眠、丢失上下文或盲目启动第二个执行。 |
| 3. 打通统一 Task 路径 | 将通用契约与无副作用实现移入 ext-core，pi-ext-tools 提供单一 Service；Bash 与 RPC Agent 共用登记/控制路径。完成 blocking 迁移、有界 admission、启动中取消、一次终态提交及安装边界。 |
| 4. 完成 Agent 结果与角色 | 实现 JSON Schema 提交与校验、结果大小边界、可见软提示和内置 scout；保留父模型继承，不新增硬轮次限制或 artifact。 |
| 5. 完成交付与验收 | 实现固定 5 秒窗口、wait 直接读取、通知提交/观察状态、容量预留与 session/branch 清理；验证混合任务、旧事件隔离及同步结果不产生后台通知。 |

每阶段形成内聚改动并完成对应验证，不夹带与本任务无关的工作。只有上述行为形成完整端到端路径后才宣告任务统一完成；单纯移动 registry 文件不算交付。

聚焦验证按契约分组，避免每个实现细节单独造测试：

| 组 | 必须覆盖的可观察行为 |
| --- | --- |
| 生命周期 | 排队/启动时取消、启动失败、迟到启动清理、shutdown ACK 但尚未退出、旧事件不得复活任务；取消与自然完成竞态保持真实终态；清理顺序互换也不泄漏 |
| 交付 | 单任务仍等待 5s；t0/t0+4s 完成在 t0+5s 提交通知；持续完成不延长窗口；wait 在父运行未结束时也能得到 JSON；并发 wait 不消费结果；通知只自动提交一次；host 异步失败不被标记为 observed |
| 边界 | 超过 64 条未确认结果时入场背压、合并消息总容量、session 切换、provider 卸载、reload 后 ID 不复用、tree 分支 anchor、Bash 自动转换无容量时保留前台 |
| 结果 | schema 不合法、结果不合法/过大、修正成功、软提示后继续工作且不自动 abort；混合最终提交拒绝；agent_end 后重试不得提前完成；Task child 后台工作清理、最终报告通道去重 |
| API/安装 | 显式 blocking true 超过 60s 仍等待、缺省策略、远程拒绝后台、eval 嵌套调用、单独安装 subagents、scout 覆盖与实际工具限制 |

实现阶段检查改动文件的 Biome，运行受影响测试和对应 package build（若提供）。公共契约与跨包 import 变更升级全仓 typecheck；涉及发布产物/包边界验证或影响无法界定时升级完整 check，并说明原因。计划文档修订仅做文档检查，不运行 TypeScript/test，也不把源码阅读当成测试通过。
