# pi-herdr 与 Pi subagent 扩展研究

> **状态**：历史研究。`packages/pi-subagents-herdr` 已从仓库移除；文中“当前实现 / 本仓库继续保持 Local/Herdr backend”不再是现行契约。研究证据与取舍仍可参考，但不能覆盖 [Subagent 执行架构](../architecture/subagents.md)。
>
> **研究边界**：只采用 GitHub/npm 上游仓库的 README、源码、issues/releases 作为外部事实。以下“当前”指链接所指的上游 `main` 或发布包页面；源码结论优先于 README 的功能叙述。文中对本仓库的判断针对当时的 `packages/pi-subagents-herdr`、`packages/pi-ext-core` 与架构文档。本文只记录研究和取舍，不是 TypeScript API 变更。

## 1. 结论先行

[事实] `nicobailon/pi-subagents` 与 `AndrewJacop/pi-herdr` 不是同一层的 runner：前者的普通 child 是 Pi session（foreground 在 parent 进程，background 在 detached runner），后者通过 Herdr CLI 启动独立 CLI/terminal pane。`pi-subagents` 的 Herdr integration 主要是状态/项目 pane/inspector 的桥接，不会把普通 child 透明改成 Herdr pane。[来源：`pi-subagents` extension API、observability；`pi-herdr` README 与 source]

[建议] 本仓库继续保持“一个 concrete extension 持有 provider policy + Local/Herdr 两个显式 backend”：`auto` 只在启动前探测失败时选 local；一旦选择 Herdr，启动/运行失败就失败，不得静默换 provider、模型或执行语义。当前实现已遵守这一边界，后续应优先补齐结果、状态和信任边界，而不是复制完整的 workflow/schedule 产品。

[明确拒绝] 不采用默认常驻 reviewer、模型自动切换、隐式 orchestration、主模型可选 provider、无界队列、跨 reload 的孤儿执行。它们与本仓库的 No hidden intent / no silent routing / visible composable primitives 相冲突。

## 2. 第一方来源表

