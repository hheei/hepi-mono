# 异步任务编排研究与设计建议

## 1. 用户目标

当前 agent 使用 `bash` 的 `async: true` 或启动 subagent 后，容易反复调用状态查询工具，形成：

```text
start async -> bash_job/status -> bash_job/status -> bash_job/status -> ...
```

目标是把异步执行统一成可见、可组合的 task workflow：

1. 异步启动立即返回稳定 task ID，例如 `bash-1`、`agent-1`。
2. 启动结果明确告诉 agent：完成结果会自动进入 parent context；不要轮询状态。
3. 需要等待时，agent 显式调用 `wait_tasks({ ids: ["bash-1"] })`。
4. `list_tasks` 返回所有由当前 runtime 管理的异步任务，而不只返回 Bash。
5. `stop_tasks({ ids: ["bash-1"] })` 统一中止一个或多个异步任务。
6. 任务状态、完成通知、等待和停止都必须受 session 生命周期约束，不能产生 orphan process、旧 session 注入或重复 terminal result。

本文件是研究和设计建议，不改变运行时代码，也不承诺已经存在这些工具。

## 2. 现状研究

### 2.1 Bash async

`packages/pi-ext-tools/src/bash.ts` 中，普通 `bash` 有两条执行路径：

- 未设置 `async` 时调用 `runForeground()`，使用 `createLocalBashOperations().exec()`，通过 `AbortSignal`、timeout 和 `onUpdate` 管理当前 tool call。
- `async: true` 时调用 session-scoped `BashJobRegistry.start()`，启动本地 detached child process，立即返回 job snapshot。

`async` 目前只支持本地目标。指定远程 `target` 时会返回 `async_unsupported`，因为远程执行由 `TargetRuntime.exec()` 管理，没有远程 job registry。

`packages/pi-ext-tools/src/bash-jobs.ts` 当前负责：

- 使用 UUID 作为 job ID；
- 保存 `running`、`completed`、`failed`、`stopped` 状态；
- 合并 stdout/stderr，并通过 `BashOutputSink` 限制保存的尾部输出；
- 使用 timeout 调用 `stop()`；
- Unix 下按 process group 发送 SIGTERM，之后必要时发送 SIGKILL；
- job 结束时通过 `pi.sendMessage()` 发送 `bash-job-complete`，但当前选项是 `triggerTurn: false`。

job registry 在 `packages/pi-ext-tools/src/fff/lifecycle.ts` 的 session lifecycle 中创建，并通过 `context.resources` dispose。它不持久化，也不跨 session/reload 恢复。

### 2.2 当前 bash_job

`packages/pi-ext-tools/src/bash-job-tool.ts` 暴露：

```ts
{ action: "status" | "logs" | "stop", id: string }
```

它只查询 `FffRuntimeState.getBashJobs()`，因此只能看到 Bash async jobs；没有等待 barrier，也没有统一 task namespace。

这正是轮询容易发生的原因：模型拿到一个 UUID 后，没有一个明确的“完成会自动进入 context”以及“需要阻塞时用 wait”契约。

### 2.3 当前 subagent

仓库中存在两套相关但不同的 subagent 机制：

1. `packages/pi-ext-core/src/subagents.ts` 提供 root-session-scoped execution contract，支持 `completion`、`task`、`conversation` 三种 mode。它已有状态、取消、terminal result、bounded event subscription、retention 和 parent-session cleanup。
2. `packages/pi-subagents/src/tools.ts` 提供面向 agent 的 `spawn_subagent`、`send_subagent`、`get_subagent`、`list_subagents`、`stop_subagent`，由 `SubagentManager` 管理 child runtime 和 registry。

当前 model-facing subagent ID 来自具体 manager/runtime，和 core 的 `SubagentId`、Bash UUID 不是同一个 namespace。现有 `spawn_subagent` 还会等待 child runtime ready 后返回，而不是将所有异步任务映射成 `agent-N` 的简单序号。

### 2.4 已有架构边界

`docs/architecture/subagents.md` 和 `docs/development/pi-ext-core.md` 明确规定：

- core 拥有 subagent execution lifecycle、取消、terminal result 和 session retention；
- consumer 拥有 agent/config/prompt/model/tool policy，以及 parent delivery adapter；
- core 不提供 main-agent wait 或 result-polling tool；
- core 不拥有 generic arbitrary worker、durable scheduler、通用 event bus 或 parent context injection；
- task terminal result 必须通过 consumer-owned delivery sink 进入 parent adapter；
- session shutdown/reload 必须 abort active work、清理 queued work、detach subscribers 和释放 child session。

