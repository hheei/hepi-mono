# Subagent 执行架构

## 状态

本文记录已确认、尚未实现的 subagent execution contract。实现顺序固定为：本文与关联 ADR、
TypeScript interface framework、focused tests、行为实现。现有 `pi-subagents` 是迁移参考，
不是 API 兼容目标。

## 目标与所有权

`@hheei/pi-ext-core` 直接拥有统一的 root-session-scoped subagent execution runtime。它建立和清理
operation、child `AgentSession`、shared concurrency admission、cancel、terminal result 与 event
subscription；使用 core 的 extension 不能依赖 concrete `pi-subagents` package。

`pi-subagents` 保留 agent catalog、custom-agent/config/prompt/model resolution、tool/extension scope、
settings、TUI、transcript、worktree、schedule trigger 与 terminal delivery adapter。它在调用 core 前
解析这些 feature policy，并将结果作为 immutable execution spec 交给 core。core 不解析 agent name
或 frontmatter，不保存 settings，不注册 command/tool/UI，也不使用 `pi.events` 作为 RPC。

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
| `completion`   | 单次、无 tool 的模型生成；不创建 child session、transcript 或 input channel | caller 等待受限 completion result；用于 auto-title、分类、短摘要 |
| `task` | 有限、多轮、可使用已解析 tool policy 的 child execution；每项必填有限 `maxTurns` | 一个 terminal result；必须通过 delivery sink 自动交给 parent adapter |
| `conversation` | durable child `AgentSession`，但只存活于 parent session；create 时必填有限 `maxTurnsPerReply` | 可持续送入 message，并选择同步 wait 或异步 delivery reply |


foreground/background 不是第四 mode，也没有主 agent `wait` 或 result-polling tool。task launch 后立即
返回；parent 完成当前 turn 后空闲，terminal delivery 通过 event-driven follow-up 排入它的后续工作。
schedule/cron 是未来的 `task` trigger，不是新的执行 mode。

## Task Delivery

每个 `task` 在启动 spec 中必须声明 terminal delivery sink；没有 sink 不能启动。sink 是 caller/host
owned callback：它可把 terminal result
转换为下一轮 parent context、tool result、notification 或 UI；core 不规定内容格式，也不自动注入
主 session。

`pi-subagents` 是 parent delivery adapter。它默认以 Pi follow-up queue 追加 terminal result，使 parent
在当前 turn 结束后进入下一轮；caller 明确选择时才使用 Pi steer 在 parent 活动时重定向。该 delivery
mode 是 adapter policy，不是 core API，也不能与 parent-to-child conversation `send` mode 混用。

`pi-subagents` 也拥有 Task delivery group：caller 显式建立 group 后，barrier 收集所有成员的 terminal
result，仅在全部成员成功、失败、取消或达到 limit 后投递一次完整 aggregate。group 没有 partial timeout；
它不是第四 execution mode，也不进入 core。

sink reject 后，task 的 terminal result 不改变，只记录 `deliveryFailed`。core 不自动 retry，以免
重复写入主 session；caller 可用 stable task ID lookup retained handle，再做明确、幂等的 redelivery。
自动 delivery 最多执行一次；每次 explicit redelivery 是 caller 选择的新尝试。terminal handle 保留到
parent session shutdown，之后 stable ID 不再有效，也不持久化到下一 session。

每个 task 必填有限 `maxTurns`。达到上限时 core 建立 `limit_reached` terminal state，并停止该 task；
没有 unlimited task 或隐式 default budget。completion 的单次 response 是其固定执行上限。

## Conversation

conversation create 时必须声明有限 `maxTurnsPerReply`。conversation handle 才有 `send(message, options)`；
options 有两个正交选择：

- `inputMode: "queue" | "steer"` 是 parent-to-child input。`queue` 是默认，message 进入 FIFO queue，
  当前 child response 到达边界后才开始下一次 prompt。`steer` 是显式打断，使用 Pi 的 steer semantics，
  在当前 tool execution 后重定向 active child。
- `reply: { kind: "wait" } | { kind: "delivery", mode: "queue" | "steer" }` 是 child-to-parent reply
  consumption。`wait` 绑定本次 send 的 message sequence，只返回该 message 的 reply，或 `steered`、
  `cancelled`、`limit_reached` outcome。`delivery` 立即返回 acknowledgment，再由 `pi-subagents` adapter
  以 queue 或 explicit steer policy 交给 parent。

core 必须为两种 input mode 分配同一 message sequence，禁止 concurrent sender 依赖 timing 重排。`wait`
不是单独的 main-agent wait/polling tool：它只存在于本次 `send` tool call。若该 parent turn abort，wait
observer 立即结束，但不能取消 conversation 或 child message；child 最终 reply 必须 fallback 为 parent
queue delivery，避免静默丢失。

subscriber 显式选择 event kind，例如 text update、tool activity、turn state、terminal state。没有
subscriber 时，child outbound 不进入 parent context。每个 subscriber 有固定、非配置的 internal queue
cap：text、tool activity 与 turn state 可合并为最新 snapshot；terminal event 必须挤掉可合并 item 进入
queue，永不因背压丢失。只保证已交付 event 的顺序，不保证每个中间 transition 都被保留；慢 callback
不得阻塞 child agent。subscriber signal abort 时立刻 detach，并释放其 queue。

conversation 在自然 response 后保持 idle，直到 queue 中有下一条 message 或 caller cancel。它不是
无限 autonomous loop；需要自主完成工作的场景使用 `task`。

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
- task required maxTurns、`limit_reached`、缺 sink reject、sink failure、shutdown abort、explicit
  redelivery 与单次 terminalization；
- conversation required `maxTurnsPerReply`、queue/steer input ordering、wait sequence binding、wait abort
  fallback queue、delivery reply、idle/restart、subscriber detach、fixed-cap snapshot coalescing、terminal
  eviction/delivery 和 callback non-blocking；
- root shared cap、FIFO admission、root-only rejection、parent shutdown/reload cleanup 与 late result guard；
- duplicate core module instance 对同一 Pi runtime 共享 coordinator。

`pi-subagents` 另测试 parent queue/explicit steer delivery 与 Task delivery group 的全 terminal barrier；
这些 adapter policy test 不属于 core execution suite。

所有 TUI 或 terminal delivery adapter 仍须由 owning extension 依据 `DESIGN.md` 做 focused narrow/wide
验证和实际 Pi/TUI replay 验证。