| 来源 | 实际实现中核对的内容 | 第一方链接 |
|---|---|---|
| nicobailon/pi-subagents | detached runner、`status`/`bg_wait`、`runs.steer`/`follow_up`、artifact/replay、FleetView、mission/schedule、agent discovery、model/tool ceiling、RPC/external provider contract | [README](https://github.com/nicobailon/pi-subagents/blob/main/README.md) · [extension-api.md](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md) · [observability.md](https://github.com/nicobailon/pi-subagents/blob/main/docs/observability.md) · [tool-reference.md](https://github.com/nicobailon/pi-subagents/blob/main/docs/tool-reference.md) · [npm](https://www.npmjs.com/package/pi-subagents) |
| nicobailon/pi-subagents（源码） | RPC/structured delegation 的真实参数与校验，external run 只读 Fleet 投影，child event/artifact 生命周期 | [src tree](https://github.com/nicobailon/pi-subagents/tree/main/src) · [extension-api.md](https://raw.githubusercontent.com/nicobailon/pi-subagents/main/docs/extension-api.md) |
| AndrewJacop/pi-herdr | pane orchestration 工具、Herdr CLI error/timeout/abort、`agent get` 轮询、pane read、structured result、自报状态 | [README](https://github.com/AndrewJacop/pi-herdr/blob/main/README.md) · [herdr.ts](https://github.com/AndrewJacop/pi-herdr/blob/main/src/herdr.ts) · [orchestration.ts](https://github.com/AndrewJacop/pi-herdr/blob/main/src/tools/orchestration.ts) · [selfreport.ts](https://github.com/AndrewJacop/pi-herdr/blob/main/src/selfreport.ts) · [index.ts](https://github.com/AndrewJacop/pi-herdr/blob/main/src/index.ts) · [npm](https://www.npmjs.com/package/@andrewjacop/pi-herdr) |
| mjakl/pi-subagent（实质不同 extension #1） | 每次调用一组 `calls`，每个 child 是独立 Pi 进程；named session、parent/empty context、inactivity/absolute timeout、深度/循环 guard；`runner.ts` 的 JSON/RPC event 收集和 SIGTERM→SIGKILL | [README](https://github.com/mjakl/pi-subagent/blob/main/README.md) · [index.ts](https://github.com/mjakl/pi-subagent/blob/main/index.ts) · [runner.ts](https://github.com/mjakl/pi-subagent/blob/main/runner.ts) · [contract.ts](https://github.com/mjakl/pi-subagent/blob/main/contract.ts) · [npm](https://www.npmjs.com/package/@mjakl/pi-subagent) |
| amnn/pi-subagents（实质不同 extension #2） | 一个 markdown agent 对应一个 isolated `pi --mode json -p` 子进程；stdout newline-delimited JSON 白名单、事件进度、结果分类、临时 prompt 清理、取消升级；并发交给 Pi 的 sibling tool calls | [README](https://github.com/amnn/pi-subagents/blob/main/README.md) · [src/index.ts](https://github.com/amnn/pi-subagents/blob/main/src/index.ts) · [src/subagent.ts](https://github.com/amnn/pi-subagents/blob/main/src/subagent.ts) · [npm](https://www.npmjs.com/package/@am_n_n/pi-subagents) |
| earendil-works/pi 官方示例 | 官方示例的单/并行/链三种调用形状，`MAX_PARALLEL_TASKS=8`、worker concurrency=4、项目 agent trust、JSON mode child、50 KiB/task 输出截断、Ctrl-C 传播 | [README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md) · [index.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts) |
| 本仓库当前实现 | 当前 tool、provider policy、agent parser、Herdr result manifest、widget/surface、Local/Herdr 对接 | [extension README](../../packages/pi-subagents-herdr/README.md) · [feature.ts](../../packages/pi-subagents-herdr/src/feature.ts) · [types.ts](../../packages/pi-subagents-herdr/src/types.ts) · [local-backend.ts](../../packages/pi-subagents-herdr/src/local-backend.ts) · [herdr-backend.ts](../../packages/pi-subagents-herdr/src/herdr-backend.ts) · [agents.ts](../../packages/pi-subagents-herdr/src/agents.ts) · [ext-core subagents](../../packages/pi-ext-core/src/subagents.ts) · [execution architecture](../architecture/subagents.md) |

### 外部检索范围与未采用来源说明

[事实] 已检索 GitHub 上公开的 Pi subagent extension 仓库，并选取上表三个有源码的对照：mjakl 的“独立进程 + named persistent session”、amnn 的“单任务独立进程 + sibling 并发”、Pi 官方 example 的“调用形状/renderer 示例”。它们与 nicobailon 的 detached/workflow 产品和 AndrewJacop 的 pane 控制有实质差异，满足至少两个其他 extension 的对照要求。

[事实] `tintinweb/pi-subagents`、`jwu/pi-subagents`、`gee666/pi-subagent`、`rohaquinlop/pi-subagents` 等检索命中没有在本次证据集中使用：没有进一步采用未能从第一方当前源码确认的行为；不以二手文章补数。

## 3. 上游实现核对

### 3.1 nicobailon/pi-subagents：异步 runner 是完整生命周期，不是一个简单 `Promise`

[事实]

- foreground child 在 parent Pi 进程内，background child 在 detached runner；background runner 把 child 事件镜像到 `events.jsonl`、`output-<n>.log`、transcript 和 `status.json`。`agent_settled` 是 terminal watermark；普通 stdout 抓取不是其当前主协议。
- workflow 默认 async；`status` 是 executor-backed 的状态读取。`bg_wait` 是唯一 registered wait tool：blocking wait 可在 attention 或 terminal 返回；`nonBlocking:true` 返回 subscription token，后续由 completion/failure/attention/reconciliation 唤醒；window elapsed 不取消运行。
- workflow 内的 `runs.run`/`runs.all` 先受 workflow/runtime 校验，`runs.lanes` 组合有界 lane/stage；`runs.steer(key, message, {mode})` 只接受已经启动的稳定 key，支持 `steer`、`follow_up`、`auto`，返回 `queued/delivered/missed/failed` 等 receipt。RPC steer 明确关闭 pause-and-revive recovery。
- 结果与观测分开：`status.json`、`events.jsonl`、output log、session/output/artifact path 供机器读取；completion replay 和 output archive 是 watcher 重启/一次性 result 被删除后的短期补偿，而非永久 ledger。输出可 `file-only`，主模型只收到 bounded reference；workflow child 的 `outputReference`/`artifactPaths` 必须显式绑定，任务文字里写文件名不改变 output routing。
- FleetView/inspector 是 live observer；没有 TUI 时保留文本 `status` fallback 和显式 stop。external-run provider 只能注册 display-only Fleet 记录，provider 自己负责执行、持久化、取消和结果，不会因 FleetView 注册而获得 stop/steer/resume 权限。
- mission/schedule 是另一层 durable record。mission 记录 objective、run、artifact、receipt、decision 和 state，但 `mission.show` 不会替用户重启 child；schedule 默认 fresh/async，`overlap` 当前固定 skip，`run-due` 是外部 launcher，不是 daemon。Goal mission 只发 needs-attention notice，不自动 launch/replan。
- agent discovery 递归处理 builtin/package/user/project 来源，project precedence 与 project trust 生效；advertise 是 opt-in catalog，不等于自动 routing。模型选择按 per-run、provider-scoped override、agent override、frontmatter、global、parent 的顺序解析；model scope 只拒绝/警告越界模型，不替用户选便宜模型。tool/extension/MCP 同样是 resolved launch contract 的一部分。
- 生命周期在 session/reload/shutdown 时 abort active work、reject queued work、detach subscribers、清理 retained handles；没有跨 session 恢复 supervisor。`resume` 是 retained child 的显式 revival，保留 stored agent/model/tools/预算，不是重新解析一个全新角色。

[建议] 可吸收的是“有界状态证据 + 显式控制 receipt + file-only output reference”这三个窄能力；不可照搬 mission/schedule/workflow sandbox 的完整表面。

### 3.2 AndrewJacop/pi-herdr：pane 可见性和人类控制是 primary primitive

[事实]

- `herdr_start_agent` 先按 Herdr 版本和平台创建/拆 pane，再 attach agent；`herdr_send_prompt`、`herdr_wait_agent`、`herdr_read_agent`、`herdr_stop_agent` 等是独立操作；`herdr_delegate` 只是 spawn → send → wait → harvest 的组合。
- Herdr wrapper 使用 `spawn(..., shell:false)`，对每次 CLI 调用提供 timeout/AbortSignal，并把 JSON envelope/error 映射成统一 error code；Herdr 不可用返回 `HERDR_UNAVAILABLE`，不无限等待。
- `herdr_delegate` 的完成观察不是单一 TUI 猜测：`pi-herdr` 每 2 秒读取 pane 文本做进度，并轮询 `agent get`；在被启动的 Pi 内，`selfreport.ts` 将 `agent_start`/`agent_settled` 与 `herdr:blocked` 映射为 working/idle/blocked。`agent_settled` 而非 `agent_end` 才是稳定 idle 信号。
- 结果可靠性由 extension 自己的临时 manifest/result 文件补强：manifest 含 nonce、system prompt、result path；child 将结构化 `{nonce,status,output,usage,failure}` 写入 result；parent 只在 nonce 匹配且字段有效时 terminalize，pane 文本仅用于 progress/失败诊断。成功后默认关闭 extension 创建的 pane；`closeOnSuccess` 是上游独立工具的可选行为。
- 可见 pane 意味着用户能 attach、输入、发 `Ctrl-C`、处理 blocked ask_user；它也带来独立 CLI 的 cwd、凭证、model/provider 和 extension 环境。README 明确记录版本/API、Windows shim、macOS PATH 等平台问题，Linux 只是预期支持而非 README 中的已验证平台。

[建议] 本仓库只移植“可见 pane + 可校验结构化结果 + 人类可取消”所需窄边界；不把 Herdr 全部 layout/worktree/fleet introspection 工具暴露到 `subagent`。

### 3.3 其他 extension 的实证差异

#### mjakl/pi-subagent

[事实] `index.ts` 的 public schema 是一个 `calls` 数组（1–8），一组 sibling calls 并发；`runner.ts` 为每项启动独立 `pi` 进程，prompt 通过 mode 0600 临时文件，使用 JSON/RPC event stream；child 进程失败、协议异常、模型 stopReason、父 signal abort 都进入 normalized result。inactivity timeout 只观察 child RPC stdout，absolute timeout 独立；Unix 取消升级 SIGTERM→SIGKILL。`session` 是按 parent session + cwd + agent name 派生的 persistent child session handle，另有 session lock 防并行占用；`initialContext: parent` 明确克隆 parent snapshot，默认 empty。`contract.ts` 明确说 session preference/hint 只是 advisory，不会自行创建 durable session。深度和循环 guard 通过环境变量传播。

[价值判断] named session、inactivity 与 absolute deadline 是可复用的语义分解；其“每次都独立 Pi 进程”不能直接当作本仓库 Local backend，因为本仓库 local contract 明确是 in-process `AgentSession`。

#### amnn/pi-subagents

[事实] `src/subagent.ts` 是更小的单任务执行器：创建临时 system prompt，启动 `pi --mode json -p --no-session --no-extensions`，逐行验证一组已知 event/message/stopReason，捕捉 progress，遇到 parent abort 时终止子进程并在 grace 后强杀，最终清理临时 prompt。`src/index.ts` 把每次工具调用当作一个 child/lifecycle/result/renderer row；多个 sibling tool calls 的并发调度交给 Pi，而非自己实现 queue/workflow。README 的 tests 也覆盖 protocol、outcome、cancellation、cleanup、output truncation。

[价值判断] 这证明“窄单任务 contract + 严格 event allowlist + 结果截断”能比 workflow DSL 更容易审计；但它不提供 background wait、resume 或 durable mission，不应被误解为这些能力已被验证。

#### Pi 官方 example

[事实] 官方 example 同样以独立 `pi` JSON child 为基础，源码直接实现 single/parallel/chain，固定最多 8 task、4 worker 并发；project agent 需要 trust/显式 `agentScope`，child 使用 `--no-session --no-extensions`；每 task 的 model-visible output 上限 50 KiB，Ctrl-C 传播到 child process。它提供 rich renderer/usage/tool activity，但没有 nicobailon 的 durable async runner、mission 或 resume。

[建议] 官方 example 与 amnn 的共同低层结论是：child prompt、event、output 和 abort 必须有明确 owner；并发、chain、renderer 都应是 consumer policy，而不是隐式放入通用 core。

## 4. Feature matrix

符号：`✓` 已由源码确认；`~` 只有局部/不同语义；`—` 未发现该能力；`显式` 表示调用者必须选择，不能由 model 猜测。

| 候选能力 | nicobailon/pi-subagents | AndrewJacop/pi-herdr | mjakl / amnn / 官方 example | 本仓库当前实现 | 取舍 |
|---|---|---|---|---|---|
| 非阻塞 spawn + wait/poll | `async` background；`status`、`bg_wait`（blocking/nonBlocking subscription） | `start` 即返回 pane；`wait_agent`/`agent get`/poll | sibling tool 调用并发，但无 durable wait（mjakl child call 本身等待） | `spawn` 立即返回；completion 自动 follow-up；无 wait/poll action | Adopt now：保留 spawn 即返；延后 public wait，先补状态证据 |
| admission/queue | root/active、pending、workflow child/spawn caps，均有界 | delegate calls 可并发，README 未定义 shared queue | 官方固定 8/4；amnn 交 Pi sibling；mjakl 同一 persistent session lock 冲突 | ext-core shared coordinator：active 8、pending 16、retained 32，FIFO | Adopt now：共用 core admission；拒绝无界 workflow queue |
| follow-up/steer | `runs.steer` stable key，`steer/follow_up/auto` receipt；RPC non-recovering | 人类可直接 pane 输入/keys；无统一 child message queue | mjakl named session 续调用；amnn/官方无 steer | core conversation 有 queue/steer，但 concrete tool 仅 task leaf | Defer：先做 human/host-only explicit control；拒绝 model-facing hidden steer |
| 结果回送 | completion event、follow-up delivery、replay/archive；失败仍带每 child result | delegate harvest；pane text 不是结构化成功证据 | normalized result；官方/amnn renderer/tool result | 200ms batch `pi.sendMessage(... deliverAs: followUp)`，terminal once | Adopt now：保持 anchor/status/output/failure；补 delivery failure 观测 |
| output/artifact | output path/file-only、bounded result/archive、artifact paths | nonce result.json；可选 transcript；成功默认清理 run dir/pane | temp prompt 0600、50 KiB model output（官方/amnn），无 durable result ledger | Herdr nonce result + optional transcript；local output 只在 retained handle/parent delivery | Adopt now：统一 bounded output/reference；Defer durable archive；拒绝 raw terminal 当成功证据 |
| 可观测性 | FleetView、inspector、status artifacts/events、无 TUI text fallback | pane visibility、agent status、pane read、自报 blocked/idle | progress/usage/rich renderer，未提供 fleet ledger | above-editor widget；`/subagents` TUI surface；tool status JSON；非 TUI 命令明确 warning | Adopt now：status/summary 在 TUI 与 no-TUI 一致；Herdr pane 保持可见 |
| 取消/清理 | stop/interrupt、process/child abort、runner cleanup；shutdown 清理 | stop/close pane、CLI abort、Herdr wrapper timeout/abort | SIGTERM→SIGKILL、temp cleanup；官方 Ctrl-C | core cancel/dispose；Herdr finally close managed pane；local session dispose | Adopt now：幂等 terminal/cleanup；记录 prompt-accepted 边界，禁止失败后重复 spawn |
| resume/reload | retained child `resume`；mission durable，但 reload 不盲重启 | pane 可继续 attach，但不是本 extension 的统一 resume protocol | mjakl named session 可续；amnn/官方 `--no-session` | parent-session scoped，shutdown/reload 清空 runs/panes，无 resume | Defer：只设计显式 resume contract；Reject orphan pane/静默恢复 |
| role discovery | builtin/package/user/project 递归、trust、precedence、advertise opt-in | agent kind 来自 live Herdr catalog；不是 markdown role discovery | mjakl discovery + starter + project trust；amnn markdown；官方 trust scope | builtin + user + `.agents`/`.pi/agents` 递归，覆盖规则；无 project trust/package roots/advertise | Adopt now：保留显式角色目录；补 project trust/invalid diagnostics；拒绝 starter file side effect |
| 权限和模型策略 | launch contract、tool/extension/MCP allowlist、model scope/ceiling；失败不自动换模型 | agent kind/cwd/env/args 进入真实 CLI，继承自身凭证 | mjakl agent model/tools，`noTools`；官方 agent model/thinking，project trust | agent frontmatter 解析 model/thinking/tools/extensions/skills；local no ambient extensions；Herdr 显式传 model/tools | Adopt now：继续 consumer-owned resolution、显示 provider/model/reason；Defer model scope；拒绝 auto model/provider switch |
| 窄屏/TUI/no-TUI | FleetView/inspector；无 TUI 仍 text status/explicit controls | pane 是外部可见 surface；Pi footer best effort | rich renderer，输出有 50 KiB cap；官方 TUI only example | `truncateToWidth` widget/surface；`/subagents` 非 TUI notify warning；tool status 可无 TUI | Adopt now：窄屏截断和命令 fallback；拒绝依赖 TUI 才能知道终态 |
| missions/schedules | durable mission/schedule、receipts/state、但不自动 replan | 无对应产品 primitive | 无 | 无 | Reject now：超出 task leaf；若有需求另立 proposal |

### 4.1 候选能力逐项 contract ledger

为避免 matrix 只变成“功能名称对照”，每个候选能力按同一格式写出：**用户价值；状态/取消/失败语义；所需 public contract；当前差距；结论**。

#### C1 非阻塞 spawn 与 wait/poll

- **用户价值**：parent 不被长任务占住，同时仍能明确知道 queued/running/blocked/terminal。
- **状态/取消/失败**：spawn 返回 acceptance 与 opaque id；wait 是观察，不是取消；超时窗口到期返回 `window_elapsed` 但 run 继续；cancel 才产生 cancelled terminal。启动失败不能变成“仍在运行”。
- **所需 contract**：`start()` 立即返回 handle；`snapshot()`/`wait(id, timeout)`；`wait` 的 attention、terminal、window elapsed 分支；parent shutdown 的 abort 规则。
- **当前差距**：本仓库已有立即返回和自动 follow-up，但没有 public wait/poll；status 只读内存 snapshot。
- **结论**：[采用] 保留非阻塞 spawn；[延后] wait/subscription，先把 terminal evidence 做完整。

#### C2 并发 admission 与 bounded queue

- **用户价值**：并发任务不会无限消耗模型、进程、pane 或内存；同一 root 的多个 consumer 具有可预测上限。
- **状态/取消/失败**：admission 成功才可创建 child；pending 满时显式拒绝；queued cancel 不创建 child；terminal 只发生一次；不同 backend 共享同一 cap。
- **所需 contract**：core-owned `maxActive/maxPending/maxRetained`、FIFO 规则、queued removal、collision/configuration failure；backend 不得再维护隐式第二队列。
- **当前差距**：ext-core 已有 active=8/pending=16/retained=32 和 FIFO；concrete 只需让 status/错误说明这些边界，不应引入 workflow queue。
- **结论**：[立即采用] 继续使用 core coordinator；[拒绝] 无界 queue 或 Herdr/local 各自排队。

#### C3 follow-up / steer

- **用户价值**：人类可挑战正在运行的 child，或给 durable child 发送下一条消息，而无需重复执行初始任务。
- **状态/取消/失败**：steer 只能命中 active turn；follow-up 可排队到下一边界；receipt 必须区分 queued/delivered/missed/failed；控制通道失败不重跑原 task；parent wait abort 不取消已接受的 child message。
- **所需 contract**：稳定 `runId` 或 `(runId, messageSequence)`、调用方身份（human/host）、mode、ack timeout、队列顺序和 shutdown 语义。model-facing tool 不应自选 steer。
- **当前差距**：core conversation 已有 queue/steer，但 concrete 只公开 task leaf；Herdr 用户可在 pane 输入，却没有统一 receipt。
- **结论**：[延后] 先做 host/UI-only explicit control；[拒绝] 让 parent model 根据隐藏状态自行 steer。

#### C4 结果回送与 delivery

- **用户价值**：异步完成后 parent 能收到一次可识别、可评估的结果，而不是依赖用户手动轮询。
- **状态/取消/失败**：terminal result 与 delivery 是两个状态；delivery 失败不改变执行结果，不自动重跑；batch 只能延迟不能丢失；wrapper 必须含 id、任务目的、status 和 partial/failure。
- **所需 contract**：caller-owned sink、一次 terminalization、一次自动 delivery、显式 redelivery（且不重跑）、parent-session ownership、sink abort signal。
- **当前差距**：feature 已用 200ms `deliverAs: "followUp"` 批量回送，但没有 deliveryFailed 字段和显式 redelivery。
- **结论**：[立即采用] 固化 anchor/一次性语义；[延后] redelivery，直到 retention/status 可稳定查找。

#### C5 output/artifact

- **用户价值**：大结果不塞满 parent context，且 workflow/人类可通过明确路径继续读取证据。
- **状态/取消/失败**：inline output 有 byte/line 上限；file-only 只返回 reference；artifact 写入失败是可见失败；任务文本中的文件名不能覆盖 runtime output binding；Herdr terminal text 不是成功证据。
- **所需 contract**：`outputMode`、bounded limits、runtime-owned path、0600 权限、artifact retention、`outputReference`/truncated 标志、删除时机。
- **当前差距**：Herdr 已有 nonce manifest/result 和可选 transcript；local 结果主要留在 core handle/parent delivery，没有对称的显式 output reference。
- **结论**：[立即采用] structured-result-first 和 bounded output；[延后] local file-only/reference；[拒绝] 以 pane tail 或任意 stdout 代替 terminal artifact。

#### C6 状态可观测性

- **用户价值**：无需猜测 child 是否活着、卡住、等待人类或已失败，并能在窄屏/无 TUI 下诊断。
- **状态/取消/失败**：progress 可合并、terminal 不可因背压丢失；`blocked` 必须区别 `running`；observer abort 只解绑；observer 不拥有 stop 权限；状态读取失败显示 unknown/stale 而非 completed。
- **所需 contract**：bounded `RunSnapshot`、lastUpdate/phase/tool、terminal reason、provider/model、status view 和 no-TUI text fallback；TUI 是 observer，不是 source of truth。
- **当前差距**：widget、`/subagents`、tool status 已存在；`/subagents` 在 no-TUI 只 warning，且无 transcript/status artifact。
- **结论**：[立即采用] 统一 snapshot 与 no-TUI status；[延后] richer inspector；[拒绝] 依赖 TUI 推断终态。

#### C7 取消与清理

- **用户价值**：Ctrl-C、stop、shutdown 后不残留 child、pane、timer、listener 或临时凭证文件，也不重复执行。
- **状态/取消/失败**：cancel 幂等；queued cancel 为 cancelled；active cancel 先 abort/stop 再清理；Herdr close 和 local dispose 都必须在 finally；已接受 prompt 后的启动失败不能自动 fallback。
- **所需 contract**：AbortSignal ownership、process/pane stop escalation、prompt-accepted marker、idempotent cleanup、late result discard、single terminal transition。
- **当前差距**：core cancel/dispose 与 Herdr finally close 已覆盖主路径；prompt accepted 与 cleanup failure 尚未成为公开 snapshot 字段。
- **结论**：[立即采用] 强化幂等/失败可见；[拒绝] timeout 后盲目再 spawn。

#### C8 resume/reload

- **用户价值**：长任务或多轮 specialist 可在明确授权下继续，不必丢失历史。
- **状态/取消/失败**：resume 是新 control operation，不是新角色猜测；必须校验 parent/session ownership、exclusive lease、stored model/tool contract；reload 无法证明 child 状态时应 fail closed，不能从 artifact 存在推断完成。
- **所需 contract**：稳定 retained id、resume target、lease、stored launch digest、跨 reload artifact/replay、stale/foreign/not-resumable 分类。
- **当前差距**：当前 runs 与 panes 都绑定 parent lifecycle，dispose/reload 清理；没有 durable ledger 或 resume。
- **结论**：[延后] 先完成 explicit named conversation contract；[拒绝] orphan pane 或无提示自动恢复。

#### C9 role discovery

- **用户价值**：角色定义可覆盖、可解释、可在项目/用户范围复用，且不会把未信任仓库指令直接执行。
- **状态/取消/失败**：discovery 失败要报告 source/path；project trust 失败应拒绝或降级为 user-only；同名覆盖规则稳定；reload 刷新 catalog，不应自动写 starter agent。
- **所需 contract**：source precedence、scope/trust、name validation、package roots、advertise（仅发现，不授权）、invalid/missing skill/extension diagnostics。
- **当前差距**：当前递归 builtin/user/`.agents`/`.pi/agents` 并按顺序覆盖，但 project agent 没有 trust gate，也没有 package roots/advertise。
- **结论**：[立即采用] 诊断与显式目录；[延后] trust/package discovery；[拒绝] 首次启动自动创建 agent 文件。

#### C10 权限与模型策略

- **用户价值**：每个 child 的模型、工具、extension、skill、cwd 和凭证边界可审计，provider 故障不会偷偷改变行为。
- **状态/取消/失败**：resolve 后产生 immutable launch contract/digest；缺 model、auth、tool 或 extension 应在 launch 前失败；429、timeout、invalid response 属于该 provider 的 terminal failure；切换模型必须是新显式操作。
- **所需 contract**：consumer-owned policy、resolved provider/model/tools、capability ceiling、cwd/extension validation、selectionReason、无 raw credential/自由 shell 拼接。
- **当前差距**：当前 frontmatter 解析 model/thinking/tools/extensions/skills，local 禁 ambient extensions，Herdr 显式传 model/tools；暂无 model scope/digest，project trust 也不足。
- **结论**：[立即采用] 显示 resolved provider/model/reason 并保持显式 policy；[延后] scope/digest；[拒绝] automatic model/provider switching。

#### C11 窄屏、TUI 与 no-TUI

- **用户价值**：状态在全屏 TUI、窄 terminal、headless/JSON host 均可用；用户不因 UI 不在场而失去控制面。
- **状态/取消/失败**：renderer 只能截断/折叠，不得丢 id/status/error；no-TUI 需要文字 status/stop fallback；TUI surface 不可成为 lifecycle owner。
- **所需 contract**：宽度安全 renderer、bounded line lengths、结构化 status、明确 `requiresTui` 的 surface 行为、相同 run source of truth。
- **当前差距**：widget/surface 使用 `truncateToWidth`，但 `/subagents` 非 TUI 仅 warning；Herdr pane 可见性本身只能在存在 Herdr 时提供。
- **结论**：[立即采用] no-TUI status 与窄屏截断；[拒绝] 把 TUI/pane 可见性当作唯一状态来源。

## 5. 对照 ext-core 与当前 concrete extension

### 当前已经相符的 contract

[事实]

- `pi-ext-core` 的 `startSubagent` handle 立即返回，mode 分为 completion/task/conversation；task 必须有有限 `maxTurns`，core 独占 admission、cancel、terminalization、dispose。
- root coordinator 的 shared budget 是 `maxActiveTurns: 8`、`maxPending: 16`、`maxRetainedTerminal: 32`；pending 满时拒绝，不用无界队列换吞吐。task terminal delivery 是 caller-owned sink，delivery 失败不改变 terminal result。
- concrete extension 负责 agent/frontmatter、model、tool/extension/skill、prompt、worktree/UI/delivery；child session factory 是 immutable boundary。core 不拥有 agent discovery、model policy、TUI 或通用 event bus。
- 当前 feature 的 `subagent` schema 只有 `spawn/status/stop`，prompt 上限 32,000 字符；spawn 解析 role/config/provider/model 后调用 core task；local factory 禁用 ambient extensions/skills/prompt templates/themes，并只加载 definition 明确列出的资源。
- `auto` 只有在 `HERDR_ENV`、`HERDR_PANE_ID`、`herdr --version` 与 `herdr agent list` 同时通过时选择 Herdr；否则记录 fallback reason 并选择 local。`herdr` strict mode 不可用即拒绝。Herdr 已选定后运行失败不会转 local。
- Herdr backend 将成功判定绑定到 nonce-matched `result.json`；pane text 仅作 progress；取消/成功在 finally 关闭由本 extension 创建的 pane；`outputTranscript` 才保留 bounded transcript。
- 终态通过 core result 进入 200ms completion batch，使用 `deliverAs: "followUp"` 触发 parent 后续 turn；run snapshot 显示 id、agent、provider、model、status、pane、progress、artifact、selection reason、output/failure。

### 明确差距

[事实]

1. concrete 现在只有 task leaf；core 虽有 conversation 的 queue/steer/usage/transcript，tool 没有显式 follow-up/steer，也没有 resume。
2. 当前 runs map 是内存 session state；`dispose` 清掉 runs、delivery、retention timers 和 managed panes，没有 cross-reload artifact/replay/recovery。
3. 当前 `/subagents` 只在 TUI 打开，no-TUI 仅发 warning；工具的 status 是可用 fallback，但没有独立 Fleet inspector/transcript view。
4. 当前 local result 没有和 Herdr result 对称的 output file/artifact reference；`RunSnapshot.artifactPath` 主要来自 Herdr 临时目录。
5. 当前 discovery 会直接递归读取 project `.agents` 与 `.pi/agents`，没有像 mjakl/官方 example 那样使用 project trust 作为执行门槛；也不读取 package-exported agent roots 或 advertise catalog。
6. 当前 schema 不允许调用者传 model/tool policy；这是有意的 consumer-owned policy，但应在 status/result 中继续显示 resolved model/provider，而不是让 model 在 tool 参数内隐式路由。
7. 当前 Herdr probe 每次 spawn 执行一次 `version`/`agent list`，没有 session-start cache；README 的“每次 spawn 探测一次”与源码一致，但不能把它表述成跨 spawn cache。

## 6. 按价值/风险排序的决策清单

### Adopt now（高价值、低边界风险）

1. **统一 terminal envelope 与 delivery anchor**：每个 terminal result 至少有 `id`、`provider`、resolved `model`、`status`、`output`、`failure?`、`softLimitReached`/partial 标志和 delivery 状态；parent wrapper 明确“这是 delegated result，先判断与当前用户请求是否相关”。不把 child prose 当 authority。
2. **统一 bounded progress/status snapshot**：延续当前 RunSnapshot，增加可选 `lastUpdate`、当前 phase/tool、terminal reason；所有字符串/事件有上限，terminal event 不因 progress 背压丢失。TUI widget、`/subagents` 与 no-TUI `status` 只消费同一 snapshot。
3. **保持并强化 core shared admission**：local/Herdr 共用 active=8、pending=16、retained=32；spawn 在 pending 满时显式失败；取消 queued operation 不创建 child/pane。不要复制 per-backend queue。
4. **保持 structured-result-first**：Herdr 使用 nonce-bound result；local 使用 core normalized result；terminal pane text/child stdout 只作诊断。为 malformed/missing/nonce mismatch 返回明确 failed，不自动 retry。
5. **显式 cancellation/cleanup contract**：`cancel`、parent shutdown、Herdr pane close、临时 manifest/transcript cleanup 都幂等；记录 prompt 是否已发送。Herdr start 后失败不自动启动 local，避免双执行。
6. **窄屏与 no-TUI 对称 fallback**：widget/surface 使用宽度截断；`/subagents` 在无 TUI 时明确说明“查看工具 status”，不要静默无输出。状态必须不依赖 pane UI。
7. **角色/资源诊断而非自动 side effect**：保留现有 `.pi/agents` 与 user/builtin precedence；对无效 frontmatter、missing skill/extension、recursive self-load 给 bounded diagnostic。project role 是否可执行应增加显式 trust policy，而不是首次运行自动写 starter 文件。

### Defer（有价值，但需新的 public contract/测试）

1. **显式 `wait` / non-blocking subscription**：先定义 `wait(runId, {timeoutMs, stopOnAttention})` 是观察而非取消；`window_elapsed` 必须明确仍在运行。没有 durable completion replay 前不承诺跨 reload wait。
2. **host/UI-only `steer` 与 `follow-up`**：只允许人类 UI 或可信 host control，目标用稳定 `runId`/message sequence；返回 `queued/delivered/missed/failed` receipt。model-facing `subagent` schema 不暴露 steer。
3. **local output/artifact reference**：提供显式 `output`/`outputMode`，bounded inline + mode 0600 file-only reference；路径由 runtime 绑定，任务文字不能改 routing。先只做当前 parent session retention，不引入 durable mission ledger。
4. **目标化 transcript inspection**：提供 bounded transcript tail/status view，过滤 filesystem path/secret；没有 TUI 时用结构化 text。不要把 raw `AgentSession` 或任意 filesystem read 暴露给 caller。
5. **named conversation/resume**：参考 mjakl 的 parent/cwd/agent scoped session handle 和 core conversation，但需定义 exclusive lease、reload failure、stored model/tool contract、cancel/cleanup。第一版只允许显式 `resume`，不因 stop/timeout 自动 revival。
6. **project trust 与 package agent discovery**：采用 trust gate 和来源/覆盖诊断；不复制 nicobailon 的完整 runtime management、eject/disable/refinement 表面。
7. **Herdr self-report bridge**：在 child 明确加载 extension 时同步 `agent_start`/`agent_settled`/blocked；没有 self-report 时保留 polling fallback，并将“observed vs unknown”显示出来。该能力只能在 Herdr backend，本地 backend 映射为 core turn state。

### Reject（明确不采用）

1. **默认常驻 reviewer/watchdog**：reviewer 必须由用户/项目 workflow 显式请求；安装 extension 不启动后台工作。
2. **自动模型/provider fallback 或 tier routing**：model/provider 由 consumer policy 解析并显示；429、auth、timeout 都是该次 run 的失败，重试或改模型是新的显式操作。
3. **隐藏 orchestration / 自动 chain**：不根据普通 prompt 私下 spawn；chain/parallel 只有明确的 visible primitive 和 bounded result group 才能加入。
4. **mission/schedule/goal/cron**：当前 task leaf 不需要 durable scheduler；它们需要存储、reload、权限、delivery receipt 的独立设计，不能借 conversation handle 偷渡。
5. **把 `pi.events` 当跨进程 RPC**：local 同进程事件只能用于 core/consumer；Herdr 使用 CLI/socket/nonce result 等明确跨进程边界。
6. **Herdr pane 永久 orphan 或无提示恢复**：可见 pane 的 attach/resume 必须是显式配置；默认 session shutdown 关闭 extension 创建的 pane，不留下不可追踪副作用。
7. **把 FleetView 注册当控制权**：观察记录不自动获得 stop/steer/resume；external/provider adapter 必须声明 owner 与权限。

## 7. 结论

`pi-herdr` 与 `pi-subagents` 是互补 execution backend；Herdr availability 不能只看 `HERDR_ENV=1`；不能以同名 tool 让两个 extension 竞争；Herdr/Local 的上下文、工具、模型、凭证和取消语义不天然相同；child 递归加载需要明确禁止；跨进程结果必须走显式协议；fallback 必须发生在副作用之前。