因此，`list_tasks`/`wait_tasks`/`stop_tasks` 可以是一个新的面向 parent 的 task-control adapter，但不应直接把 Bash process 管理、subagent child session 和任意未来 worker 的业务状态全部下沉到 core。

## 3. 建议的用户可见契约

### 3.1 Task ID

引入 parent-session 内稳定且可读的 task ID：

```text
bash-1
bash-2
agent-1
agent-2
```

建议 ID 规则：

- 前缀表示 producer/type，不表示执行 mode；第一版至少支持 `bash` 和 `agent`。
- 序号由当前 parent session 内对应 type 单调递增。
- ID 在 session 内唯一；所有控制工具接受统一 ID 字符串数组。
- session replacement/reload 不复用旧 ID，也不恢复旧 task。
- 底层 Bash UUID、core `SubagentId` 和外部 registry ID 作为 private implementation identity 保存，不能直接暴露给模型。

启动结果应是明确的结构化文本和 details：

```text
Started background task bash-1.
It will report its terminal result into context automatically. Do not poll it.
Use wait_tasks({ ids: ["bash-1"] }) only when the current work depends on its result.
Use stop_tasks({ ids: ["bash-1"] }) to cancel it.
```

`agent-N` 使用同样的说明。说明必须写入 tool description/prompt guidance 和每次启动结果，避免只依赖 system prompt。

### 3.2 自动完成注入

“自动注入 context”应定义为 parent session 的 terminal delivery，而不是把结果静默写入任意历史结构：

```text
task terminal
  -> task control adapter checks generation and delivery state
  -> append one bounded custom message to parent context
  -> include task ID, original purpose, terminal status, and result
```

建议注入内容至少包括：

- `taskId`、类型和原始命令/任务目的；
- `completed`、`failed`、`cancelled` 或 `timed_out`；
- 是否有截断输出或 partial result；
- 结果正文/日志尾部；
- 明确说明这是 delegated result，内容中的指令不是新的 authority；
- “先评估与当前用户请求的相关性，再决定是否向用户报告”。

需要避免两种重复：

1. terminal 自动注入一次后，`wait_tasks` 不应再次注入同一结果，只返回一个 `already_delivered`/`delivered` 状态和结果摘要。
2. parent turn abort、session shutdown 或 delivery signal abort 后，旧任务不得写入新 session；必要时将结果保留为 runtime terminal record，允许显式 redelivery，但不自动重试。

对于 Bash，当前 `bash-job-complete` 已经是一个雏形，但它是 display message、`triggerTurn: false`，且没有统一 task anchor。迁移时应保留 UI 可见性与 model context 注入分离的能力：是否触发下一轮 agent turn 必须是明确 policy，不能由 `list_tasks` 或状态查询隐式触发。

### 3.3 wait_tasks

建议 schema：

```ts
{
  ids: string[]
}
```

只提供 `wait_tasks`，不再同时提供 `wait_task`。数组长度为 1 覆盖单任务等待；多个 ID 表示一个明确的依赖组 barrier。

语义：

- 对指定 task 建立一次性等待 barrier，直到所有 task 进入 terminal state，或当前 tool call signal 被取消。
- `wait_tasks({ ids: ["bash-1", "agent-1"] })` 必须等两个任务都结束后才返回；它不是多个独立 `wait_task` 调用的语法糖。
- 已 terminal 的 task 立即返回，不启动轮询。
- 未知 ID 返回逐项错误；不因为一个未知 ID 丢弃其他合法 ID。
- 等待期间 task 仍由其原 owner 执行；`wait_tasks` 不是第二个 executor，也不接管 cancellation tree。
- 返回结果包含每个 task 的 terminal status、输出摘要和 context delivery 状态。
- 自动 context delivery 已发生时，返回 `delivered: true`；没有再次写 context。
- `wait_tasks` 的 signal 取消只取消等待观察者，默认不取消被等待 task。需要中止 task 必须调用 `stop_tasks`，避免“等待取消”被误解为“任务取消”。

模型提示应明确：只有后续工作依赖结果时才 wait；独立工作不要调用 wait，也不要调用 list 轮询。

多个互相独立的依赖组仍可以由 harness 并行调用多个 `wait_tasks`；一个调用内部的 `ids` 则始终表示同一 barrier。

### 3.4 list_tasks

