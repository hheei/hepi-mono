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
- child 初始为空，不继承 parent context。未来 `inherit_context` 只能在 MCTX projection Service 与其 Pi-native
  fallback 均已实现后加入，不能由当前 in-memory session 假称支持；
- focused tests for profile resolution、scope、factory ownership、delivery anchor、fallback and lifecycle cleanup。

## 明确不做

首 slice 不迁移 legacy `get_subagent_result` wait/poll tool、`steer_subagent`、resume、conversation viewer、widget、
Fleet UI、event-bus RPC、schedules、persistent agent memory、transcripts、worktree isolation 或 dynamic agent-management
UI。这些属于独立 capability；尤其 task execution 必须 launch-and-deliver，不能重新出现 main-agent wait/poll surface。

可编辑的 custom agent profile（`.pi/agents/`、`.agents/agents/` 与 global agents 目录中的 `.md`）在
Loadout 的 `Agents` group 里贡献 contributor-owned detail：identity 仍为 inline frontmatter 编辑，
model/thinking 继续合并为 cycler（`↑`/`↓` 选 model、`Tab` 循环 thinking）。`Description` action
的 value 固定为 `edit`，值列最右显示 `↵`；`Enter` 以当前值为 prefill 打开 Pi host 原生
`ui.editor()`。`Body` action 复用同一个 editor。`/loadout` 与 `/ext-settings` 的共享 router 都是
overlay；编辑期间临时隐藏并让出 focus，结束后恢复同一个 overlay，不实现或维护嵌入式多行编辑器。
提交结果只进入当前 scope 的 buffered draft；`Esc` 取消则不变。所有编辑在退出 Loadout 时一次性
flush 到 YAML（保留未知 key），detail 打开期间不写文件。detail 只负责 profile 文件的就地编辑，
不改变 spawn、factory 或 policy 所有权。
agent 的启停不是 frontmatter 字段：activation 由 Loadout 在 `agent:<name>` key 下管理（inherit /
enabled / disabled 三态，`Space` 切换、persist 到 settings JSON），agent Markdown 不再解析或写入
`enabled`。只有显式 enabled 的行提供编辑路径——inherit 与 disabled 行不显示 `↵ Edit config` 提示，
`Enter` 也不会打开 detail（没有 `↵ Edit config` footer 提示，行尾 `↵` 即表示可 Enter）。

内置默认 agent（`general-purpose`、`Explore`、`Plan`）同样提供 detail；由于它们没有 backing `.md`，
其 `Identity` 行只读（内置 agent 身份不可修改）。首次 flush 按当前 Loadout scope 生成 clone：Global
写入 Pi agent 目录的 `agents/`，Project 写入 `<cwd>/.pi/agents/`；frontmatter 携带当前编辑值，body
携带内置 system prompt，不写 `enabled` key。Global clone 仍在 Global 列表显示，不会因错误落成
project-private override 而消失。想把内置 agent 提前覆盖为 custom，在任意 custom 目录放同名 `.md` 即可。

保存位置按 Loadout scope 决定：project scope 的编辑总是落到 `<cwd>/.pi/agents/<name>.md`
（global 或内置 backing 不被改写；缺文件时 materialize 一个保留当前 system prompt 的 clone），
global scope 的编辑落到 agent 自己的 backing 文件；内置 agent 缺 backing 时在 Pi agent 目录
materialize。两个 scope 各自缓冲，同一 agent 在 global
与 project 分别编辑后各自落盘。header 的 `Path:` 行（`Status:` 后）显示当前 scope 的保存位置。

历史 `@hheei/hepi-subagents` 仅是 policy/source evidence，revision 见
[`references/README.md`](../../references/README.md)。其 public API、unlimited defaults、event RPC 和 UI 不是 compatibility
target。

## 依赖与验证

`pi-ext-core` owns execution admission、turn cap、terminalization、delivery failure handling、cancel 和 retention；
Subagents 不建立第二个 manager 或 queue。当前 `pi-mctx` 不参与 task slice；future `inherit_context` 需要 MCTX
projection provider 与 Pi-native fallback，且不得在 `session_start` 等待 Service。

本 extension 的 implementation 需先完成 profile/factory/test framework，再实现细节。每个独立 slice 运行 changed-path
Biome、affected tests 和 package build。tool delivery 或 TUI 行为只有经过 real Pi host/tui-replay 才能标记已验证。
