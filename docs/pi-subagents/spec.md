# pi-subagents V1 规格

本规格从 [`PLAN.md`](PLAN.md) 提炼 V1 目标合同。`PLAN.md` 保留设计依据与 Pi API 核对记录；实施状态与未完成范围以 [`tickets.md`](tickets.md) 为准，当前已落地行为以 package README、源码和测试为准。

## 1. 用户目标

提供一个独立安装的 `@hheei/pi-subagents` concrete extension，使主 Pi 能够：

- 创建多个拥有独立 Pi session 的 child；
- 在后台 RPC 模式中查看、发送消息和停止 child；
- 接收 child 主动发给 parent 的进度、发现、决策请求和阻塞信息；
- 将同一个 child 安全切换到 Herdr 或 cmux 中的原生 Pi TUI；
- TUI 退出后让同一个 logical child 回到 RPC 等待输入；
- parent reload/restart 后重连仍存活的 child，并恢复确认已死亡的 runtime。

V1 不是 workflow engine、scheduler、任务 DAG 或自制 multi-agent UI。

## 2. 核心身份与所有权

### 2.1 身份

```text
logical child = subagent ID + parent session ID + Pi child session
runtime       = runner + RPC/TUI writer + IPC connection
presentation  = optional Herdr/cmux attachment
```

Pi child session 保存对话。PID、socket、RPC connection、pane ID 和 surface ID 都是可替换的 runtime attachment，不是 child identity。

### 2.2 所有权

| 所有者 | 负责 | 不负责 |
| --- | --- | --- |
| Pi host | session JSONL、原生 RPC、原生 TUI、model registry | child ownership、handoff、跨 parent 恢复 |
| `pi-subagents` parent branch | agent/config resolution、manager、tools、registry、transition、delivery policy、HostAdapter | 重画 Pi TUI、通用 scheduler |
| 独立 runner | 持有 child stdio、可重连 IPC、单控制连接、RPC/TUI writer 生命周期 | 全局调度、agent policy 解析 |
| `pi-subagents` child branch | `contact_parent`、pause/`turn_end` gate、child identity validation | manager、spawn tool、递归 child |
| ext-core | parent lifecycle、JSON 原子更新、ToolTui、可选 surface/widget primitives | durable child supervisor、跨进程 IPC、handoff policy |
| Herdr/cmux | terminal/pane 承载和进程观察 | child identity、语义消息、session persistence |

本 extension 不使用 ext-core `startSubagent` 承载 child：该 contract 在 parent shutdown 时取消 child，无法满足本规格的独立存活与重连要求。

## 3. 目标数据流

### 3.1 后台执行

```text
spawn_subagent
  -> resolve agent + effective launch config
  -> persist child/session intent
  -> claim + start independent runner
  -> runner starts Pi --mode rpc
  -> initial task
  -> parent tools <-> runner IPC <-> Pi RPC / child branch
```

多个 `spawn_subagent` tool call 可由 Pi 并行执行；不增加 batch spawn API 或 extension-owned scheduler。

### 3.2 Attach / detach

```text
RPC writer
  -> freeze new input
  -> idle: close_writer
  -> running: pause, wait for current Pi turn (one LLM + its tools),
     hold finishTurn/turn_end until close_writer or timeout
  -> confirm old writer exited
  -> HostAdapter starts native Pi TUI on same session
  -> user exits or leaves managed session
  -> confirm old TUI writer released
  -> same runner restores RPC on same session, waiting for input
```

整个受管理流程中，同一个 child session 最多一个 writer。用户直接用 Pi 原生 `/resume` 或外部进程打开同一 session 不在该保证范围内，也不得被 extension 拦截。

### 3.3 Recovery

```text
load parent-scoped registry
  -> verify ownership + runtime identity
  -> reconnect live runner first
  -> only if runner and writer are confirmed dead: atomically claim replacement
  -> reopen same Pi session in RPC mode
  -> wait for new input
```

重新打开 session 不等于继续任务。中断的 turn、initial task 或未确认消息不得静默重放。

## 4. 最小公共合同

### 4.1 Model-facing tools

会话模式注册五个 semantic tools，另有一个统一的 `task` 入口：

```ts
spawn_subagent({ task: string, agent: string, cwd?: string })
send_subagent({ id: string, message: string, mode?: "steer" | "follow_up" | "auto" })
get_subagent({ id: string })
list_subagents({})
stop_subagent({ id: string })

task({ agent: string, task: string, cwd?: string, blocking?: boolean, outputSchema?: object })
```