`list_tasks` 替代 `bash_job` 作为统一观察入口：

```ts
{
  includeTerminal?: boolean
}
```

默认只返回当前仍在运行或等待资源的 task，避免模型反复看到已经完成的任务。可选 `includeTerminal: true` 用于显式诊断。

每一项建议固定为：

```ts
{
  id: "bash-1",
  type: "bash",
  status: "running",
  startedAt: 123,
  purpose: "npm run build",
  cancellable: true,
  resultAvailable: false
}
```

`list_tasks` 是 snapshot，不是等待 API；工具描述必须明确禁止把它当成完成检测循环。

### 3.5 stop_tasks

建议 schema：

```ts
{
  ids: string[]
}
```

只提供 `stop_tasks`，不再同时提供 `stop_task`。数组长度为 1 覆盖单任务停止；多个 ID 是逐项、幂等的停止请求，不是 all-or-nothing 批处理。

语义：

- 对每个 task 发出显式 cancel/stop intent；操作应幂等。
- 已完成任务返回 `already_terminal`，不改变结果。
- 未知 ID 返回逐项 `not_found`。
- 取消是异步 terminal transition；`stop_tasks` 可以在进程尚未退出时返回 `stop_requested`，最终 `cancelled`/`stopped` 由 task completion delivery 报告。
- session shutdown 不等待外部进程优雅结束；owner 负责发送强制终止并清理 timer/listener。
- 取消必须绑定 parent session generation，旧 task 的晚到 `close`/child report 不能影响新 session。

## 4. 推荐 ownership 方案

### 4.1 第一阶段：统一控制面，不统一执行器

建议先新增一个 task-control 层，职责只有：

- 分配 parent-visible task ID；
- 注册 producer adapter；
- 保存 bounded task metadata 和 terminal delivery state；
- 提供 `list`、`wait`、`stop`；
- 做 session generation、一次性 terminalization、自动 delivery 去重。

具体执行仍由 owner 保留：

```text
bash async       -> pi-ext-tools BashJobRegistry
agent task       -> pi-ext-core / pi-subagents adapter
future task      -> its own explicit adapter
```

这样能解决模型交互问题，又不会违反 ext-core 当前“不承载 generic worker scheduler”的边界。

### 4.2 task-control 是否进入 ext-core

这是需要单独批准的架构决策，不能在实现时静默扩张。两个可选方案：

**方案 A：pi-ext-tools 拥有 task-control（推荐第一版）**

- `bash` 和 `pi-subagents` 通过一个明确的 integration registration 接入 pi-ext-tools；
- 实现改动集中，能快速验证 task ID、wait、自动 delivery 的模型体验；
- 缺点是 core 的 subagent consumer 和 pi-ext-tools 会形成具体 extension 协作，需要明确必需/可选依赖、生命周期和 fallback。

**方案 B：ext-core 增加 feature-neutral async task control contract**

- core 只提供 task handle、ID、状态、wait/cancel、terminal delivery sink 和 registry；
- Bash process、child AgentSession、UI、context injection policy 仍由 producer/consumer 拥有；
- 可避免具体 extension 互相依赖，但需要更新 `docs/architecture/pi-ext-core.md`、`docs/architecture/subagents.md` 和 ADR，增加 shared registry 的 retention/backpressure/cost contract。

不建议直接把 `BashJobRegistry` 移入 core，也不建议让 core 读取命令、agent 配置或自动决定 context 注入格式。

### 4.3 Subagent 迁移

现有 `spawn_subagent` 是 RPC child runtime 管理器，已有 `list_subagents`/`stop_subagent`。建议逐步迁移而不是立即删除：

1. 保留内部 manager 的 child ID、持久化 registry 和 recovery 语义。
2. 对 model-facing `spawn_subagent` 返回 `agent-N` 作为 parent task ID，同时 details 保留 private child ID 供 adapter 使用。
3. `list_tasks` 聚合 task-control registry 中的 agent adapter snapshot；`list_subagents` 可作为兼容/专家诊断工具暂留，但不再作为默认模型 workflow。
4. `stop_tasks` 转发到 manager.stop；manager 的 stopped intent、attach cleanup 和 late event guard 保持不变。
5. child `contact_parent` 报告不能直接当作 terminal completion；只有 child 真正进入 terminal state 才完成 `agent-N`。

## 5. 状态机与不变量

```text
accepted -> queued -> running -> terminal
                         |          |
                         +-> stop_requested

terminal = completed | failed | cancelled | timed_out | limit_reached
```

