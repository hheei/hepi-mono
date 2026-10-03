# Pi Subagent Extension — Development Specification

## 1. Project Goal

實作一個 Pi subagent extension，讓主 Pi 可以建立及管理多個真正獨立的 Pi child sessions。

> **历史文档（2026-10-01）**：本文件不再是当前行为的来源。它的 §5（RPC 为默认）、§16–§21（attach/detach
> 生命周期）、§42–§44（writer 交接）与 replacement claim 体系已被
> [`PLAN-panel-bridge.md`](PLAN-panel-bridge.md) 取代；当前合同见 [`spec.md`](spec.md)。

核心使用方式：

```text
Main Pi
  │
  ├── spawn child A → RPC background
  ├── spawn child B → RPC background
  └── spawn child C → RPC background

User wants to inspect B
  │
  ▼
attach
  │
  ▼
B opens as native Pi TUI in Herdr/cmux

User exits B TUI
  │
  ▼
detach
  │
  ▼
B returns to RPC background mode and waits for new input
```

本 extension 不是 workflow engine，也不是自製 multi-agent UI。

它的核心職責只有：

```text
subagent lifecycle
+
Pi session continuity
+
RPC ↔ native TUI switching
+
parent ↔ child communication
+
minimal recovery
```

---

# 2. Core Design Principle

最重要的抽象是：

> **Subagent 的 identity 是 Pi session，而不是 process、RPC connection 或 terminal pane。**

因此：

```text
RPC process A
     │
     │ attach（idle only）
     ▼
TUI process B
     │
     │ detach
     ▼
RPC process C
```

只要使用同一個：

```text
Subagent ID
+
Pi Session
```

它們就是同一個 logical subagent。

原設計已明確要求 session 負責 identity、persistence、conversation continuity 與 RPC/TUI handoff，而不是 realtime IPC。

---

# 3. What This Project Is Not

第一版不要發展成完整 orchestration framework。

明確不做：

```text
custom transcript viewer
Fleet inspector
workflow DSL
workflowScript
mission system
scheduler
review-loop engine
council
task DAG
planner hierarchy
cost-based interruption
automatic worktree management
terminal screen scraping
large lifecycle event ledger
```

也不要重新實作 Pi：

```text
TUI
session system
RPC protocol
streaming renderer
conversation storage
```

能直接使用 Pi / Herdr / cmux primitive 的地方，就直接使用。

---

# 4. Architecture

第一版按真实生命周期分界，不按概念名称强制拆类：

```text
Main Pi tools / shortcuts
          |
    SubagentManager ---- Registry
          |
    reconnectable channel
          |
    per-child runner ---- Pi RPC child
          |                    |
          +---- child bridge --+---- native Pi TUI
                                      |
                                Herdr / cmux
```

SubagentManager 是唯一业务控制器，拥有 spawn/send/stop/attach/recover 决策。
后文的 RuntimeController 指这个控制器的 transition 职责，不要求第二个 class。
RpcRuntime、TuiRuntime 是模式相关操作；没有独立可变状态时，用函数即可。
ParentChannel 是语义协议，不是另一个消息总线；复用 runner 的可重连通道。

必要边界只有：parent extension、独立存活 runner、child extension branch、HostAdapter。
runner 与 child bridge 的连接在 RPC/TUI 两种模式下采用相同身份校验；
runner 不能随 RPC writer 退出，否则 handoff 会丢掉 reconnect endpoint。
parent cleanup 只解除连接和 UI 订阅，不结束 runner 或 child。

先把协议、启动配置和状态转换放在本 extension 内；
仅在进程入口、生命周期或已有多个调用方需要时拆文件、提升共享 API。

---

## 4.1 Reuse Boundary with Pi and Existing Packages

以下按仓库与已安装 Pi `0.85.1` 的实际公共导出核对。
直接复用优先于抽取，抽取优先于复制；不为尚不存在的调用方建立接口。

| 需求 | 直接复用 | 本 extension 仍负责 |
| --- | --- | --- |
| 对话与 session 身份 | Pi `SessionManager`，CLI `--session` | 单 writer、启动任务保留、reconnect |
| RPC 输入和查询 | Pi `RpcCommand` / `RpcResponse` | 薄 transport、request ID、错误/断线处理 |
| Agent 文档解析 | Pi `parseFrontmatter` | discovery 优先级、schema 与信任策略 |
| 模型精确选择 | `ctx.modelRegistry.find(provider, id)` | 显式继承/覆盖、失败可见，不猜模型 |
| Parent lifecycle | ext-core `registerExtensionLifecycle` | 只清理 parent-owned 连接、订阅和 UI |
| Registry 文件 | ext-core `readJsonSettingsRoot` / `updateJsonSettingsRoot` | 独立文件路径、schema、ownership 条件检查 |
| 工具显示和完整输出 | ext-core `getToolTui` / lifecycle `outputs` | semantic result、持久结果引用 |
| 简单选择和状态 | Pi `ctx.ui.select` / `setStatus` | 无 UI 时的 tool/API 路径 |
| 定制 picker / widget | ext-core `openTuiSurface` / `registerWidget` | 实际出现复杂 UI 需求时才使用 |

共享抽取只保留一个有现成来源的候选：

```text
Pi invocation resolution
来源：已移除的 MCTX subagent-runner
      resolvePiInvocation / resolveBundledPiCli（当时为内部实现）
在出现第二个调用方时，才提取该已证实 helper 到 pi-ext-core。
在 Main Pi 内解析 Node/Bun/packaged runtime 与 Pi CLI 路径，交给 runner；
runner 自己的 argv 不是 Main Pi CLI 路径，不能重新猜测。
```

无需预先抽取另外两套 API：

```text
JSON：updateJsonSettingsRoot 已公开，而且 root 更新不含 section merge。
直接用于独立 registry 文件，不写入 settings.json；其锁只保护 read-modify-write，
不证明 child ownership，也不提供整个 handoff transaction 或断电持久性。
schema 校验与 runtimeIdentity 条件更新在锁内做，拒绝损坏或过期记录。

Cleanup：parent 直接用 registerExtensionLifecycle 提供的 resources / signal。
只有 runner 确实需要同一 disposer 实现时才 export createDisposerRegistry；
不为了一个 parent scope 增加公开 API，不把 child stop 注册成 parent cleanup。
```

明確不提升到 `pi-ext-core`：

```text
MCTX 的 buildArgs（已移除的 subagent-runner）
→ launch args 由本 extension 自己一份 builder 產生
agent definition 的欄位驗證與 model/thinking/tool policy
parent-child identity 與 message routing
registry persistence 與 runtime state transition
RPC ↔ TUI handoff 與 recovery 決策
```

既有能力中不可直接沿用的部分：

```text
ext-core lifecycle / UI helper     → 可在 parent 端使用，但不要把存活 child 的終止
                                     註冊在 parent cleanup 上
startSubagent                      → shutdown 時會取消 subagent，無法提供存活保證
provideService / getService        → 同 process service registry，不是 IPC
patch 的 socket lock stale-unlink  → 不是安全的 ownership 證明
MCTX SQLite outbox / lease         → 不引入已移除實作的持久化層
```

也不要重新實作 custom transcript、Pi renderer、session JSONL event store。

Pi 內建 RpcClient 不直接作為可重連 runner client：目前 start() 自行 spawn、
使用固定 node 啟動並帶 --no-session；它不是連接既有 runtime 的 API。
runner 只實作本計畫需要的薄 RPC transport，使用共用 invocation helper 和持久 session，
以實際 RPC response / child handshake 確認 ready，不以固定 sleep 代替。

来源索引（实现时从 package root 导入，不 deep-import 私有模块）：

```text
packages/pi-ext-core/src/index.ts
packages/pi-ext-core/src/lifecycle.ts
packages/pi-ext-core/src/json-settings.ts
packages/pi-ext-core/src/tool-tui.ts
Pi dist/index.d.ts、dist/core/extensions/types.d.ts
Pi dist/modes/rpc/rpc-types.d.ts、dist/modes/rpc/rpc-client.js
```

