# pi-subagents：投递、观测与 widget

本文件是对 maplezzk/HazAT `pi-interactive-subagents`（MIT，`7a5c96b`）的**有选择借用计划**。原设计仍以 [`PLAN.md`](PLAN.md) 为准；当前合同以 [`spec.md`](spec.md) 为准。实施状态以 [`tickets.md`](tickets.md) 的 `SUB-P*` 为准。

目标：把他们已经做对的**话术、interactive 策略位、widget 投影**接到现有 RPC 运行时上。不替换 runner、LaunchSpec、registry、IPC。不引入第二套文件总线。

## 1. 用户可见目标

主 Pi 在 spawn 之后不再靠模型轮询 `get_subagent` / `list_subagents` 等待结果。Child 用 `contact_parent` 报告；忘记报告时 child 侧 nudge。输入框上方的 widget 只投影 registry 里的活 child，无边框。Interactive child 除 `contact_parent` 外不自动叫醒 parent。

主数据流不变：

```text
spawn_subagent → persist → runner → pi --mode rpc
contact_parent → runner IPC → ParentChannel → sendMessage(triggerTurn)
widget ← PublicSubagent（list / live events）
```

## 2. 借用规则

直接复用优先于抽取，抽取优先于复制。本次允许的复制仅限下列文件，并在文件头保留 HazAT 版权与 MIT 声明，注明修改自：

`https://github.com/maplezzk/pi-extensions/tree/7a5c96be138158a5cf6413ac819509eff12b1ccd/packages/pi-interactive-subagents`

| 上游 | 落到 | 改什么 |
| --- | --- | --- |
| `index.ts` 里 `subagent` 工具的 description / promptSnippet | `packages/pi-subagents/src/tools.ts` | 改成 RPC 语义，保留「不要轮询、结果会送回来」 |
| `subagent-done.ts` 的 `scheduleAgentEndNudge` | `packages/pi-subagents/src/child-nudge.ts` | 提醒调用 `contact_parent`，不写 `.exit`，不退出 session |

**明确不复制：** `activity.ts`、`status.ts`、边框 widget、`launchSubagent`、`sendLongCommand`、mux 配置、`/plan`、bundled agents、`caller_ping`、`subagent_done`、`subagent_resume`、Escape interrupt、`__pi_subagents`、`hiddenFromWidget`、`/config:subagent extensions`。

仓库规则禁止在 `packages/` 下 vendor 整个上游仓库。只收最小文件并记录 revision。

## 3. 五项对照与合同

### 3.1 完成投递话术

现状：`spawn_subagent` 描述只有 “Start an independent RPC subagent.”；`contact_parent` 只有 “Report progress…”。Parent 投递已是 `pi.sendMessage(..., { triggerTurn: true, deliverAs: "nextTurn" })`。模型没有被禁止轮询。

保留现有行为：

- spawn **仍然等到 runner ready** 再返回。不改成 maplezzk 的 fire-and-forget pane 启动。
- 不新增 `subagent_done`。Child 活着，完成靠 `contact_parent`。
- 投递继续 `deliverAs: "nextTurn"`。不改成 `steer`：parent 正在跑时不打断当前 turn。

要改的是话术和 child 忘记报告时的 nudge：

- `spawn_subagent` / `send_subagent`：写明返回后不要 `get`/`list` 空转等待；child 报告会作为带 `customType: "pi-subagent-report"` 的消息进入下一 turn。`get`/`list` 只用于需要当前状态或身份时。
- `contact_parent`：写明调用后 parent 会被唤醒；不要为同一事实连打多次；`need_decision` / `blocked` 之后等待 parent 的 `send_subagent`，不要自行假设授权。
- `CHILD_BRIDGE_PROMPT`：同样写死上述通道。
- Child `agent_end` 且正常 stop、本 turn 未调用 `contact_parent`、用户未接管时，延迟 nudge（借用他们的 timer 逻辑，默认 5s，可用 `PI_SUBAGENTS_NUDGE_DELAY_MS` / `PI_SUBAGENTS_NUDGE_DISABLE`）。Nudge 用 Pi `sendUserMessage(..., { deliverAs: "followUp" })`，文案要求调用 `contact_parent`。

不把 idle 自动包装成 parent 完成消息。否则和「报告是 delegated result、不是新用户授权」冲突，也会在 interactive TUI 里误叫醒 parent。

### 3.2 Activity snapshot：不做

maplezzk 的 activity 文件是他们的**状态总线**。他们没有 runner IPC：parent 不能问 child，只能轮询 child 写在磁盘上的小 JSON，再据此画 widget、标 stalled。Session JSONL 他们已经不用来做 liveness。

我们这边这条总线已经存在：

| 需求 | 现有通道 |
| --- | --- |
| running / idle / failed / done | runner 转发的 Pi events → `state.ts` projector → registry |
| 报告内容 | `contact_parent` → 同一条 IPC |
| parent 是否还连得上 child | connector + `freshness: live \| last_known` |
| TUI attach 后仍要控制/报告 | spec 已要求 runner 不随 RPC writer 退出；child 继续用 endpoint 发 `contact_parent` |

再铺一份 `<agent-dir>/pi-subagents/activity/...json` 是第二套总线：多一种损坏/错 id/stale 文件语义，却不提供 IPC 没有的身份或权限信息。RPC 下它是重复；TUI 下若真缺「当前 tool 名」这类粗标签，应在**现有 IPC** 上加有界 status frame（归 SUB-08），而不是先把文件系统当协议。