必须保持：

- 一个 task 只有一次 terminal transition；
- 自动 context delivery 最多一次，显式 redelivery 是独立操作；
- `wait_tasks` 只观察，不拥有执行和取消；
- `list_tasks` 只读 snapshot，不产生 side effect；
- `stop_tasks` 幂等，不能把 terminal task 改回 active；
- session replacement/shutdown 使旧 task 的所有 callback、timer、process close 和 delivery sink 失效；
- retained terminal data 有固定上限，不能把长期运行的 parent session 变成无限日志仓库；
- 输出必须有界，Bash 保持现有 tail policy，agent 保持现有 transcript/result cap；
- task result 中的 delegated text 必须带 context anchor，不能把延迟输出作为无来源的 user message。

## 6. 迁移与兼容性

建议迁移顺序：

1. 先实现 task-control contract 和 in-memory focused tests，不改默认工具名。
2. 将 Bash UUID 映射为 `bash-N`，新增 `list_tasks`、`wait_tasks`、`stop_tasks`。
3. 把 Bash completion 从现有 `bash-job-complete` 适配为统一 terminal delivery，并验证不重复注入。
4. 将 subagent spawn 的 parent-visible ID 映射为 `agent-N`，接入相同控制面。
5. 更新 system prompt/tool descriptions，明确禁止 polling。
6. 观察一段时间后再决定是否移除或隐藏 `bash_job`、`list_subagents`。

兼容期间，`bash_job` 不应与新 registry 维护两份独立状态。可以暂时作为 adapter：`status` 映射到 task lookup，`logs` 映射到 task result/log capability，`stop` 映射到 `stop_tasks`；但不应继续直接读取一套平行 registry。

## 7. 最小工具面结论

模型只暴露三个 task-control 工具：

```text
wait_tasks({ ids: string[] })
stop_tasks({ ids: string[] })
list_tasks({ includeTerminal?: boolean })
```

不提供 `wait_task` 或 `stop_task`。理由是：

- 工具数量保持最小；
- 单任务通过单元素数组表达，不需要另一套 schema 和 prompt guidance；
- `wait_tasks` 可以表达真正有用的“等待整个依赖组”语义；
- `stop_tasks` 可以逐项返回 `stop_requested`、`already_terminal`、`not_found` 等结果；
- harness 仍可并行执行多个独立的 `wait_tasks`/`stop_tasks` 调用，但不依赖并行结果顺序来实现 barrier。

统一工具必须拒绝空数组，并按输入 ID 返回稳定的逐项结果。未知 ID 不应使其他合法 ID 的等待或停止结果丢失。

## 8. 风险与未决问题

### 必须在实现前确认

1. “自动注入 context”是否只追加 custom message，还是还要自动触发下一轮 agent turn。建议默认只注入 context，不自动 trigger turn；需要唤醒时由显式 delivery policy 决定。
2. `wait_tasks` 是否在结果已自动注入后仍返回完整 output，还是只返回状态/摘要。建议返回 bounded result，避免 agent 必须再次查询。
3. `list_tasks` 默认是否隐藏 terminal tasks。建议默认隐藏，可通过显式参数查看。
4. `stop_tasks` 是否允许停止非当前 extension 创建的 task。建议允许，但只接受 task-control registry 中声明了 cancellable capability 的 task。
5. Bash remote async 是否进入第一版。现有 TargetRuntime 没有 remote job lifecycle，建议明确排除，继续禁止 `target + async`。
6. `agent-N` 是只给现有 `spawn_subagent`，还是包括 core `task`、Dreamer、historian 等内部任务。建议第一版只暴露用户可启动且需要 parent control 的 agent task；内部 completion 不进入 model-facing task list。

### 主要风险

- 自动 context delivery 与 Pi session branch/reload 的竞态；
- `wait_tasks` 与 task terminal delivery 的重复消息；
- process group kill 不完整导致 Bash 子孙进程泄漏；
- list snapshot 暴露过多命令、路径、child transcript 或敏感输出；
- 把 `list_tasks` 误用成 polling，导致模型仍然高频调用；
- 为了统一 API 把具体执行 policy 错误下沉到 ext-core，形成 generic scheduler 和隐式依赖。

## 9. 研究依据

