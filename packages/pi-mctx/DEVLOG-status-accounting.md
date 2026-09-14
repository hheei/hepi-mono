# Status token accounting 开发日志

> 范围：footer、`/ctx-status` overlay、print/rpc `/ctx-status` 文本，以及 compact / new / resume 入口。
> 状态：display 口径已对齐到 `b98aa72`；调度器（historian / emergency / nudge）仍用 `message_end` 写入的 trailing，compact 后到下一发真实 usage 之前不估。
> 相关提交：`9f46bda` 百分比口径 → `d8e578a` compact 显示 unknown → `7dce5d4` kept-tail 估计 → `b98aa72` 入口共享。

## 问题

Pi `getContextUsage()` 在 native compaction 后把 `tokens` / `percent` 置 `null`，新 session 则是 `tokens === 0`。早期 footer 把这两种都当成「没有 usage」，于是：

- compact 后仍画压缩前的 `last_input_tokens`（例如 90k / 90%）；
- 新 session 画 `mc: 0`，忽略已经占用窗口的 system prompt + tool defs；
- print/rpc 没有 footer，`/ctx-status` 直接打 `session_meta.last_input_tokens`。

百分比也不能用 Pi 的 `percent`：它是 `(input + output + cache) / contextWindow`。MCTX 调度和 status 都应按 wire-input / output-reserved usable window。

## 现行口径

共用函数：`resolvePiSessionDisplayPressure`（`src/pi-pressure.ts`）。

```text
live.tokens
  >0    → live，必要时和 last_input_tokens 取 max
  0     → new session：system prompt + tool defs（prefix）
  null  → compact：prefix + kept-tail conversation_tokens + tool_call_tokens
```

分母始终是 `resolvePiUsableContextLimit`（output-reserved，可被 `detected_context_limit` 盖住）。不用 Pi `percent`，也不用调度器的 0.85 `FORWARD_PRESSURE_LIMIT_FACTOR`。

kept-tail 不是整条 `getBranch()`。Pi `buildSessionContext` 只发 compaction summary + `firstKeptEntryId` 之后的条目；`collectCompactKeptMessages` 按这个切。`tokenizePiMessages` 把 text/thinking 记进 `conversation_tokens`，tool call/result 记进 `tool_call_tokens`。

compact persist（`persistCompactKeptPromptEstimate`）同时：

1. 重写 kept-tail 两个桶；
2. 把 `last_input_tokens` / `last_context_percentage` 清零。

这样 historian / transform / nudge 不能继续用压缩前的 90k 当压力。status 在 `tokens === null` 时走估计，不读清零后的 trailing。

## 已落地

| 入口 | 行为 | 位置 |
| --- | --- | --- |
| 新 session footer | `tokens === 0` → prefix | `status-line.ts` `session_start` |
| compact footer | persist 重写桶并清 trailing；footer 监听注册在 persist 之后 | `index.ts` `handlePiSessionCompact` + `registerStatusLine` |
| compacted resume | `session_start` 若 branch 含 compaction entry，重写同一套桶 | `index.ts` `session_start` |
| TUI `/ctx-status` | overlay 走同一 resolver | `dialogs/status-dialog.ts` |
| print/rpc `/ctx-status` | `hasUI=false` 无 footer；文本经 `displayUsage` 传入 `executeStatus` | `commands/ctx-status.ts` |
| session switch | 清 footer 缓存和当前 `mc:`，避免切回来看到上一 session | `status-line.ts` `session_before_switch` |
| clone / fork | **不**拷贝 token 桶；新 session 从 0 开始，走 prefix | `storage-clone.ts` |
| 模型切换 | transform 无条件清 trailing + overflow/historian 模型态 | `context-handler.ts` |

聚焦测试（`b98aa72` 时 7 文件 / 46 项）：

- `test/pi-pressure.test.ts` — live / prefix / compact-null 估计 / compact 不回落到 stale trailing
- `test/pi-compact-kept-messages.test.ts` — kept-tail 收集；compact persist 清 `last_input_tokens`；uncompacted resume 不改桶
- `test/compaction-off-pi.test.ts` — compact persist 后 trailing 为 0
- `test/status-line.test.ts` — 新 session 非 0；reserved-window 百分比；compact 估计
- `test/dialogs/status-dialog.test.ts` — reserved window；compact 估计
- `test/commands/ctx-commands.test.ts` — print/rpc compact 文本不含 `90,000`

## 还没做

按优先级。这些不是「下次顺手改」，是已知缺口。

### 1. compact 估计不含 m[0]/m[1]

下一发真实 prompt 还有 compartments / memories / docs / profile 注入。现在 compact 估计是：

`system + tools + kept-tail conversation + kept-tail tools`

dialog 在 **非** compact 时会把 m[0] 块加进 prefixTokens；`tokens === null` 时只用 `prefix.tokens`（system+tools）。footer / RPC 同样不加 m[0]。