Pi `createAgentSession` / `runRpcMode` 虽然公开，第一版不再引入 SDK 启动路线：
RPC 和 native TUI 都沿用 Pi CLI 的资源加载、信任和配置规则，避免维护两套启动语义。
Node `net` / `readline` 足以承载本地 JSON-line transport；沿用 Pi RPC payload，
只为 runner control、状态与 `contact_parent` 增加本 extension 必需的消息。
所有跨进程输入都做运行时校验；TypeScript 类型本身不是输入校验。

---

# 5. Execution Mode and Presentation Host

這兩個概念必須分開。

## Execution mode

```ts
type ExecutionMode = "rpc" | "tui";
```

### RPC

用途：

```text
background execution
machine-readable control
prompt
steer
follow-up
status
abort
```

正常 subagent 預設在 RPC mode。

---

### TUI

用途：

```text
human inspection
human intervention
native transcript
native Pi editor
native tool rendering
native shortcuts
```

TUI 必須使用真正的：

```bash
pi --session <same-session>
```

不要自己 render child conversation。

---

## Presentation host

```ts
type HostKind = "herdr" | "cmux";
```

Presentation host 只在：

```text
mode = tui
```

時有意義。

正常組合：

```text
RPC
mode = rpc
host = none

TUI
mode = tui
host = herdr | cmux
```

不要設計：

```ts
backend = "rpc" | "herdr" | "cmux";
```

因為 Herdr/cmux 並不是 agent execution backend。

原設計對 execution mode 與 presentation host 的區分已有相同要求。

---

# 6. Subagent Data Model

持久資料保持最小。

```ts
interface SubagentRecord {
  id: string;

  /** 建立並擁有這個 child 的 parent Pi session；child identity 只在該 session 內有效。 */
  parentSessionId: string;

  sessionId: string;
  sessionPath?: string;

  cwd: string;

  state:
    | "starting"
    | "running"
    | "idle"
    | "done"
    | "stopped"
    | "failed";

  mode: "rpc" | "tui";

  agent?: string;

  createdAt: number;

  usage?: UsageSummary;
}
```

Usage：

```ts
interface UsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  turns?: number;
}
```

不要把以下資訊視為 durable identity：

```text
PID
RPC connection
Herdr pane ID
cmux surface ID
socket handle
```

這些都是 runtime attachment。

内存中只保存当前连接、进程观察器、host attachment 和可重建的查询快照。
不把 Pi `RpcClient` 写进数据模型：这里使用的是 runner 的薄连接，不是 Pi 的 spawn client。
RPC/TUI 的互斥关系由一个 discriminated runtime state 表达，不用一组可任意组合的 optional handles。

## Identity 與 ownership metadata

child identity 只在建立它的 parent session 內有效，因此 record 必須帶 parent session：

```text
parentSessionId
    ↓
同一份 extension entry 的另一個 parent session 不能接管這個 child
```

reconnect（parent restart / extension reload）需要最小一組「不是 identity、但可以找回 runtime」的事實：

```ts
interface RuntimeMetadata {
  subagentId: string;
  parentSessionId: string;
  runtimeIdentity: string;
  endpoint: string;
  mode: "rpc" | "tui";
  pid?: number;
  startedAt: number;
}
```

規則：

```text
metadata 只回答「哪個 runtime 屬於我、要連去哪裡」
不回答「child 還活著嗎」 —— liveness 必須實際驗證
reconnect 前必須驗證 ownership（parentSessionId + runtimeIdentity）
無法確認 liveness / ownership 時 fail closed，不要啟動第二個 writer
旧 writer 退出时清除其 pid / attachment；runner endpoint 在 handoff 期间保留
runner 确认结束后，按 runtimeIdentity 条件清除 metadata，旧回调不能删掉新 runtime
```

`endpoint` 是可重新連線的 IPC endpoint，所以舊 process 活著時 parent 可以重新連上同一個 runtime。
但 PID、pane ID 之類的東西既不是 durable identity，也不是 liveness 的證明。

---

# 7. Persistent Registry

不要另外維護：

```text
events.jsonl
lifecycle ledger
process history
handoff history
```

Pi session 已經保存真正重要的 conversation state。

Extension 只需要知道：

```text
有哪些 subagents
每個對應哪個 Pi session
child 屬於哪個 parent session（identity scope）
是否仍應保持 active
目前是 RPC 還是 TUI
reconnect 需要的 endpoint / runtime identity
```

registry 只保存事實，不保存 speculative recovery state：

```text
running 代表上次結束前 child 還在執行
→ restart 後先驗證 runtime 死活與 ownership
→ 不確定就 fail closed，不是自動開一個新 runtime
→ 確認已死才用同一 session 開新 RPC
```

第一版使用独立、按 parentSessionId 隔离的 registry JSON，直接复用 §4.1 的文件更新函数。
不放进 settings.json，不建立 database 或 event store。
parent fork / new session 必须按当前 parentSessionId 重新加载，不继承旧 parent 的控制权。

Pi custom entry 可记录可见的结果/关联信息，但不是唯一 recovery registry：
Pi session 首次 assistant 消息前可能尚未落盘，且 branch/fork 语义不等于 runtime ownership。
parent 不得为了 flush registry 去打开并写入 child 的 session。

保持一份恢复所需事实：child/session 标识、effective launch config、active/stop 意图、
reconnect metadata，以及尚未确认写入 Pi session 的初始任务/待投递消息。
live state、usage 和输出从 Pi/child 重新查询；持久快照只是 last-known，不能当 liveness。
Pi RPC response 不等于消息已持久化；断线时不确定的投递标为 interrupted/待确认，不静默重发。

## 首次落盘前的身份保留

恢复时必须区分「从未落盘」与「已经落盘」：

- 首次启动前，registry 保存原 session ID、目标路径及初始任务；由 child runtime 创建 session。
- 从未落盘且旧 writer 已确认结束：新 runtime 显式使用原 session ID 创建 session，更新实际路径；
  不能只对不存在的路径调用 `SessionManager.open()`，因为这会生成新的随机 ID。
- 已经落盘：打开原文件并核对 session ID；文件丢失、损坏或 ID 不符时可见失败，不能当作首次创建。
- 初始任务及未确认投递的消息继续保留，回报 interrupted / 待确认，不自动重发。
- session 文件尚未建立时不允许 attach；交接前须确认文件已持久化且身份一致，不能仅凭 RPC response。

落盘状态必须结合 registry 与实际文件核实；若文件已建立但 registry 尚未更新，验证身份后采用该文件。
无法确认是从未落盘还是文件丢失时 fail closed，不静默创建空白对话。

---

# 8. Parent-facing Tool API

主 agent 只應看到少量 semantic tools。

建議：

```text
spawn_subagent
send_subagent
get_subagent
list_subagents
stop_subagent
```

之後如果發現：

```text
get_subagent
list_subagents
```

可以自然合併，也可以再收斂。

---

## 8.1 No `spawn_subagents`

不要建立：

```text
spawn_subagents([...])
```

Pi 本身已支援 parallel tool calls。

需要三個 children 時，主 agent 在同一輪直接：

```text
spawn_subagent(task=A)
spawn_subagent(task=B)
spawn_subagent(task=C)
```

由 Pi 的 parallel tool execution 處理。

因此：

> **parallelism 是 orchestration behavior，不是 runtime API。**

這是一個重要設計邊界。

## 8.2 统一失败返回：结束当前操作，让 model 选择其他方法

本规则适用于所有工具、runtime transition 和后台恢复。文中的 `fail closed` 统一表示：
拒绝当前不安全的操作，并明确报错结束本次等待；不是让工具、transition queue 或主 agent 一直停住。

- 已知失败、未知异常、协议不匹配及无法确认的 ownership / liveness，都通过 Pi 原生工具错误通道返回，
  不伪装成成功结果。错误包含 child、失败操作、已知原因（未知则明确写未知）、已完成的副作用、
  当前可确认状态及不能安全重试的条件；不得把未知状态写成已退出、已回滚或已恢复。