- `packages/pi-ext-tools/src/bash.ts`：Bash 参数、foreground/async 分流、远程 async 限制、结果与 timeout 语义。
- `packages/pi-ext-tools/src/bash-jobs.ts`：本地 child process、输出尾部、状态、timeout、stop 和 completion message。
- `packages/pi-ext-tools/src/bash-job-tool.ts`：现有 status/logs/stop 工具面。
- `packages/pi-ext-tools/src/fff/lifecycle.ts`：Bash job registry 的 session ownership 和 dispose。
- `packages/pi-ext-tools/src/bash-output.ts`：有界输出和行数统计。
- `packages/pi-ext-core/src/subagents.ts`：core task handle、terminal delivery、cancel、retention、session-scoped coordinator。
- `packages/pi-subagents/src/tools.ts`：现有 spawn/get/list/stop model-facing tools 及“不轮询、完成自动报告”的 prompt contract。
- `packages/pi-subagents/src/manager.ts`：child registry、recovery、stop intent 和 runtime attachment ownership。
- `docs/architecture/subagents.md`：subagent execution、delivery、cleanup、retention 和 core boundary。
- `docs/development/pi-ext-core.md`：core lifecycle、取消、late result guard、Subagent Consumer 与禁止 generic worker scheduler 的约束。
- `docs/architecture/pi-ext-core.md`：core 的 feature-neutral boundary、Service/ExtensionPoint 边界和已批准 subagent exception。


## 10. 实施状态（第一阶段）

已实现第 6 节迁移顺序的第 1–3 步，范围限定在 `pi-ext-tools`：

- `packages/pi-ext-tools/src/tasks/registry.ts`：session-scoped `AsyncTaskRegistry`，负责 id 分配、状态、一次性
  terminal delivery、list/wait/stop 查询；不执行、不调度、不持有 producer 内部状态。终态记录保留最近 64 条。
- `packages/pi-ext-tools/src/tasks/bash-task.ts`：Bash producer 适配层，把 `BashJobRegistry` 的 job 映射为 task
  binding（stop/describe）与终态。
- `packages/pi-ext-tools/src/task-tools.ts`：`list_tasks`、`wait_tasks`、`stop_tasks`，替换已删除的 `bash_job`。
- Bash async 现在返回 `bash-N`，completion 由统一 terminal delivery 通过 `pi-ext-tools:task-terminal`
  custom message 注入 context，`triggerTurn: false`（沿用第 8 节问题 1 的建议与既有文档契约）。

本节确认的决策：

- 问题 1：只注入 context，不自动触发 agent turn。
- 问题 2：`wait_tasks` 返回有界 output（单任务 4,000 字符，delivery 10,000 字符），避免二次查询。
- 问题 3：`list_tasks` 默认隐藏 terminal task，`includeTerminal: true` 可显示。
- 问题 5：remote Bash async 继续排除，`target + async` 仍返回 `async_unsupported`。
- 问题 4/6：未实现。当前 registry 中每个 task 都可取消，没有 producer 声明不可取消能力；`agent-N` 需要
  pi-ext-tools 与 pi-subagents 之间的跨包契约，而现有文档规定其它 extension 不得 import `pi-ext-tools`。
  因此第二阶段若要做 `agent-N`，必须先决定是走 narrow core capability（需要单独批准 core 扩张）还是
  重新评估该依赖规则，不能在本阶段静默扩张。评估结论见第 11 节。

## 11. 第二阶段评估：`agent-N` 是否需要扩张 core API

本节回答第 10 节留下的问题，结论是**当前不需要新增 core 运行时能力**；阻碍来自产品语义，而不是缺少机制。

### 11.1 仓库已规定的升级路径

1. `docs/ext-tools/README.md`：其它 extension 不得 import `pi-ext-tools`；跨包协作若确有需求，另行定义
   narrow core capability。
2. `docs/architecture/pi-ext-core.md`：Service 是 1:1，ExtensionPoint 是 1:N（一个 owner + 多个 hook）；
   独立 package **各自用同一 namespaced ID 声明自己的 generic key**，双方不互相 import，类型与语义兼容
   由约定负责。
3. `docs/development/pi-ext-core.md`（简洁与提升门槛）：向 core 提升新 primitive 必须同时满足"明确跨
   extension 价值且 feature-neutral"、"说明现有 API 为何不足以及生命周期、ownership、并发与成本"、
   "实现前达成用户共识并更新架构提案"。

因此跨包机制本身不需要新 core 代码：pi-ext-tools 作为 owner 打开一个 ExtensionPoint，producer 注册
hook，双方各自声明同一 ID 的同构类型。值得进 core 的只有"共享类型 + key 常量"，它避免两侧接口悄然
漂移，属于类型便利，不是能力缺口。

