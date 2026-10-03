# pi-subagents V1 规格

本规格从 [`PLAN.md`](PLAN.md) 提炼 V1 目标合同。`PLAN.md` 保留设计依据与 Pi API 核对记录；实施状态与未完成范围以 [`tickets.md`](tickets.md) 为准，当前已落地行为以 package README、源码和测试为准。

## 1. 用户目标

提供一个独立安装的 `@hheei/pi-subagents` concrete extension，使主 Pi 能够：

- 创建多个拥有独立 Pi session 的 child，默认在 Herdr 或 cmux 的 panel 里运行它们的原生 Pi TUI；
- 查看、发送消息和停止 child（没有 host 时 child 运行在无终端的 headless RPC 模式）；
- 接收 child 主动发给 parent 的进度、发现、决策请求和阻塞信息；
- child 的 panel 被关闭或 idle 回收后保留同一 session 与身份，后续 send 用同一 session 拉起新 runtime，不重放中断的 turn；
- parent reload/restart 后重连仍存活的 child，并清理确认已结束的 runtime。

V1 不是 workflow engine、scheduler、任务 DAG 或自制 multi-agent UI。

## 2. 核心身份与所有权

### 2.1 身份

```text
logical child = subagent ID + parent session ID + Pi child session
runtime       = child Pi process + bridge connection（+ 可选 host panel attachment）
presentation  = 由 spawn 决定：host panel 里的 native Pi TUI，或无终端的后台进程
```

Pi child session 保存对话。PID、socket、bridge connection、pane ID 和 surface ID 都是可替换的 runtime attachment，不是 child identity。
liveness 的唯一依据是 bridge 连接（由 parent 进程监听、child 主动拨入），不靠 PID 探测、不靠 session JSONL 轮询。

### 2.2 所有权

| 所有者 | 负责 | 不负责 |
| --- | --- | --- |
| Pi host | session JSONL、原生 RPC、原生 TUI、model registry | child ownership、handoff、跨 parent 恢复 |
| `pi-subagents` parent branch | agent/config resolution、manager、tools、registry、transition、delivery policy、HostAdapter | 重画 Pi TUI、通用 scheduler |
| `pi-subagents` parent branch 的 BridgeServer | 唯一 socket、registry、单 runtime 规则、panel 生命周期、host 选择 | 解析终端画面、镜像 transcript |
| `pi-subagents` child branch | 执行 parent 请求、转发 Pi 事件、上报 `contact_parent`/lifecycle/task result、断线重连与有界缓冲 | manager、spawn tool、递归 child、关自己的 panel、旁路文件、扫 session |
| 后台 child 进程 | 无终端运行；stdin 由 parent 持有，parent 进程结束它即结束 | 自行重连另一 parent session |
| ext-core | parent lifecycle、JSON 原子更新、ToolTui、可选 surface/widget primitives | durable child supervisor、跨进程 IPC、handoff policy |
| Herdr/cmux | panel 的 open/observe（含聚焦）与 cleanup | child identity、语义消息、session persistence、拼第二份 Pi argv |

本 extension 不使用 ext-core `startSubagent` 承载 child：child 的身份与生命周期由本规格定义（见 §5、§7）。

**已删除的所有权**：独立 runner 进程及其 endpoint/claim/handshake 体系、pause gate、attach/detach 状态、`writer_exit` 语义、`controller`/`reporter`/`recovery` 角色划分。

## 3. 目标数据流

### 3.1 后台执行（presentation=background）

```text
spawn_agent / Task tool（无 host 时）
  -> resolve agent + effective launch config
  -> persist child/session intent（state=starting，presentation=background）
  -> parent spawn 一个 headless child Pi（--mode rpc，stdin 由 parent 持有）
  -> child bridge 拨入 parent 的 socket（认证 runtime token）
  -> bridge 就绪后投递 initial task（bridge request: prompt）
  -> state=running
  -> parent tools <-> bridge <-> child branch
```

多个 `spawn_subagent` tool call 可由 Pi 并行执行；不增加 batch spawn API 或 extension-owned scheduler。

### 3.2 Panel 呈现与 bridge 控制面

```text
spawn_agent
  -> presentation 在 spawn 时决定（panel：host tab/surface + LaunchSpec argv；后台：parent 直接 spawn）
  -> child 进程内 bridge 连接 parent socket
  -> parent 只经 bridge 驱动 child（prompt/steer/follow_up/get_state/get_entries/abort/shutdown）
  -> child 经同一连接回传 Pi 事件、child_lifecycle、child_input 与 report（contact_parent/task_result）
  -> stop_agent：先写 stopped 意图，再关闭 panel / 结束进程
```

