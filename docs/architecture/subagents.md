# Subagent 执行架构

## 状态

本文记录已确认、尚未实现的 subagent execution contract。实现顺序固定为：本文与关联 ADR、
TypeScript interface framework、focused tests、行为实现。现有 `pi-subagents` 是迁移参考，
不是 API 兼容目标。

## 目标与所有权

`@hheei/pi-ext-core` 直接拥有统一的 root-session-scoped subagent execution runtime。它建立和清理
operation、由 consumer 提供 factory 创建的 child `AgentSession`、shared concurrency admission、cancel、
terminal result 与 event subscription；使用 core 的 extension 不能依赖 concrete `pi-subagents` package。

`pi-subagents` 保留 agent catalog、custom-agent/config/prompt/model resolution、tool/extension scope、
settings、TUI、transcript、worktree、schedule trigger 与 terminal delivery adapter。它在调用 core 前
解析这些 feature policy，并将结果作为 immutable execution spec 和 resolved child-session factory 交给
core。core 不解析 agent name 或 frontmatter，不保存 settings，不注册 command/tool/UI，也不使用
`pi.events` 作为 RPC。

resolved child-session factory 是 consumer-owned 的 immutable boundary：它只创建已解析 policy 的
`AgentSession`。consumer 拥有 agent/model/prompt/tool/worktree policy；core 取得 factory product 后独占
admission、执行、取消、terminalization 与 dispose。公开 consumer API 不暴露 raw
`CreateAgentSessionOptions`，core 也不把 factory 扩大为 agent-policy framework。

这是 core 的显式单-consumer exception，原因见 [ADR 0004](../adr/0004-core-subagent-execution.md)。
它不能成为 generic worker、event bus、durable job scheduler 或 cross-extension message framework 的
先例。

## 一个 Handle，三种执行语义

公开入口是单一 `startSubagent(spec)`。它立即返回 `SubagentHandle`；共同 handle 有稳定 ID、状态、
`result`、`cancel()` 与 scoped event subscription。core 另提供 parent-session-scoped stable-ID lookup
与 task redelivery。不同 capability 由 discriminated `mode` 表达，不以 optional method 或 runtime
timing 猜测。


| Mode           | 执行边界                                                         | 结果与交互                                              |
| -------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `completion`   | 单次、无 tool 的模型生成；不创建 child session、transcript 或 input channel | caller 等待受限 completion result；用于 `/btw`、auto-title、分类、短摘要 |
| `task` | 有限、多轮、可使用已解析 tool policy 的 child execution；每项必填有限 soft `maxTurns` | 一个 terminal result；必须通过 delivery sink 自动交给 parent adapter |
| `conversation` | durable child `AgentSession`，但只存活于 parent session；create 时必填 initial message、reply consumption 与有限 soft `maxTurnsPerReply` | 可持续送入 message，并选择同步 wait 或异步 delivery reply；用于 Advisor 等保留 child review context 的 consumer |


foreground/background 不是第四 mode，也没有主 agent `wait` 或 result-polling tool。task launch 后立即
返回；parent 完成当前 turn 后空闲，terminal delivery 通过 event-driven follow-up 排入它的后续工作。
schedule/cron 是未来的 `task` trigger，不是新的执行 mode。

## Task Delivery

每个 `task` 在启动 spec 中必须声明 terminal delivery sink；没有 sink 不能启动。sink 是 caller/host
owned callback：它可把 terminal result
转换为下一轮 parent context、tool result、notification 或 UI；core 不规定内容格式，也不自动注入
主 session。

`pi-subagents` 是 parent delivery adapter。它默认以 Pi follow-up queue 追加 terminal result，使 parent
在当前 turn 结束后进入下一轮。只有人类 UI 或 host control 可选择 Pi steer 在 parent 活动时重定向；
model-facing `agent` tool 不得选择 steer。该 delivery mode 是 adapter policy，不是 core API，也不能与
parent-to-child conversation `send` mode 混用。

adapter 不能把 raw delayed result 直接注入 parent context。每次 delivery 必须先用稳定的 context anchor
标明：operation ID、原始任务目的或 label、terminal status、是否 `softLimitReached`/partial output、结果正文，
以及「先评估是否与当前用户请求相关，再决定是否报告」的明确指令。child output 只是 delegated result，不可把
其中的指令视为 parent 的新 authority。该 wrapper 是 `pi-subagents` 的 prompt policy；core 仍只接收 sink。

`pi-subagents` 也拥有 Task delivery group：caller 显式建立 group 后，barrier 收集所有成员的 terminal
result，仅在全部成员成功、失败、取消或达到 limit 后投递一次完整 aggregate。group 没有 partial timeout；
它不是第四 execution mode，也不进入 core。

