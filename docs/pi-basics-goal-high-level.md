# `pi-basics` Goal 高层方案（Review Gate）

> 状态：待 Review；本文件只更新 planning，不代表 Goal production source 已存在。  
> 详细状态、tool、timer、persistence 与 Loadout contract 见 [`pi-basics-goal-design.md`](./pi-basics-goal-design.md)。  
> 实作 phase、focused tests 与 Loadout side plan 见 [`pi-basics-goal-implementation.md`](./pi-basics-goal-implementation.md)。

## 1. 一句话方案

Goal 是一个单目标、branch-local 的自动续跑功能：用户用 `/goal <prompt>` 建立或替换目标，裸 `/goal` 暂停/恢复；无目标时裸 `/goal` 只进入 runtime-only 的“等待下一条目标输入”状态；模型唯一写入能力是 `goal(status="blocked" | "complete")`；每个非错误 run fully settled 后等待固定 15 秒，再 best-effort 发送检查/继续提示，单次 activation 最多自动续跑 20 次。

Goal 不是 Todo task system、Ask questionnaire、Review auditor、Settings panel 或 footer owner。

## 2. Approved scope for Review

### 2.1 Durable state 与 runtime capture

Domain 只有两个运行态：

```text
inactive  没有执行中的 Goal；可能有一个暂存 Goal
active    正在执行一个 Goal；`goal` tool 调用有效并注入 active-only instruction
```

此外有一个不持久化的 runtime flag：`awaitingObjective`。

- `inactive + /goal`：有暂存 Goal 时恢复；没有时进入 `awaitingObjective`，不调用模型。
- `awaitingObjective + 下一条合格 ordinary prompt`：把 prompt 作为 objective，进入 active，并保留原始输入让同一 turn 执行。
- `awaitingObjective + /goal`：退出等待状态，保持 inactive。
- `active + /goal`：durable commit 暂存 objective，退出 active，并 abort 当前 Goal-owned run。
- `any + /goal <prompt>`：literal trimmed prompt 建立/替换 objective，进入 active；旧 Goal run 若 streaming，commit 后 abort，等待 idle，再 recheck 新 identity 后 kickoff。
- Active 中普通用户输入是当前 Goal 的补充指令，不替换 objective；只有 `/goal <prompt>` 替换。

合格 objective input 必须来自 `interactive | rpc`、包含非空 text、不是 images-only；`extension` source 不捕获。已有 streaming input 可以作为 objective，交由 Pi 的 `steer/followUp` 机制排队；不额外禁止 streaming。Slash command 由 Pi command routing 处理，不作为 objective。

### 2.2 暂存与恢复

- 每个 selected session branch 最多一个 resumable Goal slot；不做 queue 或 multi-goal focus。
- 用户退出、`goal(status="blocked")`、自动续跑达到上限、Loadout disable、provider final error、abort 或手动 compact，都停止自动执行并暂存 objective。
- 再次裸 `/goal` 恢复暂存 objective，并分配 fresh `goal_id`/run sequence；旧 tool call 与 timer 失效。
- `goal(status="complete")` 写入 completion evidence，退出 active 并清除 resumable slot。完成历史可留在 branch custom entries，但不会成为默认恢复目标。
- `awaitingObjective`、timer handle、run ownership、continuation count 不持久化。Session/reload/tree reconstruction 将未完成 objective 还原为 inactive + stored，不自动启动模型。

### 2.3 唯一 model tool

Tool 从 `goal_complete` 简化并重命名为 `goal`：

```ts
interface GoalToolParams {
  goal_id: string;
  status: "blocked" | "complete";
  summary: string;
}
```

- `goal_id` 必须 exact match 当前 active activation；旧 activation 一律 reject。
- `summary` trim 后必须非空。`blocked` 时是阻塞原因/证据；`complete` 时是完成与验证证据。
- `blocked`：关闭 Goal、保存 blocked slot、取消 timer/run；之后裸 `/goal` 可恢复。
- `complete`：关闭 Goal、清除 resumable slot、取消 timer；之后不会自动恢复。
- `terminate: true` 只表示 terminal result hint；Pi 仅在同一 tool batch 的所有 finalized results 都 terminate 时提前终止。Goal 不宣称能终止 mixed tool batch，也不宣称能撤销已开始的其他 tool。
- Prompt 要求 `goal` 作为 terminal-only、最后且最好唯一的 tool call；这是 guidance，不是 host-level enforcement。
- 非 active、stale id、空 summary、未知 status 都 fail closed，不改 state。
- V1 不增加 `goal_blocked`、create/get/update、queue、budget、task 或 auditor tool。

### 2.4 续跑与 compaction