- handshake、ready、退出确认、reconnect、claim 获取及失败清理均有有限 deadline，并响应取消。
  到期结束本次操作、释放本地队列等待；保留 ownership 记录和必要的后台进程观察，迟到回调仍校验身份。
  失败清理本身超时也必须返回错误，不能以等待清理为由无限阻塞工具。
- model 根据错误选择查询状态、诊断、其他 child 或其他完成任务的方法；不默认要求人工介入，
  不无限重试同一失败路径。重试有副作用的操作前先核实既有结果，不重复投递未确认消息。
- 快捷键与后台恢复没有在途工具调用时，用同一错误内容通知用户及主 agent，并更新可查询状态；
  主 agent 离线时按 §45 保留必要报告，不能只写日志或等待下一次工具调用才暴露错误。
- 让 model 继续处理不等于放宽安全条件：writer 死活不明时不再开 writer，不清除未经验证的 claim，
  不静默重发任务。用户主动暂停仍按 §20 等待明确继续指令，不能把暂停包装成错误后自动续跑。

---

# 9. `spawn_subagent`

Model-facing schema 應保持很小。

概念：

```ts
spawn_subagent({
  task: string,
  agent?: string,
  cwd?: string
})
```

不要讓 LLM 每次都選：

```text
model
thinking
max_tokens
max_turns
extensions
skills
tool allowlist
```

這些應主要由 agent definition / config 決定。

---

# 10. Agent Definitions

Agent definition 可以直接採用目前 Pi subagent 生態已經形成的模式。

Discovery：

```text
.pi/agents/*.md
.agents/agents/*.md
~/.pi/agent/agents/*.md
```

Agent file：

```markdown
---
name: reviewer
description: Review code for correctness and unnecessary complexity
model: openai/gpt-...
thinking: high
tools:
  - read
  - grep
  - bash
extensions: false
skills: false
max_turns: 40
---

Review the requested change...
```

`extensions: false` 的語義與 child 啟動方式：

```text
child 仍用「同一份 extension entry」啟動：
  pi -e <absolute path to this extension entry>
     --no-extensions
     --session <child session>

- -e 必須是絕對路徑（child 不保證與 parent 同 cwd）
- --no-extensions 停用探索到的 user/project extensions
- 因此 child 內只會載入本 extension 的 child branch：
  `contact_parent` + 接收 parent 消息
- child branch 不註冊 SubagentManager、不註冊 spawn tool
  → 不會遞迴 spawn subagent
```

child branch 的職責刻意很小：agent definition 只調整 policy，不會讓 child 取得 parent 的 orchestration 能力。

先区分原生映射与本 extension policy，避免为现成能力再建一层：

| 字段 | 执行方式 |
| --- | --- |
| name / display_name / description / hidden | 本地 catalog metadata |
| model / thinking | 精确解析后传 `--provider` / `--model` / `--thinking` |
| tools / exclude_tools | Pi `--tools` / `--exclude-tools` |
| extensions | 显式绝对路径 `-e`，关闭 discovery 用 `--no-extensions` |
| skills | 显式路径 `--skill`，禁用用 `--no-skills` |
| Markdown body | 本 extension 的固定 prompt assembly，使用 Pi prompt 参数 |

原计划的 `exclude_extensions`、`preload_skills`、`max_turns`、`max_tokens` 候选字段保留，
但没有同名原生 CLI 开关，不能声称逐项直接映射。
排除扩展属于 effective resource selection；预加载技能正文属于 prompt assembly；
turn/token 限制属于 child policy，必须定义计量口径与达到上限的行为，再单独验收，
不能混同 §35 明确禁止的自动成本干预。未实现或无法兑现的字段应启动前报错，不能静默忽略。
不因这些字段预先引入第二套 SDK runtime 或通用 budget engine。

`--tools` 同样作用于 extension tools；必须显式保留 `contact_parent`，
并展示最终有效工具清单。若 denylist 禁用了必要 bridge capability，启动前报错。
loading skill 与预加载 skill 正文不是一回事；Pi 承担资源加载，不复制资源扫描器。

基本語義可以盡量與：

```text
pi-subagents-lite
pi-subagents
```

保持一致，避免再創一套 agent definition dialect。

---

# 11. Model and Tool Resolution

核心原則：

> **Agent runtime configuration 與 model-facing tool parameters 分離。**

例如：

```text
reviewer.md
    ↓
model = strong model
thinking = high
tools = read/grep/bash
```

主 Pi 只需要：

```text
spawn_subagent(
  agent = reviewer,
  task = ...
)
```

而不是：

```text
spawn_subagent(
  task,
  model,
  thinking,
  max_tokens,
  max_turns,
  tools,
  ...
)
```

這能：

```text
減少 tool schema
減少 token overhead
避免主 agent 隨意改 runtime policy
讓 agent definition 可重用
```

---

# 12. Parent → Child Communication

Parent 必須可以主動控制 child。

至少支援：

```text
steer
follow-up
status
latest summary
```

`send_subagent` 可以作為 semantic wrapper。

例如：

```ts
send_subagent({
  id,
  message,
  mode?: "steer" | "follow_up" | "auto"
})
```

第一版如果希望更簡單，可以只暴露：

```text
message
```

backend 根據 child 當前狀態決定：

```text
running → steer / queue
idle    → prompt/follow-up
```

---

## Parent steering 的目的

不是讓 parent 不斷 micromanage child。

而是當：

```text
child misunderstood task
child starts exploring wrong direction
new information changes task
parent needs clarification incorporated
```

時可以修正。

---

# 13. Child → Parent Communication

Child 需要一個獨立 semantic capability。

名稱建議：

```text
contact_parent
```

比 `report_to_parent` 更一般。

例如：

```ts
contact_parent({
  reason:
    | "progress_update"
    | "important_finding"
    | "need_decision"
    | "blocked",

  message: string
})
```

不要把這個能力綁定：

```text
RPC
TUI
Herdr
cmux
```

它是 subagent capability。

---

# 14. Parent Reply

當 child：

```text
contact_parent({
  reason: "need_decision",
  message: "Should I change API X or preserve compatibility?"
})
```

Parent 可以：

```text
send_subagent(...)
```

回覆同一個 child。

不一定需要額外：

```text
reply_parent_request
```

tool。

如果日後需要 correlated request/reply，再增加 request ID。

第一版保持：

```text
child reports
parent may steer/reply
```

即可。

---

# 15. Parent Channel

ParentChannel 是 parent ↔ child 之間必要的雙向 semantic channel。

它不應依賴：

```text
terminal screen
cmux read-screen
Herdr pane output
session JSONL polling
```

雙向概念：

```text
Main Pi extension
  │  prompt / steer / follow-up / status query
  ▼
ParentChannel
  ▼
Child Pi

Child Pi
  │  contact_parent() / status
  ▼
ParentChannel
  ▼
Main Pi extension
```

## 同一份 extension entry

parent 與 child 使用同一份 extension entry，由 branch 決定註冊什麼：

```text
pi -e <absolute path to this extension entry> [--no-extensions] --session <session>

parent branch:
  SubagentManager / tools / shortcuts / ParentChannel host side

child branch:
  `contact_parent` + 接收 parent 消息
  （不註冊 manager，不註冊 spawn tool → 不會遞迴 spawn）
```

child 端需要一個獨立存活的小 runner 負責 RPC：

```text
runner 自己擁有 child 的 stdin/stdout（parent 不持有 child 的生命線）
runner 提供可重新連線的 IPC endpoint，parent restart / reload 後還能連上同一個 runtime
runner 不引入 global scheduler；不做集中式排程
```

## Requirements

```text
child 只能找到自己的 parent
message 必須帶 child identity
不同 parent Pi sessions 不應互相串線
parent → child 與 child → parent 走同一條 channel
```

transport 可以是：

```text
Unix socket
local IPC
other simple cross-process transport
```

具體 transport 由實作者選擇。

---

# 16. Runtime Lifecycle

正常 lifecycle：

```text
spawn
  │
  ▼
RPC
  │
  ├── background work
  │
  ├── parent steer
  │
  ├── child report
  │
  │
  └── attach
        │
        ▼
       TUI
        │
        ├── human interacts directly
        │
        └── exit
             │
             ▼
           detach
             │
             ▼
            RPC
```