compact 后到第一次 transform 重建 cache 前，footer 会系统性偏低。要补的话应读 `cached_m0_bytes`（compact 前已清 cache，所以 resume/compact 当下常常是 0），或在 persist 时另存一笔 injection 估计。

### 2. 调度器故意不吃估计，但副作用没测完

transform / historian 在 compact 后、`message_end` 前走「no usage yet」：

- `last_input_tokens === 0` → 不用 session_meta；
- `piUsage.tokens === null` → historian 直接 return。

这是刻意的：用估的压力去 drop/execute 会误伤。未测的副作用：

- 第一发 post-compact 可能该触发 historian / emergency 却不触发；
- `ctx-reduce` nudge（`ctx-reduce-nudge.ts`）分母是 `lastInputTokens + turnToolTokens`，compact 后是 0，nudge 会哑；
- `tools/ctx-reduce.ts` 的 `getSessionTokens` 回落到 `lastInputTokens`，compact 后是 0。

若要补，应给调度器单独的「compact 后禁止 trailing、也不用 display 估计」测试，而不是把 display 估计接进 historian。

### 3. `executeStatus` 自身仍回落到 trailing

`executeStatus(..., displayUsage?)` 在没传 `displayUsage` 时仍用 `meta.lastInputTokens`。现在唯一生产调用是 `/ctx-status`，它会传。`test/core/hooks/execute-status.test.ts` 全部不传 `displayUsage`，也没有 compact 用例。core helper 单独被调用时口径会漂。

### 4. 切回 session 时 footer 可能空白

`session_before_switch` 清 outgoing 的 `mc:`。incoming 是否再走 `session_start` 没在测试里钉死。若 Pi 切 session 不发 `session_start`，切回来要等 `agent_end` / `message_end` / `tool_execution_end` 才重画 footer。应加一条：switch-in 立刻 `updateStatusLine`（对 incoming session id）。

### 5. 缺真实 TUI / print 冒烟

全部是 vitest。没跑过：

- `scripts/pi-dev` 里 compact 一次，看 footer 是否从 90% 变成 kept-tail 量级；
- 重启 Pi、resume 已 compact 的 JSONL，footer 是否在第一帧就是估计而不是 `--` 或 90k；
- `pi --print` / RPC 下 `/ctx-status` 文本；
- 新 session 未发过消息时 footer 是否已是 prefix 而不是 `mc: 0`。

### 6. 测试没钉死的入口

| 缺口 | 说明 |
| --- | --- |
| RPC 新 session | 只测了 compact `tokens === null`，没测 `tokens === 0` 的 prefix 文本 |
| footer `session_before_switch` | 无测试 |
| compacted resume 整条 `session_start` | persist helper 有测；adapter 的 start hook 没有 |
| persist 注册顺序 | 只靠 `index.ts` 注释保证 compact persist 在 footer 前 |
| dialog resume mismatch | live tokens 已到、桶还是 compact 前的，breakdown 隐藏——有注释，无失败用例 |
| handoff continuation | 新 session + prefix，理论上对；没测从 compacted source handoff 出来的 destination status |
| 多 compaction marker | `collectCompactKeptMessages` 从后往前找最近一条；没有「compact 两次」测试 |

### 7. transform 首轮 reset 和 compact persist 的竞态

restart 后第一次 `context` 若 `lastContextPercentage > 0` 会清 trailing（保留 overflow/historian 态）。compact persist 已经把这两项清零，所以 compacted resume 不会误清。若 `session_start` 的 rewrite 失败（getBranch 抛错是 best-effort），旧 trailing 仍在，第一次 transform 会清掉它，status 在那之前仍可能闪一次 90k。没有失败注入测试。

### 8. 估计 tokenizer ≠ provider tokenizer

kept-tail 用 `estimateTokens`（char-based），和 footer prefix 同一套，和 `message_end` 的 provider usage 不是同一把尺。compact 后数字会跳一次，属预期，但没文档化给操作者看。dialog / footer 也没标 `estimated` vs `live`。

## 刻意不做

- **不把 display 估计喂给 historian / emergency / ctx-reduce nudge。** status 可以猜下一发 prompt；调度器用猜的压力会在 compact 后误 drop。
- **clone 不继承 token 桶。** destination 是新 prompt。
- **fail-closed storage 仍取消 native compact。** 没库就没有可写的 kept-tail。
- **print/rpc 不画 footer。** `updateStatusLine` 在 `!ctx.hasUI` 时直接 return；命令文本是这条路径的 status。

## 下次动手顺序

1. 真实 `pi-dev` compact + resume 看 footer / RPC（第 5 项）——先确认还有没有看不见的入口。
2. switch-in 重画 footer（第 4 项）。
3. compact 估计是否加 m[0]（第 1 项）——要先确认 compact 当下 cache 是空的，加了也是 0。
4. 给 historian / nudge 加「compact 后无 usage」的显式测试（第 2 项），不要改行为除非产品要第一发就能触发。
5. `executeStatus` 单测补 `displayUsage` compact 用例（第 3 项）。