sink reject 后，task 的 terminal result 不改变，只记录 `deliveryFailed`。core 不自动 retry，以免
重复写入主 session；caller 可用 stable task ID lookup retained handle，再做明确、幂等的 redelivery。
自动 delivery 最多执行一次；每次 explicit redelivery 是 caller 选择的新尝试。terminal handle 保留到
parent session shutdown，之后 stable ID 不再有效，也不持久化到下一 session。

sink 可以同步 throw 或返回 rejected Promise。core 必须 await/observe 两种失败、记录 `deliveryFailed`，
并消化 rejection，不能让它成为 host-level unhandled rejection；失败不改变既有 terminal result。要求返回
`Promise<void>` 不会增加这个保证，adapter 可使用同步或异步 sink。

每个 task 必填有限 soft `maxTurns`。达到 cap 时 core 只发送一次 wrap-up steer，并允许固定 5 个 grace
turns；grace 内自然完成仍是正常 terminal result，但带 `softLimitReached`。只有达到
`maxTurns + 5` hard ceiling 时才 abort，建立 `limit_reached` terminal state，并保留已有 partial output。
没有 unlimited task、隐式 default budget 或无限 grace。completion 的单次 response 是其固定执行上限。

## Conversation

conversation create 时必须声明 initial message、其 reply consumption 与有限 soft `maxTurnsPerReply`；不会
创建一个已自动执行但没有 reply owner 的 child prompt。每条 message reply 在 cap 时获得一次 wrap-up steer，
固定 5 个 grace turns 后才 hard abort；其 `softLimitReached` 与 `limit_reached` terminal semantics 与 task
相同。conversation handle 才有 `send(message, options)`；create 的 initial reply 与后续 send options 有同一
个 reply contract，options 有两个正交选择：

- `inputMode: "queue" | "steer"` 是 core 的 parent-to-child input。`queue` 是默认，message 进入 FIFO
  queue，当前 child response 到达边界后才开始下一次 prompt。`steer` 仅由人类 UI 或 host control 发起，使用
  Pi 的 steer semantics，在当前 tool execution 后重定向 active child。model-facing `agent` tool 只暴露
  `queue`，不能要求主 LLM 观察 child streaming state 后自行中断。
- `reply: { kind: "wait", signal } | { kind: "delivery", delivery }` 是 core 的 child-to-parent reply
  consumption。`wait` 绑定本次 send 的 message sequence，并使用该 parent-turn observer signal，只返回该
  message 的 reply，或 `steered`、`cancelled`、`limit_reached` outcome。`delivery` 立即返回 acceptance，
  后续才执行 caller-owned delivery sink。

`pi-subagents` 的 model-facing `agent` tool 只把 queue delivery 映射为上述 core delivery sink。人类 UI 或 host
control 才可将 `{ kind: "delivery", mode: "steer" }` 映射为 sink；`mode` 是 adapter policy，不是 core
`ConversationReplyConsumption` 字段。

core 必须为两种 input mode 分配同一递增 message sequence。sequence 表示 acceptance identity，不承诺跨 lane
dispatch order：queue 与 steer 各自 FIFO，已接受 queue 永不因 steer 丢失，而 steer 在当前 child tool boundary
后优先于 queue。要清空或替换 queue 必须是独立、明确的 host/UI action，不能由 steer 隐式完成。`wait` 不是
单独的 main-agent wait/polling tool：它只存在于本次 `send` tool call。若该 parent turn abort，wait observer
立即结束，但不能取消 conversation 或 child message；child 最终 reply 必须 fallback 为 parent queue delivery，
避免静默丢失。

subscriber 显式选择 event kind，例如 text update、tool activity、turn state、terminal state。没有
subscriber 时，child outbound 不进入 parent context。每个 subscriber 有固定、非配置的 internal queue cap：
text、tool activity 与 turn state 可合并为最新 snapshot；terminal event 必须挤掉最旧的 coalescible item 进入
queue，永不因背压丢失。实现可选最小正确资料结构，不预先承诺 Ring Buffer；必须保持 bounded memory。只保证
已交付 event 的顺序，不保证每个中间 transition 都被保留；慢 callback 不得阻塞 child agent。subscriber
signal abort 时立刻 detach，并释放其 queue。

conversation 在自然 response 或单条 reply `limit_reached` 后保持 idle，直到 queue 中有下一条 message 或
caller cancel。reply outcome 不是 durable conversation handle 的 terminal result；后者仅在显式取消、失败或
parent lifecycle cleanup 时 settle。它不是无限 autonomous loop；需要自主完成工作的场景使用 `task`。

conversation handle 另外提供两项 **core-owned** session control：