唯一真正終止 agent 的操作是：

```text
stop
```

---

# 17. Attach

Attach 是：

```text
idle RPC → native Pi TUI
```

V1 不做正在运行中的无缝热切换。流程：

```text
user selects child
       │
       ▼
press attach shortcut
       │
       ▼
serialize this child's transitions and stop accepting new parent input
       │
       ▼
query real Pi state
       │
       ├── streaming / compacting / pending input → return busy, keep RPC
       │
       └── idle and session persisted
               │
               ▼
       shut down old RPC and confirm process exit
               │
               ▼
       HostAdapter.attach(same resolved launch policy)
               │
               ▼
       native Pi TUI
```

如果以后有明确需求，可以另加 `interrupt-and-attach`：显式 abort 当前 turn、等待 Pi 回到 idle，
再走同一条 attach 路径。它必须向用户说明当前工作被中断；V1 不提供，也不伪装成无缝暂停。

---

# 18. Safe Attach Boundary

V1 的安全边界来自简单的顺序约束，不实现 child pause handshake 或 `turn_end` gate：

```text
1. SubagentManager 的 per-child transition queue 独占本次 attach
2. 从此不再接受该 child 的新 prompt / steer / follow-up
3. `get_state` 必须同时满足：
   isStreaming = false
   isCompacting = false
   pendingMessageCount = 0
4. session 文件已经落盘且 identity 匹配
5. 请求 runner 关闭旧 RPC，并确认 Pi process 已退出
6. 只有确认旧 writer 已退出，才启动 TUI
```

`turn_end` 不是 attach 条件；Pi 在 retry、compaction 和 queued continuation 全部处理完成后才会
进入 idle。这里使用 Pi 的实际 state 查询，并靠 transition queue 防止检查后又接受新输入。

如果检查时 child busy，attach 立即返回可理解的 busy 错误，RPC 原样保留。不要等待一个无限期
安全点，也不要在普通 attach 中 abort 正在执行的 tool。

## 旧 RPC 退出后的 attach 失败

退出旧 RPC 后，不能再声称「保留原 RPC」：

1. 尚未关闭旧 RPC：解除本次输入冻结，保留 RPC，返回 attach 错误。
2. 旧 RPC 已退出，且确认 TUI 未启动或已退出：清理本次创建且仍归本 attachment 所有的资源；
   child 非 stopped 时按 §42 恢复同一 session 的 RPC。新 RPC 只等待输入，不自动继续任务。
3. TUI 是否已经启动无法确认（例如 host 调用超时）：不启动另一个 writer；保留身份和观察信息，
   在有限 deadline 内返回错误。

所有分支都不自动重放 pending input。恢复失败时同时报告 attach 错误和恢复错误，不无限重试。

---

# 19. Native TUI

Attach 後必須直接啟動 native Pi TUI，并打开同一 session。命令必须由 §19 的统一 launch builder
产生，不能简化成只执行：

```bash
pi --session <same-session>
```

不要實作：

```text
custom transcript viewer
custom Pi renderer
RPC event mirror
fake child editor
```

原因：

Pi native TUI 已經處理：

```text
transcript
thinking
tool rendering
markdown
editor
autocomplete
commands
history
shortcuts
```

原文檔也明確要求 native UI 保持 native，而不是複製 Pi TUI。

## Effective launch configuration

RPC、TUI attach 與 replacement runtime 必須來自同一份 resolved child policy：

```text
session id / session path
cwd
agent definition
fixed tools / extensions / skills / system prompt
initial model + thinking（只用于尚未落盘的首次启动）
```

規則：

```text
child 第一次启动时显式继承 parent 当下的 model / thinking
这个决定必须可观察：不静默做 provider routing，也不悄悄换 model
tools / extensions / skills / system prompt / cwd 是 child 创建时固定的 policy snapshot
RPC、TUI 和 replacement runtime 始终复用这份权限 policy
```

已落盘 session 的 model / thinking 由 Pi session 自己恢复：重新打开时不再传旧 parent 默认值或
最初 snapshot 强制覆盖。这样用户在 TUI 中明确更换 model/thinking 后，后续 RPC 能沿用 Pi 已保存的
选择，而本 extension 不需要维护动态配置同步系统。恢复模型不可用时，暴露 Pi 的 fallback 结果，
不能静默声称仍使用原模型。

具體 args 由本 extension 自己的 launch args builder 產生（不提升已移除實作的 `buildArgs`）。

保持一条解析链：agent definition + parent 显式默认值 → effective config → launch spec。
launch spec 包含已解析 invocation、argv、cwd 和必要的 child bridge 环境变量；同一 persistence 状态下，
RPC/TUI 只改变运行模式和 stdio/terminal 接法。HostAdapter 不重新解析 agent 或拼另一份 Pi 参数。
保存非 secret 的固定 policy，避免重启时因 agent 文件变化而悄悄换权限；不复制 API key 到 registry。

---

# 20. Detach

Detach 是受管理的 TUI process 已确认退出，但 child logical session 仍然存在：

```text
TUI process confirmed exited
→ parent 已标记 stopped: do nothing
→ 否则: 用同一 session 启动 RPC
→ RPC 只等待新输入，不自动继续被中断的任务
```

规则：

```text
/quit、Ctrl+D、pane close 或 TUI crash 最终都走同一条 detach 产品语义
必须确认 TUI process 退出，不能只凭 pane/host 事件推断
crash 与正常退出的差别只在于额外报告异常
```

## V1 不跟踪 TUI 内部的 session 切换

用户在 attached TUI 中执行 `/new`、`/resume` 或 `/fork` 时，V1 不尝试立即把原 child 切回 RPC。
整个 TUI process 在退出前都属于该 attachment；只有 process 真正退出后，才重新打开 registry 中记录的
原 child session。

这个 trade-off 会让原 child 在用户切到其他 session 后暂时不在后台运行，但它删除了 session-switch
ownership、旧身份撤销和中途恢复等复杂逻辑，也不会启动第二个受管理 writer。切换出来的新 session
不会自动成为 subagent。

用户绕过本 extension，直接从其他 Pi process `/resume` 同一 session 的行为不在单 writer 保证范围内；
V1 不拦截 Pi 原生命令，也不尝试接管外部进程。

## 用户中断任务

如果 TUI 中明确观察到用户中断任务，向主 agent 报告 child 标识、最后活动和 `interrupted`；不自动恢复
执行。TUI 仍存活时保持 attachment；TUI 退出后可以重建 RPC，但只等待明确的新输入。crash 或来源不明
的中断不能描述成用户主动暂停。

---

# 21. Closing the Pane

直接關閉 cmux/Herdr pane 只表示 TUI attachment 消失：

```text
pane close
→ 確認 TUI process 已退出
→ preserve logical child state
→ 非 stopped → detach 語義 → 同一 session 在 RPC 復原
```

重點：

```text
pane close 是 detach 產品語義，不是 stop
不要只憑 pane 關閉推論 process 死活
parent 已標記 stopped → 不要重新啟動 RPC
```

不要為了「pane 關了」去 kill 一個還活著的 process，也不要把 pane close 當成 stop。

---

# 22. Stop

Stop 與 detach 必須嚴格不同。

## Detach

child TUI process 已確認退出：

```text
TUI → RPC
```

child 還活著。

---

## Stop

由 parent 明確觸發：

```text
RPC/TUI → stopped
```

child 不再執行。

建議主要 UX 是：

```text
Main Pi
  │
select subagent
  │
press stop shortcut
  │
  ▼
stop child
```

可以同時保留：

```text
stop_subagent
```

給 main agent 使用。

---

# 23. Stop Ordering

一定要：

```text
1. mark stopped
2. terminate runtime
```

不要：

```text
1. kill TUI
2. then mark stopped
```

否則 process-exit handler 可能把它當 detach，又重新啟動 RPC。

正確：

```text
record.state = stopped
      │
      ▼
terminate RPC/TUI
      │
      ▼
exit handler sees stopped
      │
      ▼
do nothing
```