`task` 是共享后台任务契约的 producer（见
[`docs/architecture/background-tasks.md`](../architecture/background-tasks.md)）：受理、状态、等待、
停止与通知都由该契约决定，不新增第二套 subagent 通道。`blocking: true` 在本次调用内返回结果且不再
发送后台通知；缺省或 `false` 立即返回 task id，结果稍后回到父上下文。该入口要求
`@hheei/pi-ext-tools` 提供的共享 registry；缺失时它不激活并明确说明原因，不会静默改走
`spawn_subagent`。

规则：

- 不提供 `spawn_subagents`；并行由 Pi parallel tool calls 提供。
- `spawn_subagent` 与 `task` 都必须给出明确 agent name；内置 `scout` 只是一个可选定义，不是默认
  agent，缺名或解析失败在启动前失败。
- `spawn_subagent` 不暴露 model、thinking、tools、extensions、skills 或 budget 参数。
- `spawn_subagent` / `send_subagent` 返回后，模型不得用 `get_subagent` / `list_subagents` 轮询等待 child 完成。Child 通过 `contact_parent` 报告；parent 以 `customType: "pi-subagent-report"` 投递并 `triggerTurn` 进入下一 turn。
  - 投递以 `customType: "pi-subagent-report"`、`triggerTurn: true` 和 `deliverAs: "followUp"` 完成：parent 正在运行时报告附在当前 run 之后，空闲时立即开启新 turn，因此报告属于 parent 的下一次活动；`deliverAs: "nextTurn"` 会把它扣到用户下一次发言，不符合本契约。
  - parent 空闲时第一条报告开启固定的 30 秒合并窗口（`REPORT_MERGE_WINDOW_MS`）：窗口内多个 child 的报告合并为一条消息、只开启一次 turn，后续报告不延长窗口；parent 自己开始活动时，暂存的报告随该活动一并附上（`triggerTurn: false`），而不是事后再叫醒一次。session 结束时暂存报告只追加不叫醒。
- `get_subagent` / `list_subagents` 只用于需要当前身份或状态时，不是完成通道。
- `send_subagent` 只接受目标 child 和语义输入；backend 根据明确 mode 或 child 状态选择 Pi RPC 输入。
- `get/list` 返回可确认的状态、mode、latest summary、interruption、usage、runtime observability，以及冻结的 model/thinking 及其来源（agent 或 parent）；last-known 值不得伪装成实时值。
- `stop_subagent` 是唯一 model-facing 终止操作，先持久化 stopped 意图，再结束 runtime。
- `task` 每次创建专属 child：不 attach、不接收 follow-up、完成后不唤醒，结果与静止确认后终止
  runner；进程槽位在确认退出后释放。这些限制在所有入口（tool、command、host attach、恢复）都能
  观察到，而不是只写在文档里。

### 4.2 Child-facing tool

child branch 只注册：

```ts
contact_parent({
  reason: "progress_update" | "important_finding" | "need_decision" | "blocked";
  message: string;
})
```

每条 report 携带 child identity、parent identity、原始任务锚点和当前状态。parent 把内容视为 delegated result，不视为新的用户授权。parent 离线时 runner 只保留有界的待确认报告；队列满时可见失败，不阻塞 child。`contact_parent` 在 autonomous 与 interactive 两种 child 上都唤醒 parent。Child 正常 `agent_end` 且本 turn 未调用 `contact_parent`、用户未接管时，child branch 可发送 follow-up nudge，提醒调用 `contact_parent`；nudge 不得退出 session。

### 4.3 Agent definitions

按下列顺序发现 Markdown agent definitions，较具体 scope 优先，重名行为必须确定且可测试：

```text
<cwd>/.pi/agents/*.md
<cwd>/.agents/agents/*.md
~/.pi/agent/agents/*.md
<builtin>              # 随包发布的定义，不写入用户 home
```

使用 Pi `parseFrontmatter` 解析 YAML，再对 `unknown` 做本 extension schema 校验。V1 支持已验证且能兑现的字段：

- catalog：`name`、`display_name`、`description`、`hidden`；
- runtime：`model`、`thinking`、`tools`、`exclude_tools`、`extensions`、`skills`；
- policy：`interactive`（boolean，缺省 `false`；`true` 表示用户会在原生 TUI 操作该 child。除 `contact_parent` 外本包不得 `triggerTurn` 叫醒 parent。创建时冻进 launch config，RPC/TUI/restart 复用）；
- Markdown body：固定 prompt assembly 的 agent instructions。