不再有 attach/detach：没有 writer 交接、没有输入冻结、没有 pause handshake、没有 `close_writer`/`start_rpc`。
同一个 child session 在整个受管理流程中最多一个受管理 runtime（§6.4）。用户直接用 Pi 原生 `/resume` 或外部进程打开同一 session 不在该保证范围内，也不得被 extension 拦截。

呈现方式在 spawn 时冻结并记录在 registry 的 `presentation` 字段；`spawn_agent` 不暴露该参数，默认在有 host 时用 panel、没有 host 时用后台，并且**在 spawn 结果里明说**用了哪一种以及 fallback 原因（不静默改变执行环境）。Task tool 同样采用这个 host 优先策略；Task 仍由 parent 收口并在提交最终结果后结束，panel 只是 child runtime 的可见呈现，不改变一次性 Task 合同。

panel child 的进程由 host 持有，parent 只持有 attachment：

- spawn 时 parent 仍然铸造 runtime identity、bridge token 并构造唯一的 LaunchSpec（`presentation=panel` 时不含 `--mode rpc`、stdio=inherit），再交给 HostAdapter 打开 panel 并运行该 argv；
- 进程退出观测：bridge 连接（唯一权威）+ `pane process-info`；关闭 panel 只证明 attachment 消失；
- child 的 runtime 消失（bridge 断开）时 parent 释放该 panel，child 保持身份与 session，后续 `send_agent` 用同一 session 开一个新 panel（不重放中断的 turn）。

### 3.3 Recovery

```text
parent 启动
  -> 重新监听同一 socket 路径（<runtimeDir>/parent-<parentSessionId>.sock）
  -> 载入 parent-scoped registry
  -> 仍在运行的 child 自行重连 bridge ⇒ adopt（读 entries 与 get_state，不新建 runtime、不重开会话）
  -> background child 的 runtime 证据随之作废：进程随 parent 结束，记录清掉 runtime、落 idle 并记 interrupted，后续 send 用同一 session 拉起新 runtime
  -> panel child 由 host 持有，可能仍在运行：记录保留 runtime 证据并标记为「未确认」，send 一律拒绝，直到那个 runtime 自己重连（adopt）或被 stop 显式清掉
```

后台 child 由 parent spawn 并持有 stdin，因此随 parent 进程结束（registry 记 interrupted，不自动重放）。
panel child 由 host 持有进程，天然跨 parent 存活，因此它的 runtime 不能因为「没在 adopt 窗口内重连」就当作已死。
重新打开 session 不等于继续任务：中断的 turn、initial task 或未确认消息不得静默重放。

## 4. 最小公共合同

### 4.1 Model-facing tools

会话模式注册交互式工具，由 `subagent_enable` 按需激活：

```ts
subagent_enable({})
spawn_agent({ task: string, agent: string, cwd?: string, title?: string })
send_agent({ id: string, message: string, mode?: "steer" | "follow_up" | "auto" })
get_agent({ id: string })
list_agents({})
stop_agent({ id: string })
```

统一任务生命周期管理：
子 Agent 通过 `bindTaskRegistry` 统一接入 ext-core 的 `TaskRegistry`。后台 Bash 任务与子 Agent 统一通过 `wait_tasks` 命令查询与等待，无需碎片化、专属性的任务工具。

规则：

- 不提供 `spawn_agents`；并行由 Pi parallel tool calls 提供。
- `spawn_agent` 必须给出明确 agent name；缺名或解析失败在启动前失败。
- `spawn_agent` 不暴露 model、thinking、tools、extensions、skills 或 budget 参数。
- `spawn_agent` 的 `title?` 只是 child session 的展示名：省略或纯空白时用 `🤖 <agent> · <subagentId>` 推导。
- `spawn_agent` / `send_agent` 返回后，模型不得用 `get_agent` / `list_agents` 轮询等待 child 完成。Child 任务沉降并保持空闲 5 秒后，Harness 自动提取最终输出文本并以 `customType: "pi-subagent-report"` 交付父会话；卡点则通过 `contact_parent` 立即唤醒父会话。
- `get_agent` / `list_agents` 只用于需要当前身份或状态时，不是完成通道。
- `send_agent` 只接受目标 child 和语义输入；发送给已完成（done）的 child 会自动唤醒并恢复其上下文。模型切勿在派发前等待或要求 Worker “冻结代码”。
- `stop_agent` 是唯一 model-facing 终止操作，先持久化 stopped 意图，再结束 runtime。

### 4.2 Child-facing tool

child branch 注册：

```ts
contact_parent({
  message: string;
  reason?: "blocked";
})
```