如果 stop 与 attach 同时发生：

```text
先持久化 stopped / closing 意图
→ 让在途 attach 在下一个可取消边界退出
→ 若 attach 已关闭 RPC，则结束任何已启动或状态可确认的 TUI
→ 等待 terminate 完成
```

stop/cancel 信号不能只排在 transition queue 尾部；否则正在等待 host 或 process 退出的 attach
会阻塞 stop。所有等待都必须有 deadline，并在退出时按 runtimeIdentity 条件清理，不能误删新 runtime。

---

# 24. Unexpected Runtime Exit

## TUI exits

```text
if parent explicitly marked stopped:
    do nothing
else if TUI process is confirmed exited:
    detach 語義 → 同一 session 在 RPC 復原
    （crash / pane close 與 /quit 走同一條路徑）
else:
    等 process 確認退出；不要憑 pane 事件推論 process 狀態
```

crash 與 pane close 不需要「正常退出」這個前提就會恢復 RPC，但必須額外回報一次異常退出，讓 parent 看得見。

## RPC exits unexpectedly

```text
if child was stopped:
    do nothing
else:
    先嘗試 reconnect 既有 endpoint（確認是同一個 runtime 且 ownership 正確）
    連不上且能確認舊 process 已死 → 用同一 session 開新的 RPC，等待新輸入
    liveness 无法确认 → 不开第二个 writer，按 §8.2 返回错误，让 model 选择其他方法
if 上一個 turn 被中斷:
    state 落回 idle / failed，並明確回報 interrupted
    do not claim that the interrupted turn automatically continues
```

重新啟動 Pi RPC 只會載入同一 session 並等待輸入；它不會自動重播未完成的 user message，也不會自動繼續中斷的 agent turn。

所有新 runner 的恢复启动先执行 §42 的原子抢占；session 恢复再按 §7 区分已落盘与从未落盘。
用户主动中断按 §20 通知主 agent，等待明确继续指令；不得以恢复进程为由恢复执行。

不要嘗試恢復舊 PID/process。

---

# 25. Main Pi Restart

Parent restart 的第一優先是 reconnect 還活著的 child，而不是重建：

```text
load persisted registry
→ for each active child:
    讀 reconnect metadata（endpoint / parentSessionId / runtimeIdentity）
    驗證 ownership 屬於這個 parent session
    驗證 runtime 是否還活著
→ 活著 → adopt 既有 runtime
          （包含目前顯示在 TUI pane 裡的 child，不要再開一個新的 writer）
→ 確認已死 → 用同一 session 啟動新的 RPC（同 effective launch config）
→ 无法确认死活 → 按 §8.2 返回错误，不启动新 writer，由 model 选择其他方法
```

規則：

```text
扩展管理的操作保证同一 session 同时只有一个 writer；用户绕过 attach 的原生 /resume 风险见 §20
不可以只因為 pane 還開著就認定 child 活著
不可以在舊 runtime 可能還活著時啟動新 runtime
registry 顯示 running 只代表「上次結束前還在跑」，
不代表新 RPC 會自動接著執行原 turn
```

reopen session ≠ continue task：reopen 只是載入對話等待輸入，不會自動接續被中斷的工作。

---

# 26. Extension Reload

Extension reload 與 parent restart 走同一條規則：

```text
load registry
→ active children
→ 能 reconnect 就先 adopt 既有 runtime
→ 只有確認舊 runtime 已死才開新 RPC（同 effective launch config）
→ 不確定死活 → fail closed
```

不要維護：

```text
old process topology
old pane topology
old TUI attachment topology
```

process / pane 只是 disposable runtime attachment；session 才是 durable state。

---

# 27. Recovery Principle

整個 recovery 可以概括成：

```text
Pi session
    = durable conversation

Subagent registry
    = durable child identity/state

process / pane
    = disposable runtime attachment
```

這是所有 recovery 邏輯的基礎。

## Reopen ≠ continue

```text
reopen session
    = 載入既有 conversation，等待新輸入

continue task
    = 自動重播未完成的 user message / 繼續被中斷的 turn
```

reopen 不會自動變成 continue：

```text
session 建立前就收到的 initial task 與 pending messages 必須先持久化保留
runtime 被中斷時，被中斷的 work 要明確回報（interrupted），不是靜默重播
不要靜默 replay pending message，也不要聲稱被中斷的 turn 會自己接續
```

recovery 的目標是「同一個 child 還在、對話還在、使用者看得見發生什麼事」，
不是假裝剛才的 turn 沒有被打斷。

---

# 28. Host Adapter

Host adapter 只負責：

```text
can I open a native TUI here?
open it
observe when attachment ends
optionally close it
```

接口保持小，但不能只传 session 路径、只返回 pane ID：

| 边界 | 最小契约 |
| --- | --- |
| availability | 异步探测实际 host 能力，不只检查环境变量 |
| attach input | §19 的完整 launch spec、title、取消 signal |
| attach result | host/attachment 标识及可验证的启动结果 |
| runtime observation | runner / launcher 提供 writer 身份、ready 和退出证据；pane 消失不是退出证据 |

优先把 structured argv 交给 host；只有 host 接受 shell command 时才在 adapter 内统一 quoting。
进程完成/异常通知复用 runner channel，不再造另一套状态发现服务。
若 host 无法提供退出证据，必须补足 launcher 的进程观察；连 launcher 也失联就 fail closed。
具体 Herdr/cmux 能力在 adapter smoke test 中验证，不能假定 pane API 等于 process API。

---

# 29. Herdr

Herdr 是較 agent-aware 的 host。

Adapter 可以使用 Herdr：

```text
workspace
tab
pane
agent state
socket/CLI
```

但 core 不要依賴 Herdr-specific semantics。

Core 只應看到：

```text
host.attach(resolvedLaunchSpec)
```

---

# 30. cmux

cmux 更接近 terminal workspace primitive。

Adapter 可以使用：

```text
workspace
pane
surface
terminal launch
```

但同樣：

```text
SubagentManager
```

不應理解：

```text
CMUX_SURFACE_ID
workspace ref
pane layout
surface routing
```

這些全部藏在 adapter。

---

# 31. Host Selection

預設：

```text
Herdr
  ↓
cmux
  ↓
none
```

或者 config：

```json
{
  "hostPreference": ["herdr", "cmux"]
}
```

如果沒有可用 host：

```text
attach shortcut disabled
```

不要：

```text
spawn random terminal
open system Terminal.app
invent third fallback UI
```

---

# 32. Human Shortcuts

至少考慮兩個 human actions：

```text
attach selected subagent
stop selected subagent
```

Attach：

```text
idle RPC → TUI
```

Stop：

```text
RPC/TUI → stopped
```

快捷鍵具體值不要硬編進 architecture，可由 Pi extension keybinding/config 處理。

---

# 33. Status

Parent 應可以查：

```text
agent type
state
mode
task/description
latest summary
usage
elapsed time
interrupted（若工作被中斷）
```

例如：

```text
worker-3
running · rpc
"Implement parser refactor"
12 turns · 42k input · 6k output
latest: updating tests after parser change
```

不要把 internal runtime state 全部暴露給 LLM：

```text
RPC_STOPPING
TUI_STARTING
HANDOFF_PENDING
socket reconnecting
pane allocation
```

這些只是 implementation detail。

---

# 34. Latest Summary

`get_subagent` 可以返回：

```text
state
current/last known activity
latest meaningful report
latest assistant summary/output tail
usage
interrupted 與中斷前的最後活動
```

目的：

> 讓 parent 可以了解 child 在做什麼，而不用 terminal scraping。

優先使用 Pi semantic/session/RPC information。

不要讀 terminal screen 來生成 status。

按模式采用现成查询，不维护第二份 transcript：

| 数据 | RPC 路径 | TUI 路径 |
| --- | --- | --- |
| model/thinking、队列与 streaming 状态 | `get_state` | 标记为 attached；不伪造实时模型或队列状态 |
| 最后 assistant 文本 | `get_last_assistant_text` | 保留 attach 前最后快照，加上显式 `contact_parent` 报告 |
| 详细消息 | 按需 `get_messages`，不持续镜像 | 使用 native TUI |
| 累计统计 | `get_session_stats` | 显示 attach 前最后快照，detach 后由 RPC 完整刷新 |