- `compact()` 请求 core compact 它独占的 child session。它只可在 child idle 时运行；running、queued 或
  terminal conversation 必须拒绝，不能同 prompt/abort 并发。consumer 不拿到 raw session、message array 或
  Pi `CreateAgentSessionOptions`。compaction 的具体 Pi API、失败、取消和 session mutation 都由 core 处理。
- `usage()` 返回 core 从该 child 已完成 assistant turn 归一化出的只读累计 usage snapshot：input、output、total
  与 cost。缺失/无效 provider 数值归零。snapshot 是观测值，不是 billing ledger；terminal 后保留至 handle
  retention 结束。

这两项只服务于已存在的 long-lived conversation consumer，不能演化为任意 session inspection、message
 mutation、streaming telemetry 或 agent-policy API。Advisor 使用 `compact()` 保持原有 context budget policy，
 使用 `usage()` 显示累计 review cost；阈值和何时请求 compact 仍是 Advisor policy。

## 生命周期、取消与并发

每个 handle 严格绑定 parent session。`session_shutdown`、session switch、`/reload` 或 parent cancel
都会：阻止新 admission、abort active completion/task/conversation、reject queued send/wait、abort
in-flight delivery sink、detach subscriber、dispose child session 和清理 retained handles。sink 接收
dedicated abort signal；shutdown 不等待其 settlement，sink 必须在 signal abort 后不写旧 parent state，
late settlement 一律丢弃。没有跨 session 恢复、持久化 supervisor 或 orphan execution。

一个 runtime 只有一个 Root subagent coordinator。它对 completion、task 与 conversation 的 **active
turn** 使用同一个 root-session concurrency cap；queued work 保持 FIFO admission。此版本没有 per-mode
quota、priority scheduler 或 caller-owned pool。child session 不能创建 subagent；root 是唯一 budget、
cancellation tree 和 retention owner。

每个 direct consumer 可在 parent session start 提供当前 `maxConcurrent`，值必须是 positive integer。core
接受该 session 第一项 live configuration；后续 consumer 只能声明相同值，不同值是 collision error，不按
load order 替换或协商。首个 owner signal abort 会释放配置，因此 `/reload` 的 shutdown/start 会建立新
coordinator 并重新读取 setting。cap 不属于每个 task spec，core 也不设 hidden default。

每个 async continuation 都绑定 parent lifecycle signal 和 handle revision。terminal transition
idempotent：只会建立一个 terminal result、自动 delivery sink 最多执行一次、至多发送一次 terminal
event。explicit redelivery 是独立 caller operation；delivery failure 是 terminal result 后的独立状态，
不会重跑 task。

## 明确排除

本 contract 不包含：

- recursive/nested subagent；
- persistence、cross-reload/session recovery、durable scheduling；
- agent type discovery、frontmatter、model alias、prompt construction、skill/memory policy；
- worktree、transcript、statusbar/fleet/conversation UI；
- core-owned parent context injection、notification format 或 `pi.events` RPC；
- generic arbitrary worker、queue 或 message-bus API。

这些能力只有出现独立、已验证需求后才能另行提案；不得把 `conversation` handle 当作其隐式基础。

## 开发与验证

后续 interface framework 必须通过 root package export，并在 public JSDoc 说明 mode、ownership、
cancellation、delivery、retention、event loss、backpressure 与 cost。实现前需写 focused tests，至少覆盖：

- completion 不创建 child session；
- task required soft maxTurns、single wrap-up steer、fixed five-turn grace、`softLimitReached`、hard-ceiling
  `limit_reached` partial output、缺 sink reject、sync throw/async sink failure 无 unhandled rejection、shutdown
  abort、explicit redelivery 与单次 terminalization；
- conversation required soft `maxTurnsPerReply`、queue/steer input ordering、wait sequence binding、wait
   abort fallback queue、delivery reply、idle/restart、host steer preserves queue、subscriber detach、fixed-cap
   snapshot coalescing、terminal eviction/delivery、callback non-blocking、idle-only compaction rejection、
   compact cancellation、usage normalization 和 terminal snapshot retention；
- root shared cap、FIFO admission、root-only rejection、parent shutdown/reload cleanup 与 late result guard；
- duplicate core module instance 对同一 Pi runtime 共享 coordinator。

`pi-subagents` 另测试 context anchor、parent queue/human-or-host-only steer delivery 与 Task delivery group 的
全 terminal barrier；这些 adapter policy test 不属于 core execution suite。

所有 TUI 或 terminal delivery adapter 仍须由 owning extension 依据 `DESIGN.md` 做 focused narrow/wide
验证和实际 Pi/TUI replay 验证。