**禁止**扫 session JSONL、readScreen、activity sidecar。Widget 只读 `PublicSubagent`。Stall 不从缺文件推断。

### 3.3 interactive vs autonomous

不引入 `auto-exit`。Child 不因 turn 结束而退出。不引入基于 snapshot 的 stall ping（没有 sidecar 就没有「文件消失 = stalled」）。

Agent frontmatter 增加已兑现字段：

```text
interactive: boolean   # 缺省 false
```

语义：`true` 表示用户会在原生 TUI 里操作这个 child。除 `contact_parent` 外，本包不得 `triggerTurn` 叫醒 parent。`contact_parent` 两种模式都投递。Recovery failure 是 parent 自己的诊断，不受此位静音。

解析进 `ResolvedAgentPolicy` / `EffectiveLaunchConfig`，创建时冻结，RPC/TUI/restart 复用。非法值启动前失败。未知字段规则不变。

当前没有 TUI attach，这个位在 RPC 下几乎没有额外投递效果（本来就不会为 idle 叫醒 parent）。现在写入快照，是为了 attach 时策略已经冻住，不必再改 agent 文件。

### 3.4 Widget 是投影，无边框

Registry / `SubagentManager.list()` 是身份真源。Widget 不得持有第二份 running Map，不得成为 stop/recover 的输入。

可见性是投影，不是 `hiddenFromWidget` 标志。本包没有第二编排器，不预留该字段。

投影规则：

- 显示 `starting | running | idle`；
- 不显示 `done | stopped | failed`（与 mode 无关）；
- headless/RPC parent 不挂 widget（ext-core `registerWidget` 已按 `extension.mode === "tui"` 处理）；
- 零可见 child 时 `setVisible(false)`。

实现**对齐** `packages/pi-ext-tools/src/todo/widget.ts` 与 AgentMemory recall widget：

- `registerWidget` + `requestRender`，不要直接 `ctx.ui.setWidget`；
- 无边框、无硬编码 RGB；
- 一行标题（accent/dim 计数），随后每 child 一行；
- `truncateToWidth` / theme token：`text` 名称，`dim` id/耗时，`accent` running，`muted` idle，`warning` interrupted；
- 行结构示例：`◐ worker  running  ·  12:03`，窄宽都 cell-width safe。

刷新跟 list/state 变化走，不轮询文件。`/reload` 走 `registerExtensionLifecycle` signal。

这会修改 spec §8「只有默认 primitive 不够才加 widget」。理由：`setStatus` 一条线放不下并行 children。SUB-10 的 select/快捷键仍等 attach。

### 3.5 Child 扩展选择：保持现状

`--no-extensions` + 本包绝对路径 `-e` 已经对齐，且更严。Agent `extensions` 字段在 resolver 里解析一次，写进 LaunchSpec。

**不做** maplezzk 的用户级 `subagentExtensions` 列表和 `/config:subagent extensions`。用户要给 child 加扩展，写进 agent Markdown。

## 4. 所有权

| 所有者 | 负责 | 不负责 |
| --- | --- | --- |
| `SubagentManager` / registry | child 身份、state/mode、是否对 parent `triggerTurn` | widget 几何 |
| child branch | `contact_parent`、nudge | manager、spawn、写旁路文件 |
| runner IPC | 唯一跨进程控制/报告通道 | 终端、磁盘 sidecar |
| widget | 把 `PublicSubagent` 画成 above-editor 行 | identity、filter 成编排器面板 |
| LaunchSpec | `interactive` 与 bridge 路径随 policy 冻结 | 用户 config.json 里的扩展列表 |

## 5. 最小公共合同增量

相对现行 spec 只加这些：

```ts
// agent frontmatter（已兑现）
interactive?: boolean  // default false

// parent 消息（不变）
customType: "pi-subagent-report" | "pi-subagent-recovery-failure"
```

`PublicSubagent` 增加只读 `interactive`。不新增 model-facing tool，不新增 `pi-subagent-stall`，不把 activity 写入 registry。

## 6. 实施顺序

可与 SUB-06 recovery 并行，不依赖 HostAdapter。

```text
SUB-P1 话术 + child nudge
  → SUB-P3 interactive 字段（无 stall ping）
  → SUB-P4 无边框 widget 投影
SUB-P2 activity sidecar    [-] 不做
SUB-P-X 扩展挑选器         [-] 不做
```

每个 ticket：先测后改；只跑 focused vitest + 变更文件 biome。P4 要补窄/宽 layout 测试，并改 `DESIGN.md` 一句 widget 合同。

## 7. 明确不做

- 不改 runner / IPC / LaunchSpec argv 结构（除 `interactive` 进入冻结 config）
- 不 fire-and-forget spawn、不 `subagent_done`、不退出再 resume
- 不 activity sidecar、不扫 JSONL、不 readScreen、不 send-keys
- 不基于缺文件的 stall ping
- 不 bundled agents、不 `/plan`、不 mux 配置 UI
- 不 `hiddenFromWidget`、不 child 扩展挑选器、不 `auto-exit`、不 widget 边框
- 不把 widget 当成 ownership/liveness
- 不提前做 SUB-10 的 attach 快捷键和 agent picker
- TUI 下若需要 tool-level 粗标签：SUB-08 用现有 IPC status frame，不在本计划预铺