V1 不让 child branch 解析 session entries 或维护第二套 telemetry，只负责双向消息与必要生命周期信号。
TUI 状态必须明确标成 last-known，不能冒充实时值。单独的 `isStreaming = false` 也不是安全 handoff；
attach 必须同时检查 §18 的完整 idle 条件，并在 transition queue 内停止接受新输入。
SDK 的 `AgentSession.getSessionStats()` 不在 extension context 上；不能写成 `ctx.getSessionStats()`。
最后输出采用当前 branch；RPC 返回的累计 usage 按 Pi 的全 session entries 口径，含 compaction/branch summary
及带 usage 的 tool result，不能只统计当前 messages 或把 usage.cost 当成数字。
重连后用完整快照替换旧快照，不叠加重放事件，避免重复计费统计。
完整结果由 Pi session 保留；parent UI 折叠不截断结果，ext-core outputs 只作当前 parent scope 的检索辅助。

---

# 35. Usage / Cost Tracking

記錄：

```text
input tokens
output tokens
cache read
cache write
cost
turns
```

用途：

```text
observability
debugging
model comparison
finding abnormal context usage
UI stats
```

明確不做：

```text
stop if cost > X
stop if token count > X
automatically downgrade model
automatically interrupt long child
```

> **Cost metadata is observational only.**

主 agent 不應因為某個 child 「看起來跑太久」就被 framework 自動殺掉。

---

# 36. Concurrency

不要自己發明 orchestration-level parallel API。

Pi 已經可以 parallel tool call：

```text
spawn_subagent(A)
spawn_subagent(B)
spawn_subagent(C)
```

Runtime 只需要正確支援：

```text
multiple simultaneously active SubagentRecord
multiple RpcRuntime instances
independent sessions
independent ParentChannel identities
```

如果需要 concurrency cap，可以後續作為 runtime safety/config feature。

但不要因此建立：

```text
parallel workflow
batch run
runs.all
```

等更高階 abstraction。

---

# 37. Worktree

資料模型可以預留：

```text
cwd
worktreePath
```

但第一版：

> **不實作 managed worktree isolation。**

不要自動：

```text
create branch
create worktree
apply patch
remove worktree
manage ownership
```

未來有明確需求再加入。

---

# 38. Streaming

Subagent manager 不需要 token relay。

RPC streaming：

```text
RPC runtime internal concern
```

TUI streaming：

```text
Pi native TUI concern
```

Manager 需要知道的是：

```text
turn completed
agent state
tool activity
latest report
usage
completion
```

不要建立：

```text
partial transcript synchronization
token stream multiplexer
custom streaming renderer
```

---

# 39. Terminal Scraping

禁止把：

```text
cmux read-screen
Herdr pane read
```

當核心 agent protocol。

可以作：

```text
debugging
diagnostics
host compatibility
```

但不應用來：

```text
determine child semantic state
extract result
build parent report
reconstruct session
```

原設計同樣明確把 screen scraping 排除在核心 protocol 之外。

---

# 40. Suggested State Machine

只需要相對簡單：

```text
                 spawn
                   │
                   ▼
               STARTING
                   │
                   ▼
                 RPC
                /   \
               /     \
          attach      complete
             │           │
             ▼           ▼
            TUI         DONE
             │
           detach
             │
             ▼
            RPC
```

任何 active runtime：

```text
parent stop
    │
    ▼
 STOPPED
```

Failure：

```text
RPC unexpected exit
→ 先 reconnect 既有 runtime；確認已死才用同一 session 開新 RPC
→ liveness 無法確認 → fail closed（不開第二個 writer）

TUI exit
→ 確認 process 退出 → detach → RPC
```

不需要把每個 transition 暴露成 public enum。

---

# 41. Public State

建議：

```ts
type SubagentState =
  | "starting"
  | "running"
  | "idle"
  | "done"
  | "stopped"
  | "failed";
```

Mode 單獨：

```ts
type ExecutionMode =
  | "rpc"
  | "tui";
```

不要創建：

```text
detached
fallback
handoff_pending
rpc_recovering
tui_lost
recovery_required
```

被中斷的工作不是新的 state：

```text
runtime 被中斷 → state 落回 idle 或 failed
並在 status / latest summary 明確顯示 interrupted
```

不要為了 speculative recovery 發明額外 state；
但 state 加上 summary 必須足以讓 parent 看見「這個 child 的工作被中斷了」。

---

# 42. RuntimeController

这是 §4 的 SubagentManager 所拥有的 transition 职责，不额外建立转发层：

| 操作 | 唯一控制器的职责 |
| --- | --- |
| spawn / send | 建立 child / 投递语义输入 |
| attach / detach | 同一 session 的 RPC ↔ TUI 交接 |
| stop | 先保存 stop 意图，再结束 runtime |
| recover | 优先 reconnect；确认旧 writer 死亡后才开新 RPC |

## Serialization

同一個 subagent 的 runtime transition 必須序列化：

```text
attach / detach / stop / recover / reconnect
        ↓
per-child transition queue
        ↓
一次只有一個 transition 在跑
```

理由：

```text
attach 與 stop 交錯 → 可能同時存在兩個 writer 或半套 handoff
reconnect 與 detach 交錯 → 可能對同一個 session 開兩個 runtime
```

控制器对每个 child 维护一条局部 Promise chain；成功和失败都必须释放队列。
复用 `packages/pi-ext-core/src/lifecycle.ts` 的 rejection-safe chain 写法即可，
不提取 generic queue，不引入 global scheduler。

stop/cancel 信号不能只排在正在运行的 attach 后面：先持久化 stopped / closing 意图并取消在途等待，
再由队列串行完成退出。exit/response 回调必须匹配当前 writer 身份，丢弃旧连接的迟到回调。
同一 parent session 被两个 Pi process 同时打开时，本地队列不够：
runner 一次只接受一个有效控制连接，replacement 前撤销旧连接权限；不能默默双控制。

## 启动新 runner 前原子抢占恢复权

runner 的单控制连接只能保护已有 runner，不能防止两个 parent 同时创建替代 runner。
因此，所有恢复入口（restart、reload、detach、crash recovery）必须遵循同一规则：

1. 优先 reconnect 存活 runner，由它确认 writer 状态并串行恢复；只有确认旧 runner 及其 writer
   均已结束，才申请启动替代 runner。runner 存活但不可连接时按 §8.2 报错，不另建 runner。
2. 在 registry 跨进程文件锁内重新读取 active/stop 意图与 ownership，按
   `parentSessionId + subagentId` 原子写入唯一启动 claim，保存 claim 标识、可验证的持有者身份，
   以及启动前已确定的新 runner endpoint 和 runtimeIdentity；不能等 spawn 完成后才登记查找地址。
   已有有效 claim 的竞争者不得启动，也不得覆盖 claim；不能把检查与抢占拆成两次无条件更新。
3. 只有 claim 持有者能启动对应 runner；runner 使用 claim 中预存的身份和 endpoint，自行完成注册，
   不依赖原 parent 在 spawn 后补写 metadata。注册及失败清理均按 claim 标识条件更新。
   runner 启动 writer 前再次确认 claim 仍有效且 child 未 stopped，并串行处理 start / stop，
   避免在核对之后、实际启动之前漏掉 stop。claim 失效时不得启动 writer。
   启动期间收到 stop 必须阻止启动或结束刚启动的 runtime，不允许已 stopped 的 child 被重新激活。
4. claim 持有者崩溃时，不能仅凭超时删除 claim。必须同时确认持有者及其可能启动的 runner / writer
   均已结束，才能在锁内替换 claim；有存活 runner 则验证后 reconnect，状态不明则 fail closed。
   使用预存 endpoint 与 runtimeIdentity 验证并重连已启动的 runner；endpoint 无响应不等于 runner 已死亡。
   无法确认时按 §8.2 报错结束本次恢复，不无限等待，也不靠超时抢占存活状态不明的 runner。