- `before_agent_start` 只在 active mode 注入 exact `goal_id`、稳定 guidance，再注入 escaped objective：完成则调用 `goal(complete)`；真正无法继续则调用 `goal(blocked)`；否则继续实作与验证。
- `agent_end` 只记录 exact Goal-owned error/aborted candidate，不立即 safety-stop、不启动 timer；successful run 不在 agent_end 决策，避免 retriable error/overflow 在 retry 前关闭 Goal。
- `agent_settled` 确认 retry、compaction 与 queued work 已 drain。若匹配当前 run 的 error/aborted candidate 存在，且 Goal 仍 active，则 safety-stop 到 inactive + stored；否则若 count 已达 20 先 safety-stop，剩余 non-error settled 才启动唯一 15 秒 timer。
- Timer 到期重新检查 session、active goal id、run sequence、Loadout capability、continuation count、`ctx.isIdle()`、无 pending message 与无 newer input，然后 best-effort 发送 `deliverAs: "followUp"` reminder。
- Reminder 要求检查实际状态：完成调用 `goal(complete)`，真正无法继续调用 `goal(blocked)`，否则继续实际工作，不能只总结或停在 plan。
- 用户输入、替换、退出、tool accepted、new run、session/tree/reload/shutdown、Loadout disable 都取消旧 timer。Late callback 通过 goal id/run sequence no-op。
- 自动 threshold/overflow compaction（`willRetry: true`）保持 active，等待最终 settled；不把 compaction 当 session reconstruction。
- 手动 compact 是 safety stop：在 compact 生命周期中保存 objective、关闭 active；compact 完成后用户显式裸 `/goal` 恢复。
- 每个 activation 最多 20 个 automatic continuation。达到上限后 inactive + stored 并通知；不增加 token/cost ledger 或 setting。

15 秒是固定 v1 grace delay，不是可靠的“人工中止窗口”；未提交的 editor draft 不属于可观察 pending input。

## 3. Tool context 与 Loadout 决策

### 3.1 已确认的当前语义

Pi `ToolDefinition.promptSnippet` 与 `promptGuidelines` 都是 optional。`goal` tool 省略两者，因此不会向默认 Available tools/Guidelines system-prompt 区块加入额外文字。

但 active tool 的 name、description 与 JSON parameter schema 仍会传给模型并占用 context。当前 Loadout token estimate 也至少计算 tool name + schema。因此“可调用但完全零 context”不存在。

### 3.2 主方案：稳定 active-tool coordinator

- Tool schema 在 extension load 时稳定注册一次；不动态 register/unregister。
- Loadout configured state 是 permission ceiling；disabled 时不能进入/恢复 Goal。
- Loadout 启用时，`goal` schema 在 inactive、awaitingObjective 与 active 间常驻，避免 Goal mode 切换重写 active-tool prefix。
- `goal` execute 在 inactive 时 fail closed；只有 active mode 注入 instruction，且 guidance 位于 untrusted objective 之前。
- coordinator 是 `pi-basics` composition-root helper，不是 generic plugin/capability framework。
- `packages/pi-basics/src/index.ts`、`modules/ask/index.ts`、`modules/loadout/index.ts` 三条路径共用 coordinator；production source 中不保留第二个 direct `setActiveTools()` writer。
- Loadout disable 顺序固定为：检测 baseline 变化 → 提交新 baseline → await Goal safety-stop → 持久化 slot/abort；Goal safety-stop 失败则抛错，让现有 Loadout rollback 恢复旧 baseline 与 active Goal runtime。

## 4. Host prerequisite 与 blocker 回答

1. **Pi 0.80.10 可解除 settled blocker。** Public types 已确认包含 `agent_settled`、`ctx.hasPendingMessages()`、`ctx.isIdle()`、command `ctx.waitForIdle()` 与 input APIs；本仓库 `bun.lock` 仍固定 0.80.3。实现前一起刷新三个 `@earendil-works/pi-*` lock resolution 到 0.80.10，再验证事件 ordering、compact、abort、mixed tool batch 与 tool termination hint。
2. **无 prompt metadata 可以实现；零 context 不可以。** 常驻 schema 本身必然占 context；active-only instruction 不污染普通 mode 的 system prompt suffix。
3. **20 次 fixed continuation cap 已接受。** 达到上限后存 Goal、退出自动 mode、通知用户。
4. **Best-effort delivery 已接受。** Public `sendUserMessage` 返回 `void`，Goal 不宣称 provider acknowledgment。

## 5. 明确不做

- 不做 `/goal pause|resume|clear|show|status|edit|start` 子命令；grammar 只有裸 `/goal` 与 `/goal <prompt>`。
- 不做 public paused state；suspend 是 inactive + stored metadata。
- 不做 queue、budget/cost ledger、disk goal pool、task DAG、questionnaire、auditor、Goal tab、Settings 或 footer ownership。
- 不做 generic scheduler、capability framework 或多目标 API。
- 不让 objective、summary、provider error 或 compact summary 获得高于 user-data 的 prompt priority。

## 6. Implementation gate summary

实现前必须全部成立：

1. 三份 Goal planning 文档一致并通过 Review。
2. Frozen Pi dependency 已更新且 focused host probe 通过。
3. Pure tests 覆盖 inactive/active、awaitingObjective、stored restore、fresh goal id、blocked/complete、20 次 limit 与 stale run。
4. Integration tests 证明 direct prompt、裸 `/goal` toggle、streaming objective capture、active-only tool visibility、三条 active-tool writers、Loadout disable rollback、manual/auto compact、15 秒 timer cancellation 与 exact tool guard。
5. Mixed tool batch 明确验证 terminal hint 语义，不假称强制终止。
6. Live smoke 证明 blocked 可恢复、complete 不恢复、manual compact 可恢复、auto compact 不停 Goal，旧 timer/tool call 不影响新 activation。

详细 phase 与 stop rules 见 [`pi-basics-goal-implementation.md`](./pi-basics-goal-implementation.md)。