### 11.2 决定性阻碍：现有 producer 的数据模型不匹配

- Bash async 是 finite task：进程结束即终态，天然只有一个 terminal transition。
- `pi-subagents` child 是 durable worker。`packages/pi-subagents/src/state.ts` 的状态投影为
  `agent_end`/`agent_settled` → `idle`、`error` → `failed`、`runner_exit` code 0 → `done`：子 agent
  **正常干完一轮活的终态是 `idle`（等待下一条输入）**，只有被 stop 或 runner 退出才 terminal。

强行按 finite task 接入会产生两个假语义：

- `wait_tasks(["agent-1"])` 在常见路径上永不返回（child 一直 idle），除非显式 stop；
- `list_tasks` 会把等待输入的 durable worker 报成 running task，`includeTerminal` 也无从判断它何时完成。

这不是 API 形状能修复的问题。

### 11.3 三个产品选项（先定语义，再定 API）

| 选项 | 语义 | 代价 |
| --- | --- | --- |
| (a) 不纳入（推荐） | agent 保持独立：`pi-subagent-report` + `triggerTurn: true` 自动汇报、`list_subagents`/`stop_subagent` 与禁止 polling 的 guidance 全部保留 | 模型需要记住两个 namespace；但两条路径都已经满足"完成自动到达、不要轮询" |
| (b) 把"spawn 的一轮工作"定义成 finite task | child 首次 `idle`（或首次 `contact_parent`）即该任务终态，后续 `send_subagent` 开启新任务 | 需要先改写 `docs/architecture/pi-subagents.md` 与 spec 的"任务 vs 会话"语义，并让 delivery 从"每条 report 触发 turn"变成"终态投递"；这是产品变更，不是 API 变更 |
| (c) 只统一 list/stop，不提供 wait | agent 行进入统一列表并接受 `stop_tasks`，`wait_tasks` 拒绝 non-finite producer | 收益有限，并留下第三种语义 |

### 11.4 若批准 (b)：最小 API 形状

机制仍只用现有 ExtensionPoint，不新增 core 运行时状态：

- ID：`@hheei/pi-ext-tools/task-source`，owner 是 pi-ext-tools（它定义语义与消费方式）。
- hook：`{ family, list(), subscribe?(listener), stop?(id) }`；snapshot：`id`、`family`、`purpose`、
  `status`、`startedAt`、`endedAt?`、`output?`、`truncated?`。
- 规则：
  - producer 拥有 id：model-visible id 在 parent session 内稳定，映射存在 producer 自己的持久化记录中
    （pi-subagents 的 registry 已持久化，可存 `displayId`）。
  - producer 拥有 delivery：registry **绝不为 foreign family 注入 terminal message**，避免与
    `pi-subagent-report` 双投递；`wait_tasks` 只读取 mirror。
  - `stop` 只在 hook 声明时转发；hook dispose/abort 后 mirror 记录转为 detached（不再接受状态更新，
    也不再可 stop），不删除已有快照。
  - mirror 记录同样受 64 条终态上限约束；`output` 先由 producer 截断，registry 只再截一次。
- `pi-ext-tools` 内部：`AsyncTaskRegistry` 需要一条与 `begin()` 并列的 producer-agnostic 入口（当前
  `create()` 自己分配 id），让 Bash producer 与 foreign producer 落到同一 record 形状。把 mirror 放在
  registry 之外会违反"registry 是唯一状态源"，因此不采用。

估算：core 0 行；`pi-ext-tools` 约 150 行加 focused tests；`pi-subagents` 约 60 行加 focused tests。

### 11.5 何时才值得提升到 core

出现**第二个 producer**（例如 pi-ext-memory 或 pi-optimizer 出现需要 parent 控制的有限后台任务）时，才值得
把 interface + key 常量提升为 `packages/pi-ext-core/src/task-source.ts`（无状态、无 registry、无投递策略），
并同步更新 `docs/architecture/pi-ext-core.md` 的例外清单与新增 ADR。只有一个 producer 时提升，等于为一次性
需求扩张 core。

### 11.6 建议

1. 现在不动 core，`agent-N` 推迟。
2. 若要统一控制面，先完成 (b) 的产品语义变更文档，再实现 11.4。
3. 不把 (c) 当作过渡方案：它会留下一个永远无法完成的 `wait_tasks` 语义。