本地 Promise chain、registry 原子写入和 runner 单控制连接分别处理不同层次的竞争，不能互相替代。

---

# 43. RpcRuntime Responsibilities

負責：

```text
launch Pi RPC（透過獨立存活的小 runner）
connect RPC client
prompt
steer
follow-up
abort
observe turn lifecycle
observe child state
collect usage
shutdown cleanly
```

RPC runner 必須：

```text
是一個獨立存活的小 process/entry，自己擁有 child 的 stdin/stdout
提供可重新連線的 IPC endpoint（parent restart / reload 後可以再連上）
不引入 global scheduler；不做集中式排程
```

attach 的 idle 检查、输入冻结与关闭请求也走 runner control 路径；runner 不实现另一套 pause 协议。

runner 的 RPC adapter 只转发需要的 Pi 命令，并以 request ID 关联 response。
事件与 response 分开处理；超时/断线必须结束在途请求，限制 frame 和 pending request 大小。
Pi stdout 专供 RPC JSON lines，诊断走 stderr；不复制整份 RpcClient，也不实现 Pi 没有的 resume 命令。

不負責：

```text
pane creation
native UI
parent reporting policy
agent definition discovery
persistent registry
```

---

# 44. TuiRuntime Responsibilities

負責：

```text
select HostAdapter
launch native Pi on same session
observe process/attachment end
convert TUI exit into detach
```

不負責：

```text
parse transcript
mirror output
derive semantic result from screen
```

---

# 45. ParentChannel Responsibilities

ParentChannel 是必要的雙向通道，不是 optional 的 child → parent 報告管道。

負責：

```text
child → parent reports（contact_parent）
parent → child steering / follow-up
status query
idle/close control
parent identity isolation
message delivery
```

雙向都必須走同一條 channel：

```text
parent steer / follow-up ─┐
idle / close query ───────┼─→ ParentChannel ─→ child
                          │
child contact_parent ─────┼─→ ParentChannel ─→ parent
status / response ────────┘
```

语义与 host 解耦，物理上复用 §4 的 runner endpoint，不再维护第二套 IPC 服务。
RPC 模式的输入映射到原生 `prompt` / `steer` / `follow_up`；
TUI 模式由 child branch 调用 Pi `sendUserMessage`，明确选择 steer/followUp。
child report 在 parent 侧通过 Pi `sendMessage` / notification 投递，是否触发下一轮是显式 policy。
不可把 `contact_parent` 内容当作新的用户授权；携带 child ID、原始任务和状态供 parent 判断。
parent 暂时离线时只保留必要的待确认 report，并明确容量/失败；不得因为没有接收者阻塞 child tool。

不要用 terminal scraping 或 session JSONL polling 當通道。

---

# 46. Agent Definition Resolver

負責：

```text
discover .md definitions
resolve precedence
parse frontmatter（直接使用 Pi parseFrontmatter，不自寫 parser）
resolve initial model/thinking for first launch
resolve fixed tools/extensions/skills/prompt policy
validate config
```

不要讓 `spawn_subagent` 自己包含大量 config resolution logic。

`parseFrontmatter` 只解析 YAML，不验证业务 schema；加载后校验 unknown 数据。
parent 默认模型取 `ctx.model`，thinking 取 `pi.getThinkingLevel()`，不是不存在的 `ctx.thinkingLevel`。
V1 model 使用明确的 provider/id，通过 `ctx.modelRegistry.find(provider, id)` 精确核对。
Pi `resolveCliModel` 含 fuzzy matching；暂不引入其别名语法或另建 ModelRuntime，避免隐式选型。
interactive TUI 是默认启动方式，不存在 `--mode tui`；只有 RPC 添加 `--mode rpc`。

---

# 47. Recommended First Version

## Phase 1 — Core RPC

完成：

```text
agent definitions
spawn_subagent
get_subagent
list_subagents
send_subagent
stop_subagent

RPC runtime + 獨立存活 runner（擁有 child stdin/stdout、可重連 IPC endpoint）
Pi session persistence
minimal registry（含 parentSessionId 與 reconnect metadata）

latest result/status（usage/cost display 延后到 Phase 5）
child → parent communication（同一份 extension entry 的 child branch）
parent steering
雙向 ParentChannel
per-child serialized runtime transitions
```

Acceptance：

```text
Main Pi can launch several child sessions concurrently.
Each runs independently.
Parent can inspect state.
Parent can steer.
Child can contact parent.
Parent can stop a child.
```

---

## Phase 2 — Recovery

完成：

```text
main Pi restart recovery
extension reload recovery
RPC crash recovery
```

Acceptance：

```text
還活著的 child 被 reconnect（含正在 TUI pane 裡的 child），不是被重建。
New RPC 只用於確認已死的 child，且載入同一 session。
Stopped children never restart.
無法確認 liveness 時 fail closed，不啟動第二個 writer。
```

---

## Phase 3 — Native TUI Attach

完成：

```text
Herdr detection
cmux detection
HostAdapter

attach shortcut
per-child input freeze + complete idle check
parent 等舊 RPC process 確實退出
idle RPC → TUI handoff
same fixed policy + Pi-restored session model/thinking
```

Acceptance：

```text
User selects an idle background child and presses attach.
Parent serializes the transition, stops accepting new input, and verifies the complete idle condition.
Parent closes RPC and confirms the old writer exited before starting TUI.
Same Pi session opens as native Pi TUI; conversation remains continuous.
Busy child returns a visible busy result without aborting its tool or closing RPC.
Failure before RPC exit keeps RPC; failure after exit follows §18 recovery and never starts a second writer.
```

---

## Phase 4 — Detach

完成：

```text
TUI process exit detection（確認 process 真的退出）
/quit / exit / Ctrl+D semantics
pane closure
TUI crash handling
TUI → RPC recovery（不需「正常退出」前提）
TUI 内部 `/new`、`/resume`、`/fork` 不触发中途 detach；process 退出后恢复原 child session
用户主动中断通知主 agent，等待明确继续指令
```

Acceptance：

```text
Exiting child TUI never kills a non-stopped logical subagent.
任何已確認的 process 退出（正常、crash、pane close）都走 detach →
同一 session 在 RPC 復原。
An RPC restart does not claim to resume an interrupted turn automatically.
Stopped children never restart.
TUI 内切换到其他 session 不产生新的 subagent；TUI process 退出后只恢复 registry 中的原 child session。
用户直接 /resume 运行中的 child 保留 Pi 原生行为，不提供防双 writer 拦截。
用户中断任务会明确通知主 agent；进程恢复不触发任务续跑。
```

---

## Phase 5 — UX Refinement

考慮：

```text
compact subagent status widget
agent picker
usage/cost display
notifications
better latest-summary display
host-specific polish
```

不要在前面 phases 完成之前先做 dashboard。

直接复用 §4.1：简单 picker 用 Pi select，status 用 setStatus；确需定制时才使用
ext-core Surface / Widget。工具展示用共享 ToolTui，生命周期 signal 负责关闭 parent UI。
不建立 subagent 专属 surface queue、overlay manager 或 output registry。

---

# 48. Acceptance Scenarios

## Scenario A — Normal background child

```text
Main asks worker to investigate bug
→ spawn_subagent
→ child runs RPC
→ reports important finding
→ completes
```

Expected：

```text
child 以同一份 extension entry 的 child branch 啟動
（-e 絕對路徑、--no-extensions）
child process 由獨立存活的小 runner 持有 stdin/stdout
child 透過 ParentChannel 回報
完成後 child identity 與 session 不變
```

---

## Scenario B — Parallel children

```text
Main emits three spawn_subagent tool calls in parallel
```

Expected：

```text
3 independent Pi sessions
3 independent RPC runtimes
no special batch API
```

---

## Scenario C — Human inspection（attach）

```text
child is idle in RPC
user selects it
press attach
```

Expected：

