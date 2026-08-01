# Pi Subagents

## 目的

`@hheei/pi-subagents` 是独立 Pi extension，提供受配置约束的 child agent task。它解析 agent catalog、custom agent
frontmatter、model、system prompt、built-in/extension tool scope、worktree policy 与 parent-context inheritance，然后把
immutable child-session factory 交给 `@hheei/pi-ext-core` 的 root-session-scoped subagent coordinator。

它是 MCTX inheritance 和 Dreamer 的共同前置 consumer，但不属于 `pi-mctx`。MCTX 只发布 runtime-scoped context
projection；Subagents 决定哪一个 child profile 可以消费它。

## First Slice

首 slice 只暴露 model-facing `agent` task tool。每次调用必须有 task description、prompt、agent type 和有限
`maxTurns`；tool 立即返回 accepted operation ID。core 在 terminal 后调用 Subagents owned delivery sink，sink 通过
Pi follow-up queue 把带 operation ID、purpose、terminal state、soft-limit/partial 标记与 untrusted child output 的
anchor message 交给 parent 后续 turn。

首 slice 包含：

- built-in `general-purpose`、`Explore` 与 `Plan` catalog，以及 `.pi/agents/<name>.md` project override；
- profile/model/prompt/tool scope 的 deterministic resolution；
- core-required `ResolvedChildSessionFactory`，child session 的 create/dispose 不泄露给 callers；
- default queue delivery、parent lifecycle cancellation、root active-turn cap；
- `pi-subagents.max_active_turns` 是 user-only 1–8 integer setting，default `2`；project settings 不能提高 root
  concurrency，单一 task 的 `maxTurns` 仍必须由 tool input 明确提供；
- child factory 只使用 Pi public `createAgentSession` 与同一 agent directory 的 configured auth/model state；Pi 没有公开
  parent `ModelRuntime` transfer，因此只在 parent dynamically registered provider 中存在的 profile/model 明确拒绝，绝不
  private cast 或静默切换模型；
- `inherit_context` 通过 MCTX's runtime-scoped opaque boundary，并在 unavailable/stale 时 fallback 到 Pi native branch
  inheritance；
- focused tests for profile resolution、scope、factory ownership、delivery anchor、fallback and lifecycle cleanup。

## 明确不做

首 slice 不迁移 legacy `get_subagent_result` wait/poll tool、`steer_subagent`、resume、conversation viewer、widget、
Fleet UI、event-bus RPC、schedules、persistent agent memory、transcripts、worktree isolation 或 dynamic agent-management
UI。这些属于独立 capability；尤其 task execution 必须 launch-and-deliver，不能重新出现 main-agent wait/poll surface。

历史 `@hheei/hepi-subagents` 仅是 policy/source evidence，revision 见
[`references/README.md`](../../references/README.md)。其 public API、unlimited defaults、event RPC 和 UI 不是 compatibility
target。

## 依赖与验证

`pi-ext-core` owns execution admission、turn cap、terminalization、delivery failure handling、cancel 和 retention；
Subagents 不建立第二个 manager 或 queue。`pi-mctx` 可缺席：`inherit_context` 必须 fallback，不等待 Service。

本 extension 的 implementation 需先完成 profile/factory/test framework，再实现细节。每个独立 slice 运行 changed-path
Biome、affected tests 和 package build。tool delivery 或 TUI 行为只有经过 real Pi host/tui-replay 才能标记已验证。
