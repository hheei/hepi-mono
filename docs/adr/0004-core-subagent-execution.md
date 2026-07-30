# Core Subagent Execution Contract

`@hheei/pi-ext-core` 将立即拥有 root-session-scoped subagent execution contract。这是已批准的
单-consumer exception：独立 extension 需要启动 child execution，但不能 import concrete
`pi-subagents`。`pi-subagents` 将迁移为 agent/config/UI/delivery adapter，而不是 shared executor。

## 后果

core 只拥有 completion、task、conversation handle 的 execution lifecycle、shared concurrency cap、
cancellation、terminal result、parent-session retention/lookup/redelivery 和 bounded snapshot event
subscription。task 必须有 finite `maxTurns`；它不拥有 agent catalog、frontmatter、prompt/model/tool
policy、settings、worktree、schedule、transcript、TUI、notification 或 parent context injection。

统一 handle 使用 discriminated mode；background 是 task consumption/delivery，不是第四 mode。child
不能嵌套 spawn，所有 handle 严格随 parent session shutdown/switch/reload 清理。terminal delivery sink
接收 abort signal，shutdown 不等待其 settle 或自动 retry。`pi.events` 只可由上层 adapter 做
notification，不得成为 core RPC 或 message bus。

完整 contract、failure 与 concurrency semantics 见
[Subagent 执行架构](../architecture/subagents.md)。此 ADR 不授权再向 core 加入 generic worker、