内置层目前只有只读 `scout`：可被发现但不会被自动派发，继承父模型与 thinking，只列出读取/搜索
与报告工具。工具名允许被 extension 扩展，因此内置定义必须显式列出 `tools`——空的 `tools` 在下游
意味着“全部工具”，这与其只读承诺相反，属于配置失败而不是静默放宽。这是工具能力限制，不是操作
系统沙箱。

未知字段、未知模型、无效 thinking、冲突的 tool policy、非 boolean 的 `interactive` 或被禁用的 `contact_parent` 在启动前报错。`exclude_extensions`、`preload_skills`、`max_turns` 和 `max_tokens` 在拥有明确执行语义前不属于 V1 合同。

### 4.4 Effective launch configuration

agent definition 与 parent 显式默认值只解析一次，形成可观察、非 secret 的 immutable launch spec：

```text
Pi invocation + argv + cwd
session ID/path
agent identity + prompt assembly
provider/model + thinking
final tool/extension/skill selection
interactive policy
child bridge environment
```

RPC、TUI attach 和 replacement RPC 共用同一 builder；只有 mode、stdio 和 presentation attachment 不同。默认 model/thinking 的继承必须显示在结果和状态中，不得静默替换 provider/model。API key 等 secret 不写 registry。

## 5. 持久化合同

### 5.1 Parent-scoped registry

V1 使用独立 JSON registry，按 `parentSessionId` 隔离，并通过 ext-core `readJsonSettingsRoot` / `updateJsonSettingsRoot` 更新。它不写入 `settings.json`，不增加数据库、event ledger 或 handoff history。

每个 child 至少保存：

- `subagentId`、`parentSessionId`、`sessionId`、可选 `sessionPath`；
- `cwd`、agent、初始任务、active/stopped 意图；
- 非 secret effective launch config；
- `state`、`mode` 及 last-known summary/usage；
- reconnect 所需的 `runtimeIdentity`、endpoint 和可选 PID；
- 首次落盘状态与未确认输入；
- replacement claim（存在时）。

所有跨进程读取先做 runtime validation。损坏、版本不支持或身份不匹配时明确失败，不返回部分伪状态。

### 5.2 首次 session 落盘

- 启动 runner 前先保存原始 session ID、目标路径和 initial task。
- session 从未落盘且旧 writer 已确认死亡时，用原 session ID 显式创建，不对不存在路径调用会生成随机 ID 的 open 路径。
- session 已落盘时核对文件和 session ID；丢失、损坏或 ID 不符不得当作首次创建。
- session 文件尚未创建时拒绝 attach。
- RPC response 不等于 durability acknowledgement；断线时的输入标记 interrupted/待确认，不自动重发。

### 5.3 Replacement claim

创建替代 runner 前，在 registry 跨进程锁内原子写入唯一 claim。claim 预先包含 `claimId`、持有者身份、`runtimeIdentity` 和 endpoint。

只有 claim holder 能启动 runner。runner 在启动 writer 前再次确认 claim 有效且 child 未 stopped，并自行登记 runtime。claim holder 崩溃后，只有同时确认 holder、runner 和 writer 均已死亡才能替换 claim；endpoint 无响应本身不是死亡证明。

## 6. Runtime 与协议合同

### 6.1 Runner IPC

Runner 是独立进程，自己持有 Pi child stdin/stdout。使用本地 Unix socket/等价 local IPC 和长度受限 JSON-line frames：

- 单一有效 controller；replacement 会撤销旧连接权限；
- handshake 验证 protocol version、parentSessionId、subagentId、runtimeIdentity；
- request/response 由 request ID 关联，events 与 responses 分流；
- parent 侧不转发 token/`message_update`/`tool_execution_update` 等 partial；只保留 `turn_*`、`agent_*`、`contact_parent` 与 lifecycle；busy/idle 以 `get_state` 为准；
- frame、pending requests、report queue 均有固定上限；
- timeout、disconnect、abort 和 malformed input 会结束相关请求，不留下 pending promise；
- Pi stdout 只承载 RPC JSONL，诊断写 stderr。

ParentChannel 复用这条 IPC，不建立第二套 message bus，也不依赖 terminal scraping 或 session JSONL polling。

### 6.2 State 与 mode

公开 state：

```ts
type SubagentState = "starting" | "running" | "idle" | "done" | "stopped" | "failed";
type ExecutionMode = "rpc" | "tui";
```

Handoff/recovery 的细节属于内部 transition，不扩展 public enum。interrupted 是 status/summary diagnostic，不是额外 state。

### 6.3 Transition serialization