- **正常完成不调工具**：子 Agent 完成任务时直接输出最终回答文本即可。Harness 在检测到连续 5 秒空闲后自动提取文本完成汇报，并将 `TaskRegistry` 对应任务状态标记为 `completed`。
- **卡点与决策**：子 Agent 仅在遇到真正阻碍自身无法继续的严重卡点、或必须由父 Agent 决策的关键问题时调用 `contact_parent`。报告立即唤醒父 Agent，并将任务状态标记为 `failed`（阻塞）。

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

内置层有三个定义，都可被发现但不会被自动派发，都继承父模型与 thinking：
`scout`（只读侦查：`read`/`grep`/`find`/`ls`/`contact_parent`）、`worker`（实现：再加 `bash`/`edit`/`write`）、
`reviewer`（审查：`read`/`grep`/`find`/`ls`/`bash`/`contact_parent`）。工具名允许被 extension 扩展，因此内置
定义必须显式列出 `tools`——空的 `tools` 在下游意味着“全部工具”，与其承诺相反，属于配置失败而不是静默
放宽。这是工具能力限制，不是操作系统沙箱。

**`skills` 是白名单**（`extensions` 仍是 additive：bridge 必须始终在选中的 extension 列表里，二者语义不同）：

| 写法 | child 实际加载 |
|---|---|
| 省略 / `true` / `all` | Pi 发现的全部 skill（`skills: true`，不传 `--no-skills`） |
| `false` / `none` | 一个都不加载（传 `--no-skills`） |
| 列表 | **只加载这些**：传 `--no-skills` + 每个条目的 `--skill <绝对路径>` |