```text
parent 序列化 transition，停止接受新的 steer/follow-up
完整 idle 条件满足后，请求关闭 RPC
parent 确认旧 RPC process 退出后才启动 native TUI（單一 writer）
native Pi TUI opens
same session continues
正在執行的 tool 不會被強制切斷：busy child 直接拒绝 attach，RPC 保留
旧 RPC 退出后的启动失败按 §18 恢复，不谎报旧 RPC 仍存活
```

---

## Scenario D — Normal child exit

Inside child TUI:

```text
/quit
```

Expected：

```text
TUI closes（process 確認退出）
child remains active
same session resumes in RPC
```

---

## Scenario E — Pane closed

User closes cmux/Herdr pane.

Expected：

```text
先確認 TUI process 已退出（不是只憑 pane 事件）
非 stopped → detach 產品語義
same session resumes in RPC
不需「正常退出」這個前提
```

---

## Scenario F — Parent stop

User selects child in main Pi and presses stop shortcut.

Expected：

```text
mark stopped first
cancel any in-flight attach wait, then terminate the confirmed current runtime
do not restart
```

---

## Scenario G — Main Pi restart

```text
Main Pi crashes/restarts
```

Expected：

```text
registry reloads
驗證 reconnect metadata 的 ownership（parentSessionId / runtimeIdentity）
還活著的 child 被 reconnect —— 包含目前顯示在 TUI pane 裡的 child，不重建
確認已死的 child 才用同一 session 開新 RPC（同 effective launch config）
無法確認 liveness → fail closed，不啟動第二個 writer
被中斷的 work 明確回報 interrupted，不假裝自動接續
no automatic TUI reopening
```

---

## Scenario H — RPC crash

```text
child RPC process unexpectedly dies
```

Expected：

```text
先嘗試 reconnect 既有 endpoint
確認舊 process 已死 → 用同一 session 開新 RPC，等待新輸入
liveness 无法确认 → 按 §8.2 返回错误，让 model 选择其他方法，不启动第二个 writer
被中斷的 turn → state 落回 idle / failed，並明確回報 interrupted
do not silently continue interrupted turn
stopped children do nothing
```

---

## Scenario I — Equivalent launch configuration

```text
spawn → RPC
attach → TUI
parent restart → reconnect 或新 RPC
```

Expected：

```text
三條路徑复用同一份固定权限 policy
（session、cwd、agent definition、tools、extensions、skills、system prompt assembly）
child 第一次启动时继承 parent model/thinking 的决定显式且可观测，没有静默 routing
后续 runtime 的 model/thinking 由同一 Pi session 恢复，不用旧 parent 默认值覆盖
```

实现复用边界时增加以下 focused 验收，不复制上游测试套件：

1. 同一 policy 生成的 RPC/TUI launch spec 仅有 mode/stdio 差异；带空格路径不被重新拆词；
   reopening 不传旧 model/thinking 覆盖 Pi session 已保存的选择。
2. tools allowlist 保留 contact_parent；未知模型、无效 frontmatter、未兑现 policy 启动前可见失败。
3. registry 首次写入、并发更新、损坏输入、fork 隔离和旧 runtime 回调不误删新 metadata。
4. reconnect 不重复累加 usage；TUI 中统计明确为 last-known，detach 后以 Pi RPC 的完整快照替换。
5. attach 的 idle 检查与关闭等待期间 stop/cancel 不死锁；parent reload 只释放本地连接/UI，存活 child 可重新连接。

## 本轮审查补充验收

1. 两个 parent 同时 recover 已死亡的 runner，只能产生一个新 runner / writer；
   claim 持有者在启动前后崩溃、stop 与启动交错时，不重复启动、不覆盖新 ownership，未知状态 fail closed。
2. 首次 assistant 回复前崩溃，恢复仍保留原 session ID 与初始任务，报告 interrupted 且不自动重发；
   未落盘时 attach 被明确拒绝，已落盘文件缺失不被当作空白新 session。
3. attached TUI 内 `/new`、`/resume`、`/fork` 不触发中途 detach，也不产生新的 subagent；
   TUI process 退出后只恢复 registry 中记录的原 child session，旧回调不误控新 runtime。
4. 用户直接从外部 Pi `/resume` 同一 session 不增加拦截或自动接管，明确不在受管理单 writer 保证内。
5. 用户主动中断后，主 agent 收到明确通知；无明确继续指令不恢复任务。
   普通中断不重建 RPC，crash 不冒充用户暂停；pending messages 不被静默重放。

## 失败恢复与错误返回验收

1. 旧 RPC 退出后模拟 pane 创建失败或 TUI 启动失败：确认没有存活 TUI writer 后恢复 RPC 等待输入，
   attach 仍返回错误并报告恢复结果；恢复失败也在 deadline 内结束，不静默续跑任务。
2. host 调用超时但 TUI 实际已启动：不重复启动 writer，不谎报回滚成功；保留身份并明确报错。
3. parent 在 spawn runner 后、metadata 发布前崩溃：接管方可从 claim 找到预定 endpoint，
   runner 可自行注册；验证身份后 reconnect，不重复启动。失效 claim 对应的 runner 不启动 writer。
4. 注入未知异常、连接失联及清理超时：在有限 deadline 内返回 Pi 工具错误，主 agent 能继续采取其他方法；
   本地 transition queue 不被失败操作占住，后续查询或独立 child 操作可执行。
5. 快捷键或后台恢复失败也向主 agent 投递同样的错误事实；model 不绕过 ownership / 单 writer 约束，
   不重复投递未确认消息，不把用户暂停当作自动恢复任务的理由。

---

# 49. Explicit Non-Goals for V1

Do not add these unless a concrete requirement appears:

```text
managed worktrees
nested subagent delegation
workflow engine
missions
schedules
automatic reviewer
council
cost budgets
automatic kill policies
custom transcript viewer
screen scraping
full lifecycle event archive
distributed/remote agents
```

---

# 50. Implementation Heuristics

When implementing a feature, ask in this order:

### 1.

Can Pi already provide it through:

```text
session
RPC
AgentSession
extension API
lifecycle events
```

If yes, use Pi.

### 2.

Is it purely terminal presentation?

Use:

```text
Herdr
cmux
```

through HostAdapter.

### 3.

Is it parent/child semantic communication?

Use:

```text
ParentChannel
```

not terminal IPC.

### 4.

Is it durable conversation state?

Use:

```text
Pi session
```

not custom event storage.

### 5.

Is it only runtime attachment state?

Keep it ephemeral.

例外：reconnect 必需的最小 runtime metadata（IPC endpoint、parentSessionId、
runtimeIdentity、pid、startedAt）在 parent restart 後仍必須取得得到，
并按 §6 区分 writer 退出与 runner 结束后清理，不能在 attach 时删掉仍有效的 endpoint。

它只是 reconnect 用的事實，不是 child identity，也不是 liveness 保證；
無法確認 runtime 死活時必須 fail closed，而不是靠 metadata 推論。

---

# 51. Final Mental Model

實作者應該始終以這張圖理解系統：

```text
                         Main Pi
                            │
                     subagent tools
                            │
                     SubagentManager
                            │
                     logical child
                            │
                       Pi Session
                      /          \
                     /            \
             background          visible
                 RPC               TUI
                                    │
                               HostAdapter
                               /         \
                            Herdr        cmux
```

Communication：

```text
Main Pi
   │
   │ steer / send
   ▼
Subagent

Subagent
   │
   │ contact_parent
   ▼
Main Pi
```

Lifecycle：

```text
spawn
  ↓
RPC
  ↓ attach
TUI
  ↓ exit / pane close
detach
  ↓
RPC

parent stop
  ↓
STOPPED
```

Persistence：

```text
Pi session
    = conversation

registry
    = child identity/state

process/pane
    = disposable attachment
```

Parallelism：

```text
Pi parallel tool calling
    ↓
spawn_subagent × N
```

而不是：

```text
spawn_subagents
parallel workflow API
```

---

# 52. One-Sentence Product Definition

> **A Pi extension that manages multiple persistent child Pi sessions, runs them efficiently in background RPC mode, and lets the user attach any child as a real native Pi TUI without changing that child's identity or conversation.**

這一句應該成為所有實作取捨的基準。