同一 child 的 spawn/send/attach/detach/stop/recover/reconnect 由 SubagentManager 的 per-child rejection-safe chain 串行化。成功或失败都释放 queue。stop/cancel 信号可打断正在等待的 pause gate，不能排在该 gate 后造成死锁。所有 late callback 必须按当前 runtime/attachment identity 核对后才能修改状态。

## 7. 生命周期合同

### 7.1 Spawn

1. 校验输入、agent definition、model 和最终 resources。
2. 创建 child ID/session ID，先持久化启动意图和 initial task。
3. 原子取得 runner claim，启动独立 runner。
4. runner 创建持久 session 并启动 Pi RPC；child branch 完成身份 handshake。
5. 只有收到真实 ready/ack 后报告 accepted/running；失败返回已完成副作用和可确认状态。

### 7.2 Send

- running child：明确 `steer` 或遵循 `auto` policy；不得靠屏幕状态猜测。
- idle child：follow-up/prompt。
- TUI child 或正在 attach 冻结的 child：拒绝 send。
- stopped、done 或 ownership 不明时拒绝。
- 已接受但未确认持久化的输入被记录为待确认，断线后不静默重放。

### 7.3 Attach

Attach 把同一 child session 交给 native Pi TUI。需要 Pi `>=0.87.0`（`TurnEndEvent` 边界与 `finishTurn` 调度）。idle 路径已落地；running 路径见 [`tickets.md`](tickets.md) SUB-08。

一次 Pi turn = 一次 LLM 回复 + 该轮全部 tool。安全点是 `turn_end`/`finishTurn`：本 turn 工具已落盘、下一次 provider 请求尚未发出。不在单个 in-flight tool 中途切；不等 `agent_end` / `agent_settled`；不用 RPC `abort`（它会等到 session idle）。

- 开始时冻结新输入。
- session 未落盘时拒绝 attach 并保留 RPC。
- idle（`get_state`：非 streaming/compacting，pendingMessageCount=0）：直接 close_writer。
- running：versioned pause；child 在 Pi 0.87.0 的 `turn_end` 里 await（该钩子挂在 `finishTurn` 上）。`continue: false` 不能禁止下一轮；必须卡住钩子。pause 期间 `cache_warming_decision` 返回 `{ action: "stop" }`。acked 后可选 `clear_queue`，再 close_writer。
- 扩展不得 `return { continue: true }` 来强制下一请求。
- 有限 deadline；超时/cancel 发生在旧 RPC 退出前：放钩子、解冻、保留 RPC、可见失败。不 abort 正在跑的 tool。
- stop/cancel 可打断 pause gate，不能排在 gate 后死锁。
- 确认 writer 退出后，用同一 LaunchSpec（mode=tui）经 HostAdapter 启动 native Pi TUI。
- close_writer 之前的失败保留 RPC；writer 已退出但 TUI 未确认启动时恢复 RPC 等待输入，attach 仍返回错误且不重放 pending input。
- TUI 实际已启动但 host 超时：不启动第二个 writer。
- writer 状态不明时不启动第二个 writer。

### 7.4 Detach 与 session switch

确认 TUI process 已退出且 child 未 stopped时，同一 runner恢复 RPC并等待输入；正常退出、pane close和crash使用同一产品语义，crash额外报告异常。

TUI 内 `/new`、`/resume` 或 `/fork` 成功进入不同 session B 且 A writer 已释放后：

- 撤销 A 对该 TUI 的 bridge identity、PID、pane 和 callbacks；
- A 回到 RPC 等待输入；
- B 留在原生 TUI，不自动成为 subagent；
- stop/send/exit A 不得影响 B。

`/resume` 当前同一 session 与 `/reload` 不算 detach。切换请求、`session_shutdown` 或 pane event 单独都不是 writer 已释放的充分证明。

### 7.5 Stop

先在 registry 保存 stopped 意图，再设置 closing/abort、释放 pause gate并终止 writer/runner。exit callback看到 stopped后不得触发 detach或restart。Stop幂等；stopped child 永不自动恢复。

### 7.6 Parent reload/restart

Parent lifecycle cleanup只释放本地IPC连接、订阅和UI，不终止仍活的 runner/child。新 parent branch按同一parent session加载registry，先验证并重连；只有确认旧runner和writer死亡后才能claim replacement。parent fork/new session不继承旧parent的控制权。

## 8. Host 与 UI 合同

HostAdapter只负责capability probe、创建原生Pi pane、返回可观察attachment和确认退出。默认顺序为用户明确选择，否则按可用性选择Herdr后cmux；选择和fallback原因必须可见，不能静默改变执行provider。

