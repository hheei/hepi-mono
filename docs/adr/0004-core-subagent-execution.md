# Core Subagent Execution Contract

`@hheei/pi-ext-core` 将立即拥有 root-session-scoped subagent execution contract。这是已批准的
consumer exception：独立 extension 需要启动 child execution，但不能 import concrete `pi-subagents`。
已批准的 direct consumer 是 `@hheei/pi-mctx`：historian 的 no-tools completion（已实现）与 `/ctx-aug`
Sidekick 的受限 task child（本 ADR 批准同一 consumer 名下增加 task mode 使用）都通过 core 的
`startSubagent` 执行。`pi-subagents` 将迁移为 agent/config/UI/delivery adapter，而不是 shared
executor；其 active-turn budget 与 `pi-mctx` 以相同值共享同一 coordinator（同值加入不构成 collision，
见下文）。任何新的 direct consumer 都必须先经 ADR 更新或新 ADR 批准，不能借既有 consumer 通道静默加入。

## 后果

core 只拥有 completion、task、conversation handle 的 execution lifecycle、shared concurrency cap、
cancellation、terminal result、parent-session retention/lookup/redelivery 和 bounded snapshot event
subscription。task 必须有 finite `maxTurns`；它通过 consumer-owned resolved child-session factory 创建
child session，取得后独占其执行与释放。它不拥有 agent catalog、frontmatter、prompt/model/tool policy、
settings、worktree、schedule、transcript、TUI、notification 或 parent context injection，也不向 consumer
暴露 raw `CreateAgentSessionOptions`。

统一 handle 使用 discriminated mode；task 一律 launch-and-deliver，不提供 main-agent wait 或 result
polling tool。task `maxTurns` 与 conversation `maxTurnsPerReply` 都是 soft request cap：一次 wrap-up
steer、固定五个 grace turns，再在 hard ceiling abort 并保留 partial output。conversation send 将 child
input mode 与 reply consumption 分开，wait abort 后 reply fallback queue delivery。`pi-subagents` adapter
以 default queue/explicit steer policy 将 task terminal result 或 conversation delivery reply 交给 parent，
并拥有 all-terminal Task delivery group。child 不能嵌套 spawn，所有 handle 严格随 parent session
shutdown/switch/reload 清理。terminal delivery sink 接收 abort signal，shutdown 不等待其 settle 或自动
retry。`pi.events` 只可由上层 adapter 做 notification，不得成为 core RPC 或 message bus。

conversation create 同时声明第一条 child message 与其 wait/delivery reply consumption；不允许无 owner 的
自动 initial prompt。

conversation handle 可请求 core-owned idle compaction，执行当前 active turn 的 standalone `steer()`，
并读取 core-normalized 的累计 usage snapshot 与 bounded read-only transcript snapshot。这是 opaque session
boundary 的受限观察/控制能力：consumer 仍不接收 raw child session、messages 或 `CreateAgentSessionOptions`。
context budget、compact threshold 与展示/计费 policy 留在 consumer；core 只序列化 session mutation、
归一化 usage/transcript、处理 abort 与 terminal retention。

shared active-turn cap 由每个 direct consumer 在每个 session start 声明：第一项 live lifecycle
configuration 获所有权，之后仅相同值可加入，不同值是 collision error，owner abort 才释放。core 没有
per-task cap、hidden default 或 load-order replacement。

完整 contract、failure 与 concurrency semantics 见
[Subagent 执行架构](../architecture/subagents.md)。此 ADR 不授权再向 core 加入 generic worker、