列表里的条目按形状区分：以 `./`、`../`、`~/`、`/`、盘符开头 → 定义文件旁的本地路径（必须存在，否则启动前报错）；
含 `:`、`/` 或 `\` → 原样交给 Pi 的路径/包规格；**其余当作 skill 名字**，在 parent 已加载的 skill 列表里解析。
名字的权威来源是 Pi 自己：`before_agent_start` 事件的 `systemPromptOptions.skills`（`name` + `filePath`），
所以本包不重新扫描磁盘、也不会与 Pi 的优先级/同名冲突规则不一致。名字找不到时**只 warning**（parent UI），
该条目被丢弃 —— 白名单只会变窄，绝不会因为写错名字而回退成「全部继承」；没捕获到 catalog 时同理（child 不加载任何 skill）。

内置层有三个定义，都可被发现但不会被自动派发，都继承父模型与 thinking：
`scout`（只读侦查：`read`/`grep`/`find`/`ls`/`contact_parent`）、`worker`（实现：再加 `bash`/`edit`/`write`）、
`reviewer`（审查：`read`/`grep`/`find`/`ls`/`bash`/`contact_parent`）。工具名允许被 extension 扩展，因此内置
定义必须显式列出 `tools`——空的 `tools` 在下游意味着“全部工具”，与其承诺相反，属于配置失败而不是静默
放宽。这是工具能力限制，不是操作系统沙箱。

`reviewer` 需要 `code-review`、`ponytail-review` 这类审查 skill。内置定义保持 `skills: all`（把具体 skill 名字
写进随包发布的定义会让没装它们的机器直接启动失败），要收窄就在项目级或 user 级同名定义里写白名单，例如
`~/.pi/agent/agents/reviewer.md` 里 `skills: [code-review, ponytail-review]`。

未知字段、未知模型、无效 thinking、冲突的 tool policy、非 boolean 的 `interactive`、被禁用的 `contact_parent`、不存在的本地 path 条目在启动前报错；未知的 skill **名字**只 warning。`exclude_extensions`、`preload_skills`、`max_turns` 和 `max_tokens` 在拥有明确执行语义前不属于 V1 合同。

### 4.4 Effective launch configuration

agent definition 与 parent 显式默认值只解析一次，形成可观察、非 secret 的 immutable launch spec：

```text
Pi invocation + argv + cwd
session ID/path
session title（可选，展示用）
agent identity + prompt assembly
provider/model + thinking
final tool/extension/skill selection
interactive policy
child bridge environment
```

后台 child、panel child 和 replacement runtime 共用同一 builder；只有 presentation、stdio 和 attachment 不同。默认 model/thinking 的继承必须显示在结果和状态中，不得静默替换 provider/model。API key 等 secret 不写 registry。

## 5. 持久化合同

### 5.1 Parent-scoped registry

V1 使用独立 JSON registry，按 `parentSessionId` 隔离，并通过 ext-core `readJsonSettingsRoot` / `updateJsonSettingsRoot` 更新。它不写入 `settings.json`，不增加数据库、event ledger 或 handoff history。

每个 child 至少保存：

- `subagentId`、`parentSessionId`、`sessionId`、可选 `sessionPath`；
- `cwd`、agent、初始任务、active/stopped 意图；
- 非 secret effective launch config；
- `state`、`presentation`（`panel` | `background`，spawn 时冻结）及 last-known summary/usage；
- 最后一次 launch 的 `runtimeIdentity` 与 endpoint（是证据，不是 liveness 证明）；
- 首次落盘状态与未确认输入。

token 不写入 registry：每 runtime 的 bridge token 由 parent 进程生成，存放在 `runtimeDir` 下 0600 的 token 文件里（`runtimeDir` 为 0700），这样 parent 重启后仍能认证重连的 child。该文件用「同目录临时文件 + rename」原子替换：原地写入会先截断，parent 若在那一刻被杀，仍活着的 panel child 会在重启后全部认证失败。

所有跨进程读取先做 runtime validation。损坏、版本不支持或身份不匹配时明确失败，不返回部分伪状态。

`presentation` 不做兼容读取：旧版本记录写的 `mode: "rpc" | "tui"` 的字段含义已不同（它描述进程由谁持有），因此解析直接失败并在错误里给出文件路径与「删除该记录」的指引，由用户手动清理，而不是猜测迁移。

启动失败同样不丢弃证据：panel 已经打开但 child 没连上时，先尝试关掉它，只有 host 明确确认「panel 已不在」才算干净（撤销 token、交回空句柄）；否则把句柄交回 manager 并保留 token——句柄阻止第二个 runtime，token 让稍后真的连上来的 child 能被 adopt，而不是变成没人拥有的进程。后台 child 的 SIGTERM 未能结束进程时同理。

### 5.2 首次 session 落盘

- 启动 runtime 前先保存原始 session ID、目标路径和 initial task。
- session 从未落盘且旧 writer 已确认死亡时，用原 session ID 显式创建，不对不存在路径调用会生成随机 ID 的 open 路径。
- session 已落盘时核对文件和 session ID；丢失、损坏或 ID 不符不得当作首次创建。
- bridge 就绪前不投递 initial task；投递失败时 child 记 failed 并把该输入记为未确认，不静默重发。
- RPC response 不等于 durability acknowledgement；断线时的输入标记 interrupted/待确认，不自动重发。
- child session 写在 parent 默认 session 目录下的 `agents/` 子目录里，并作为显式 `--session-dir` 传给 child：Pi 用非递归 `readdir` 枚举会话，所以 delegated session 不再出现在人的 session 列表里，而 registry 记录的显式目录/路径仍让 recovery 找得到文件。
- child branch 在首次 bind 的 session 上写入 title `🤖 <title>`；`title` 省略或纯空白时用 `🤖 <agent> · <subagentId>`（agent 名为空则只用 id）。该 marker 让 delegated session 被特意打开时一眼可辨。

### 5.3 单 runtime 规则

同一个 parent session 同时只有一个受管理 runtime，由三件事共同保证：

1. socket 绑定：parent 监听 `<runtimeDir>/parent-<parentSessionId>.sock`；第二个 Pi 进程若指向同一 parent session 会绑定失败并明确报错，不静默接管；
2. registry 记录：child 的 `runtimeIdentity` 是事件与报告的身份依据，身份不匹配的 frame 一律丢弃；
3. fail closed：无法确认 runtime 死活时不启动第二个 runtime，把可见错误返回给 model——本进程仍持有的 panel/进程句柄，以及重启后从未重连的 panel runtime 记录，都是「尚未确认」的证据，只要它在，send 就不会重新拉起；

bridge token 按 parent session 分开存放（`<runtimeDir>/tokens-<parentSessionId>.json`，0600）：同一台机器上两个 parent session 共享 runtime 目录，共用一个文件会让后写的一方抹掉对方的凭据，从而让对方的 panel child 在重连时无法通过认证。

不存在 claim 交接体系：没有 runner 进程可交接，也不做 PID/`/proc` 死亡探测。

## 6. Runtime 与协议合同

### 6.1 Bridge 控制面

parent 进程自己监听一个 Unix socket（`<runtimeDir>/parent-<parentSessionId>.sock`，目录 0700、socket 0600），每个 child 由自己的 bridge client 拨入，一条连接承载两个方向：

parent → child 请求：`prompt`、`steer`、`follow_up`、`get_state`、`get_entries`、`abort`、`shutdown`。
child → parent 请求：`contact_parent`、`task_result`（需要 parent 确认，例如重复的 task result 会被拒绝）。
child → parent 事件：允许转发的 Pi 事件（`FORWARDED_PI_EVENT_TYPES`）、`child_lifecycle`（`left_session | tui_quit | user_interrupt`）、`child_input`（只带来源，不带文本）。

- handshake 验证 protocol version、parentSessionId、subagentId、runtimeIdentity 与 runtime token，并核对 registry 中该 child 记录的 runtime 是否就是这个 runtimeIdentity：token 说明「哪个 runtime 在拨入」，registry 说明「该 runtime 属于哪个 child」，两者缺一不可（否则一个 child 可以冒用另一个 child 的 id 顶掉它的控制通道）。重连会替换旧连接，同一 child 永远只有一条有效连接；
- request/response 由 request ID 关联，events 与 responses 分流；同一个 report 重试时沿用同一个 request ID，因此「重连后重发」不等于「第二条报告」：parent 会重放第一次的结果而不重复执行副作用。这份去重缓存按 **child + runtimeIdentity + request ID** 保存（child 换 runtime 后 request ID 从 1 重新计数，只按 child 加 id 去重会把新 runtime 的第一份报告答成上一个 runtime 的结果）、有界、只在本进程内存里，覆盖重连而不覆盖 parent 重启；child 侧的 request ID 带本进程实例前缀，保证跨进程也不会撞号；
- 同一个 request ID 的两份同时到达（答案丢了，或 child 在第一次还没处理完时重连）共享同一个结果：后来者在自己的连接上收到同一份答案，而不是被判为重复请求——把重发判错会丢掉一份 parent 已经执行过的报告；
- 两个方向都有界等待：parent 请求 child 有 request timeout，child 交给 parent 的 report 也有响应超时——socket 还在但父端不回答时，report 可见失败并把队列让给后面的报告，而不是永久 pending；
- frame、pending requests、event 写入缓冲、child 侧 report 缓冲均有固定上限；
- timeout、disconnect、malformed frame 会结束相关请求，不留下 pending promise；无法解析的 frame 直接断开该连接；
- child 只在 parent 不可达时缓冲 report（有界、丢最旧且不丢在途、可见报错），Pi 事件是 advisory，断线即丢；advisory frame 若无法编码（超限或不可序列化）就丢弃并诊断，不因此断开控制通道——一条过大的 tool 结果不该让 child 失去 parent；
- report 携带调用方（tool call）的 AbortSignal：被取消的 tool call 不会再等 parent 回来，report 会从队列里退出并可见地失败，而不是永久 pending；

- parent 可以主动断开某个 child 的连接（`bridge.disconnect(childId)`），用于「这个进程已经不是这个 child」的情况；
- busy/idle 由 child 自己的 `get_state`（`ctx.isIdle()`/`hasPendingMessages()`）回答，parent 不推断。
- child 在 `session_start` 时才拨号，因此"连接存在"即"该 child 会话已就绪"：parent 的第一条请求不会落在一个还没拿到会话的进程上，adopt 时的 `get_entries`/`get_state` 也一定有意义。
- child 侧 `session_shutdown` 在 `quit` 与 `reload` 都销毁自己的 bridge client（reload 后由新实例重新拨号）：否则 reload 出的第二个 client 会和旧的抢同一条连接。session 绑定不变。
- adopt 时 child 自己的 `get_state` 是「此刻是否在忙」的权威答案，并同步进 state projector：transcript 以 tool result 结尾只是说明上一轮结束，如果不回写，随后任何一个不带状态的 Pi 事件都会把这份记录改回 `running`。

ParentChannel 复用这条连接，不建立第二套 message bus，也不依赖 terminal scraping 或 session JSONL polling。

### 6.2 State 与 presentation

公开 state：

```ts
type SubagentState = "starting" | "running" | "idle" | "done" | "stopped" | "failed";
type Presentation = "panel" | "background";
```

`done` 表示 runtime 已回收、session 与身份仍在（可被 send 用同一 session 拉起）。

启动时的 recovery 不能让 extension 挂掉：registry 读不出来（例如旧版本写的记录）时，把错误作为一条
`pi-subagent-recovery-failure` 消息报给用户，并提示删除该 registry 记录或整个文件以重置该 parent session
的 subagent 状态，其余功能照常加载。
Handoff/recovery 的细节属于内部 transition，不扩展 public enum。interrupted 是 status/summary diagnostic，不是额外 state。

`presentation` 描述 child 的进程形态：`background` 是无终端的 headless Pi（`--mode rpc`，stdin 由 parent 持有），`panel` 是 host panel 里的 native Pi TUI。它是 spawn 时冻结的事实，不是可切换的显示选项：改变呈现等于换一个 runtime，而 identity 与 session 不变。

### 6.3 Transition serialization

同一 child 的 spawn/send/stop/recover/adopt/事件投影由 SubagentManager 的 per-child rejection-safe chain 串行化。成功或失败都释放 queue。所有 late frame 必须按当前 runtime identity 核对后才能修改状态；stop 只等待运行中的 transition，不排在它后面造成死锁。

## 7. 生命周期合同

### 7.1 Spawn

1. 校验输入、agent definition、model 和最终 resources。
2. 创建 child ID/session ID，先持久化启动意图和 initial task，并按有无 host 冻结本次呈现。
3. 后台：parent spawn headless child Pi 并由 stdin 持有；panel：parent 铸造 runtime identity/token、构造 LaunchSpec，交给 HostAdapter 打开 panel 并运行该 argv。
4. child branch 在 `session_start` 拨入 parent socket，完成身份与 token handshake。
5. 只有 token 认证通过、child 收到并接受 prompt 后才报告 running；失败返回已完成副作用和可确认状态。

### 7.2 Send

- running child：明确 `steer` 或遵循 `auto` policy；不得靠屏幕状态猜测。
- idle child：follow-up/prompt。
- 没有可用 runtime 时先按冻结的 presentation 拉起同一 session（panel 会开一个新 panel），失败同理返回可见错误。
- 人工关闭 panel（或该 panel 的 child 进程退出）与 `stop_agent` 都是终止：保存 `intent=stopped` / `state=stopped`，后续 send 明确拒绝，并返回 `safeToRetry=false`，提示需要新建 child；session 文件保留，但不自动复活这个 child。宿主只能确认进程已退出，不能证明是人工关闭还是崩溃，因此已确认的外部 panel 退出统一按终止处理。
- 系统 idle 自动回收落 `done`，后续 send 可以恢复同一个 session；不得把自动回收后排队到达的断线事件当成人工终止。
- runtime ownership 不明时明确拒绝（`safeToRetry=false`）：说明无法确认旧进程已退出、没有启动第二个 runtime，必要时先清理旧 child 再 spawn 新 child。不增加 panel 身份持久化、反查或恢复探测。
- Task child 不接受后续输入，拒绝也标记为不可直接重试。
- 已接受但未确认持久化的输入被记录为待确认，断线后不静默重放。

### 7.3 Idle 回收

- 收到最终 `agent_settled`（不是 `agent_end`）且没有待处理输入后 child 落 `idle`；`SUBAGENT_IDLE_TIMEOUT_MS`（60s）到期即回收 runtime（先经 bridge 请求 `shutdown`，再结束进程），state 落 `done`，identity 与 session 保留。
- 回收只针对 `idle` 的 child：running 的 child 永远不会被自动结束，只有 `stop_agent`（或人自己关掉 panel）结束正在工作的 child。
- Task child 不参与 idle 回收：它的 parent 在收下结果后立刻清理 runtime。
- 退出未确认时（进程仍在，或 panel 关不掉/观察不到）记 `failed`、保留 runtime 证据**并保留本进程的句柄**：句柄是「不得再起第二个 runtime」的依据，也是重试 stop 的唯一抓手；此时 send 直接拒绝并要求先 stop，而不是悄悄再拉一个 runtime。
- panel child 的倒计时受聚焦影响：到期时先 `observe()`，panel 仍然聚焦（或聚焦不可判定）就重新计时，只有明确「没人在看」才关闭 panel。观察不清楚时不关闭——panel 只在有判断依据时被关掉。
- 在检查期间到达的任何 child 信号都会让这一次回收作废并重新计时：这些事件排在回收任务之后处理，只有「入站信号计数」能拦住一个已经在飞行中的判断，否则一个刚开始使用 panel 的人会失去它。
- 人手动输入（`child_input` 且 `source=interactive`）取消倒计时；parent 自己经 bridge 发的消息（`source=rpc`）不算人的存在。turn 结束后若没有待处理输入会重新计时。
- 宿主无法报告聚焦时（今天的 cmux）不倒计时：这类 child 只由 `stop_agent` 关闭，`HostAttachment.reportsFocus` 让 manager 不必猜。
- 本进程不持有 runtime 的 child（例如 parent 重启后 adopt 的 panel child）不倒计时：既无法确认退出，也无法判断聚焦，因此不做回收。

### 7.4 Session switch

TUI child 内 `/new`、`/resume` 或 `/fork` 进入不同 session B 后，child branch 以 `left_session` 上报：

- 该进程不再是这个 child 的 runtime：清 projector、清 idle 计时，状态落 `idle` 并记 interrupted，撤销该 runtime 的 bridge token 并从记录中删除 runtime 证据，因此它既不会在重连时被 adopt，也不会被当成 A 的 runtime；
- B 留在原生 TUI，不自动成为 subagent：本进程不再观察、也不再关闭它的 panel（panel 属于 B），后续 stop 不会影响 B，child 侧的 bridge 也会拒绝父端对这条连接的控制请求（`inactive_session`）；
- parent 同时断掉这条连接，child 侧则在离开后**永久关闭自己的 bridge**（不再重连）：即使 parent 因为 socket 当时不通或自己重启而没收到 `left_session`，它也不会 adopt 这个进程、更不会去关人正在用的 panel；
- 后续 send A 会按冻结的 presentation 拉起一个新 runtime，而不是把输入打进 B；输入能否投递取决于 bridge 连接，而不是「进程还活着」。

`/resume` 当前同一 session 与 `/reload` 不算 leave。

### 7.5 Stop

先在 registry 保存 stopped 意图（`intent=stopped`、`state=stopped`），再经 bridge 请求 `shutdown`，随后按 presentation 收尾：后台 child 结束自己 spawn 的进程（SIGTERM，必要时 SIGKILL）；panel child 关闭该 panel，并再次 `observe()` 确认它真的不在了。确认不成立时返回可见失败并保留 runtime 证据（「关闭命令成功」不算证据，「panel 已消失」才算）。两者都完成后删除 runtime 记录与 token。

对 adopt 来的 child（本进程既不持有进程也不持有 panel），stop 只能请求 `shutdown` 并等待 bridge 断开（有上限）；等不到就明确报告「需要人手动关闭它的 panel」，不谎报已停止。

child 的 bridge 断开但进程仍活着时，本进程**不自动关闭**它的 panel：那个进程可能在服务人切过去的 session，而自动关掉它没人要求过。这种 panel 的句柄会留着，交给 `stop_agent` 关闭（显式指令不是推断），或者由 child 自己重连后回到正常流程。

非显然不变式：headless child 跑在 Pi 的 rpc mode 下，`ctx.shutdown()` 只置一个 flag，而 rpc mode 只在处理完一条命令或 `agent_settled` 之后检查它，因此对 idle child 的 `shutdown` 请求不会让进程退出，它只是"这一轮结束后请退出"的礼貌请求。真正的优雅退出是 **SIGTERM**：rpc mode 注册了 SIGTERM handler，会走完整的 dispose（发出 `session_shutdown`、flush 会话、清理 runtime）并以 143（128+15）退出，所以退出码 143 是预期的优雅退出，不是失败；进程是否结束只看存活，不看退出码。进程退出无法确认时返回可见失败并保留证据。exit callback 看到 stopped 后不得触发自动恢复。Stop 幂等；stopped child 永不自动恢复。

### 7.6 Parent reload/restart

Parent lifecycle cleanup（含 `/reload`）只释放本地 bridge server、订阅、计时器和 UI，不终止仍活的 child 进程：后台 child 由 stdin 管道持有，只随 parent 进程结束；panel child 由 host 持有。
新 parent branch 重新监听同一 socket 路径，仍活着的 child 会自行重连并被 adopt（读 entries 与 get_state，不新建 runtime）。
parent fork/new session 不继承旧 parent 的控制权。

已知限制（有意保留）：adopt 来的 panel child 没有本进程开的 HostAttachment，因此聚焦观察、panel 关闭与 idle 回收都退化，stop 走上面的 bridge 等待路径。要恢复完整能力需要把 attachment 身份持久化并用 host 句柄工厂重建 attachment，V1 不做。

## 8. Host 与 UI 合同

HostAdapter 只负责 capability probe、开 panel（Herdr 新 tab / cmux 新 surface）、观察 panel（含聚焦状态）与 cleanup，返回可观察 attachment。

- herdr：`tab create`（`--cwd`、`--no-focus`、`--label <subagentId>`、`--env`）后用 `pane run <root pane> <LaunchSpec argv>` 运行 child，cleanup 关闭该 tab；聚焦 = 该 tab 的 `focused` 且其 workspace 的 `focused`。
- panel child 的 LaunchSpec 带 `--approve`，因为 parent 已明确选择并提供了项目级 agent、extension 与 skill 配置；native Pi TUI 启动不得停在项目文件信任提示上。
- cmux：`new-surface --command`；聚焦状态无文档化查询，因此 fail open（不自动回收），代码内以 `TODO(cmux-focus)` 标注。
- 关闭 panel 只证明 attachment 消失，不证明进程已死；进程证据以 bridge 断开（+ 后台 child 的进程句柄）为准。
- 开 panel 不是原子操作：host 可能已经建好 panel 并跑起进程，只是没能把结果报回来。此时 launch 明确报「未确认」，**保留** runtime token 与 runtime 证据（child 真起来了还能被 adopt），并且不因此允许第二个 runtime。
- `observe().alive` 回答的是「这个 child 的进程是否还在该 panel 里运行」，不是「panel 是否存在」：host 关闭命令失败但 child 已死时 stop 仍算完成，残留的空 tab 由人处理。判断「已关闭」必须 `known === true`：观察超时或查询失败都算未知，未知既不算已关闭，也不触发回收。
- 不做隐藏 panel、send-keys、readScreen、屏幕抓取。

- attachment 暴露 `reportsFocus`：宿主能报告聚焦时 manager 才为它安排 idle 回收，能力缺失时明确退化为「只由 stop 关」。

默认顺序为 herdr 后 cmux，用户明确指定时按指定选择；选择和 fallback 原因必须可见，不能静默改变执行 provider：选择结果写在启动诊断里，而每次 spawn 的结果都带上 `presentation` 与 fallback 说明。

parent 只在 spawn 时选 host：它持有 panel 的 attachment（身份、观察、清理），但绝不解析终端输出、不镜像 transcript、不替 child 构造第二份 argv。

V1 UI保持最小：

- tools完整显示结果并可引用collapsed output；
- `ctx.ui.select`提供child/agent选择；
- `setStatus`显示紧凑状态；
- 只有 `ctrl+shift+s`（stop）快捷键，与 `/subagents stop` 调用同一 SubagentManager 语义操作；attach 及其快捷键已随 §3.2 一并删除；
- TUI parent 用 ext-core above-editor widget 投影 `SubagentManager.list()` 中的活 child（`starting | running | idle`；`done | stopped | failed` 为终态，一律隐藏，与 presentation 无关）。无边框、不持有第二份 running set、不轮询文件；elapsed 按 spawn 时间计、有可见 child 时每秒刷新；零可见 child 时隐藏。Headless/RPC parent 不挂 widget。
- TUI child 显示一行无边框身份（agent 名、`contact_parent` 通道、当前 tool 数），不替代 parent widget，不成为控制面。

Native child交互始终使用真实Pi TUI；不实现transcript viewer、RPC event mirror或terminal scraping。

## 9. Usage、summary与结果

Usage从Pi已完成assistant turns/session stats重建并按child累计：input、output、cache read/write、cost和turns。重连不得重复累计，缺失provider数字明确按不可用处理而非猜测。

Latest summary取当前branch最后有效assistant内容，并区分：正常完成、仍在运行、interrupted、failed和stopped。panel与后台 child 使用同一口径。完整结果不得因UI折叠丢失。

## 10. 失败、取消与并发语义

所有工具、transition和后台恢复遵循同一合同：

- 已知失败、未知异常、protocol mismatch及无法确认的ownership/liveness通过Pi原生tool error或等价可见通知返回；
- 错误包含child、操作、原因、已完成副作用、当前可确认状态和安全重试条件；
- handshake、ready、exit、reconnect、panel cleanup 均有有限 deadline 并响应 AbortSignal；
- deadline后释放本地等待和transition queue；后台迟到结果仍做identity校验；
- fail closed表示拒绝当前危险操作并返回，不表示无限等待；
- model可查询状态或选择其他完成方法，但不得绕过 ownership、单 runtime 规则或消息去重；
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
3. parent reload/restart 优先 adopt 自行重连的 child；socket 绑定 + registry runtime identity 保证受管理路径不会出现第二个受管 runtime。
4. Herdr/cmux panel 里运行 child 的原生 Pi TUI；panel close、进程崩溃、idle 回收和 session switch 都符合本规格（身份与 session 保留，不重放中断的 turn）。
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

**取代关系（2026-10-01）**：SUB-08/SUB-09 的 attach/detach 与 SUB-06 的 replacement claim 已被
[`PLAN-panel-bridge.md`](PLAN-panel-bridge.md) 取代。已落地的替代实现：

```text
Stage 1  bridge 控制面（parent 侧 server、child 侧 client + 请求分发、协议收窄）✅
Stage 2  传输从 runner 切到 bridge（parent 直接 spawn 后台 child；删除 runner/connector/rpc-adapter/
         pause-gate、attach/detach、claim、#frozen）✅
Stage 3  panel 默认呈现（HostAdapter.open + 聚焦观察 + spawn_agent 默认 panel）✅
Stage 4  panel 生命周期（stop 关 panel、聚焦暂停 idle 回收、runtime 消失时释放 panel）✅
Stage 5  文档与 ticket 收口（本文件、README、tickets、architecture、DESIGN）⏳
```