V1 UI保持最小：

- tools完整显示结果并可引用collapsed output；
- `ctx.ui.select`提供child/agent选择；
- `setStatus`显示紧凑状态；
- attach/stop快捷键只调用同一SubagentManager语义操作；
- TUI parent 用 ext-core above-editor widget 投影 `SubagentManager.list()` 中的活 child（`starting | running | idle`；`done | stopped | failed` 为终态，一律隐藏，与 mode 无关）。无边框、不持有第二份 running set、不轮询文件；elapsed 按 spawn 时间计、有可见 child 时每秒刷新；零可见 child 时隐藏。Headless/RPC parent 不挂 widget。
- TUI child 显示一行无边框身份（agent 名、`contact_parent` 通道、当前 tool 数），不替代 parent widget，不成为控制面。

Native child交互始终使用真实Pi TUI；不实现transcript viewer、RPC event mirror或terminal scraping。

## 9. Usage、summary与结果

Usage从Pi已完成assistant turns/session stats重建并按child累计：input、output、cache read/write、cost和turns。重连不得重复累计，缺失provider数字明确按不可用处理而非猜测。

Latest summary取当前branch最后有效assistant内容，并区分：正常完成、仍在运行、interrupted、failed和stopped。TUI/RPC使用同一口径。完整结果不得因UI折叠丢失。

## 10. 失败、取消与并发语义

所有工具、transition和后台恢复遵循同一合同：

- 已知失败、未知异常、protocol mismatch及无法确认的ownership/liveness通过Pi原生tool error或等价可见通知返回；
- 错误包含child、操作、原因、已完成副作用、当前可确认状态和安全重试条件；
- handshake、ready、exit、reconnect、claim和cleanup均有有限deadline并响应AbortSignal；
- deadline后释放本地等待和transition queue；后台迟到结果仍做identity校验；
- fail closed表示拒绝当前危险操作并返回，不表示无限等待；
- model可查询状态或选择其他完成方法，但不得绕过单writer、ownership或消息去重；
- 用户主动中断正在执行的child时，通知parent“任务未完成，等待用户意图”；没有明确继续指令不得自动恢复；
- 不同children可并行，同一child的mutation串行；不引入global scheduler。

## 11. 明确不做

V1不包含：

- nested/recursive subagents、batch spawn或workflow API；
- scheduler、mission、council、review loop或task DAG；
- 自动worktree管理、cost-based interruption或通用budget engine；
- custom transcript/TUI/renderer、terminal scraping或token streaming relay；
- activity sidecar、session JSONL 轮询或基于缺文件的 stall ping；
- 自动重新打开TUI、自动重放中断任务或未确认消息；
- 阻止用户直接原生`/resume`同一session；
- durable event ledger、process history、handoff history或通用cross-extension message bus；
- 未定义语义的agent字段和兼容旧HEPI/subagent实现的shim。

## 12. 完成定义

V1完成必须满足：

1. 多个child可并行后台运行，parent可spawn、inspect、send、接收report和stop。
2. child对话由真实Pi session持久化，首次落盘、损坏、丢失和断线路径不会生成错误的新身份或静默重放。
3. parent reload/restart优先重连存活runner；replacement claim保证受管理路径不会产生第二个writer。
4. Herdr/cmux attach打开同一session的原生Pi TUI；detach、pane close、crash和session switch符合本规格。
5. 失败、取消、stop与handoff race均在有限deadline内可见结束，不死锁transition queue。
6. effective model/provider/resources和host选择可观察，无静默routing。
7. focused tests覆盖[`tickets.md`](tickets.md)各ticket的验收；受影响文件通过Biome、typecheck及对应Vitest。
8. package README、architecture/ADR、`SPEC.md`和实际public contract一致，不包含过时兼容路径。

## 13. 实施顺序

```text
SUB-01 package + contracts + agent resolver
  -> SUB-02 registry + launch/session bootstrap
  -> SUB-03 reconnectable runner + RPC adapter
  -> SUB-04 parent/child channel + core tools
  -> SUB-05 stop/status/usage hardening
  -> SUB-06 recovery + replacement claims
  -> SUB-07 HostAdapters
  -> SUB-08 safe attach
  -> SUB-09 detach/session-switch/interruption
  -> SUB-10 minimal UX + end-to-end release gate
```

SUB-01至SUB-05形成第一个可运行的RPC闭环。SUB-06完成持久恢复后，才开始TUI handoff；不得提前制作dashboard。
