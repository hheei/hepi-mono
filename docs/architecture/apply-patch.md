# Apply Patch 结果架构

> 状态：已实现。本文定义 `pi-ext-tools` 的 Codex V4A `apply_patch` 结果、模型信息和 TUI 合约；当前运行时边界见 [ext-tools README](../ext-tools/README.md)，bridge 现况见 [pi-ext bridge](pi-ext-bridge.md)，术语以仓库根目录 [CONTEXT.md](../../CONTEXT.md) 为准。

## Contract

`apply_patch` 必须把一次 V4A request 的实际结果，而不是请求 patch 或 renderer-local state，同时交给模型、TUI、Trace collapse 和 session resume。

- 每个 coordinator request id 代表一次 mutation；客户端断线可以用相同 id 重连取得进行中的或已完成的 outcome，但绝不重新执行 patch。若 coordinator 无法确认 outcome，工具返回明确的 transport failure，模型不得假定 workspace 未变。
- commit 在 request 级 rollback journal 下进行。取消、I/O 或 commit failure 时必须恢复本 request 已写入的所有 path；只有 rollback 失败时才报告 `workspace state indeterminate`，并要求模型先 read affected paths 后再行动。
- coordinator 对单个 newline-delimited JSON frame、patch bytes、operation 数、hunk 数和 hunk 行数实施上限；超限 request 在解析、staging 或 mutation 前被拒绝，并要求模型拆分 patch。
- live progress 的阶段为 `parsed`、`queued`、`staging` 与 `committed`。`parsed` preview 不代表已验证或已入队；若完整 envelope 失败，最终错误必须明确无 operation 被验证或 applied。

- 合规 operation 独立提交；一个 rejection 不回滚其他已提交 operation。同一 `Update File` 的 hunks 也独立：按 V4A 顺序在同一个 file staging copy 上执行，失败 hunk 不回滚已成功 hunk，也不阻止后续 hunk。多个没有 `Move to` 的 `Update File` 可以按 patch 顺序作用于同一文件；后一个 operation 读取前一个 operation 的 staging state。`Add`、`Delete` 或移动与同路径混合仍是预检冲突。
- 任何 partial 或 failed request 对 Pi host 标记为 error；模型内容必须明确哪些 operation 已提交、哪些可重试。
- V4A 不包含可信源行号。重复上下文不得因伪造 unified-diff line hint 而静默选择文件中最早位置。
- 完成后的 TUI 只读取实际结果。展开的 diff 是提交当时的稳定 hunk snapshot，不重读可能已变化的 workspace。

```text
V4A patch
  -> parser + path validation
  -> per-hunk staging exact/fuzzy mpatch attempt
  -> per-hunk diagnostics
  -> baseline revalidation + commit
  -> Patch Outcome
     +-> model content
     +-> structured details
     +-> TUI / collapsed footer
```

## Ownership

`pi-ext-bridge` 只拥有一次 mpatch invocation、取消，以及无原文的 native hunk report。它不拥有 V4A 语法、workspace paths、fuzzy policy、model text、TUI 或 persistence。

`pi-ext-tools` 拥有 V4A parse、path/security validation、staging、baseline revalidation、fuzzy admission、Patch Outcome、model formatter、Pi `tool_result` error marking、renderer 和 Trace footer。

ext-core 不拥有 patch policy或结果；它只提供已有的 shared lifecycle primitives。

## Native mpatch contract

V4A compiler 当前生成统一 diff 时没有真实旧行号。bridge 在 `parse_auto()` 后必须将每个 non-empty hunk 的 `old_start_line` 清为 `None`，再调用 mpatch finder。这样 exact 或 fuzzy 有多个可行候选时，mpatch 返回 ambiguity report，而不是将伪造的 `1` 当作可信 hint 偏向最早候选。

N-API 的 `MpatchRunResult` 保留 `status`、`stdout` 与 `stderr` 以兼容 native execution，同时新增完整的 `outcomes`：

```ts
type MpatchHunkOutcome =
  | {
      kind: "applied";
      hunkIndex: number;
      startLine: number;
      length: number;
      match: "exact" | "exact_ignoring_whitespace" | "fuzzy";
      score?: number;
    }
  | { kind: "context_not_found"; hunkIndex: number }
  | { kind: "ambiguous_exact"; hunkIndex: number; candidateStartLines: number[] }
  | {
      kind: "ambiguous_fuzzy";
      hunkIndex: number;
      candidates: Array<{ startLine: number; length: number }>;
    }
  | {
      kind: "fuzzy_below_threshold";
      hunkIndex: number;
      best: { startLine: number; length: number; score: number };
      threshold: number;
    };
```

`hunkIndex` 与 `startLine` 都是 one-based；`length` 是匹配窗口行数。bridge 不传源文本、patch body、staging absolute path 或原始 Rust error object。`context_not_found` 不伪造 candidate 或 expected-text diff；模型已提交 patch，需要当前文本时调用 `read`。

## Patch Outcome

一次 V4A operation 产生一个 Patch Outcome。`Update File` 的每个 hunk 是顺序原子子操作；它们共享一个 staging copy，且所有成功 hunk 最终只通过一次文件替换提交。它是唯一的结果事实源：

```ts
type PatchOutcome = {
  status: "success" | "partial" | "failed";
  applied: AppliedOperation[]; // each operation owns its changed-hunk snapshots
  rejected: RejectedOperation[];
  changedPaths: string[];
};
```

- `applied` 保存 operation index、动作、实际 changed path、每个已提交 hunk 的 native match outcome，以及提交时的 before/after changed-hunk snapshot。一个 update 即使另一个 hunk 被拒绝，仍可存在于 `applied`。
- `rejected` 保存 operation index、目标 path、稳定的 non-native rejection reason，和每个失败 hunk 的最后一次 dry-run 或 apply diagnostics。失败 hunk 不撤销同 update 中已成功的 hunk。
- `changedPaths` 仅来自实际 commit，不从 request 推导。
普通 exact 成功不向模型逐 hunk 展开。fuzzy 成功向模型报告 path、hunk、实际 line range 和 score；exact-ignoring-whitespace 作为普通成功隐藏。fuzzy 成功不强制额外 `read`，但其事实仍可在 details/TUI 中审计。

partial 保留成功 operation。`tool_result` handler 根据 Outcome 的 `partial`/`failed` 设置 `isError: true`；这不替代模型文本中的 recovery，也不通过 throw 丢失已提交结果。

## 模型内容

模型只接收 deterministic text `content`，不接收 `details` 或 TUI render tree。解析失败的错误会包含原始 V4A source line；如果此前已经显示 parsed preview，错误还会明确 preview 的 operation 数，并说明这些 operation 没有经过 validation 或 apply。coordinator 启动/锁失败会包含 socket path、PID、protocol revision、lock age 或 child stderr tail，避免模型把启动诊断误判成 patch syntax failure。transport、queue、cancel 与 unknown-outcome failure 必须给出下一步：unknown outcome 先 read 所有目标 path；queue full 等待后重试原 patch；cancel 等 rollback 完成后 read 再重试；parse failure 修复指定 source line 后重新提交完整 envelope。

成功结果列出真实 changed paths：

```text
Applied patch: 2 operations in 2 files.
Changed:
- src/config.ts: updated
- src/routes.ts: updated

Fuzzy-applied:
- src/routes.ts, hunk 1: lines 42-49, similarity 0.84
```

partial 结果必须先区分 changed/rejected，再给出最窄的下一步：

```text
Patch partially applied.
Changed:
- src/config.ts: updated

Rejected:
- operation 2, src/routes.ts, hunk 1:
  exact context is ambiguous at lines 18, 47

Recovery: read src/routes.ts around lines 18 and 47, then retry only the rejected hunks from operation 2.
Do not retry applied hunks.
```

`context_not_found` 的 recovery 是读目标 path 后只重试 rejected hunk；没有 hunk diagnostics 的路径/解析 rejection 才重试 rejected operation。`fuzzy_below_threshold` 总会给 score 与 threshold，只有 score 严格高于 `threshold * 0.7` 才给最佳 candidate line range；ambiguous fuzzy 的候选共享一个已达 threshold 的 top score。模型内容每个 ambiguity 最多显示 6 个 candidates，并标示总数；完整 facts 仍在 details，不能因 TUI collapse 丢失。

## TUI

执行中，coordinator 在解析完每个完整 V4A operation 后发送 typed Patch Progress，完整 envelope 通过后发送 queued，executor 进入 staging 与每个 operation commit/rejection 后发送下一份全量 snapshot。`parsed` 仅表示完整 operation 已被语法识别；`queued` 表示已通过完整 envelope 与 queue admission；`staging` 表示 workspace validation/staging 进行中；`committed` 才能带最终 operation status。断线后的同 request id 只能订阅既有执行或读取缓存 outcome，不能重新执行 mutation。live state 只属于当前 Trace：`○` 是尚未 commit，`✓` 是 exact/whitespace commit，`!` 是 fuzzy commit（dim score），`✗` 是 rejection。一个 update 的成功 hunk 与失败 hunk共同归属该 operation；展开结果以 hunk index 显示失败诊断。header 的 `+/-` 只累计已 commit operation；row 同时显示 planned delta。final `Patch Outcome` 替代 live state，resume 不恢复 `○` rows。

Call 阶段使用 shared frame header。完成阶段不得使用 module-global renderer map、请求 patch 或当前 workspace 推断结果。

未展开的完成结果显示简短 outcome summary；prior Trace collapse 由 shared frame 显示 header、空行、tool-owned footer。footer 是 typed metrics，不解析模型 content：

```text
2 files · 3 operations · 1 fuzzy · 10ms
```

partial 使用 warning glyph `!`，同时 host result 仍为 `isError: true`。failed/cancelled 继续使用既有 error/cancelled state。

展开时：

- applied operation 使用 outcome-time `snapshots` 和 Pi `renderDiff()` 显示 changed hunks 与有限 context；不会因后续操作改变历史 diff。
- fuzzy hunk 显示 path、line range 与 score。
- rejected operation 显示 path、operation/hunk index、diagnostic kind、candidate lines/ranges或 threshold facts；不嵌入源代码。`read` 是显式 recovery action。

颜色只作补充。path、operation/hunk 标识、match kind 与 diagnostics 必须在无颜色时可区分。

## 生命周期、取消与并发

- parser、path/security、coordinator/native failure 和 socket startup diagnostics 都保留稳定错误分类；parser errors 带 source line（若有），startup errors 带 socket/lock/child facts，transport error 不能被静默重试。
- dry-run、fuzzy attempt、staging apply、baseline revalidation 与 commit 全都服从既有 `AbortSignal`/bridge cancellation。commit 前创建 request 级 rollback journal；取消或 commit error 后必须恢复本 request 已替换/删除的 path。rollback 无法完成时，工具返回 `workspace state indeterminate` 与 affected paths，模型必须先 `read` 后再行动。普通 socket 断线仅移除 subscriber，request 保留以允许同 id reconnect；用户 abort 发送显式 cancel request。parsing、queued 和 running request 都在不会继续 mutation 的第一个安全点完成取消，running request 等 executor rollback 后才发布最终 cancellation error。取消不产生 partial diagnostics 或 speculative snapshots。
- 单 request 的 socket frame、patch bytes、operation/hunk 数、hunk 行数、relative path/segment bytes 均有硬上限；超限不会进入队列或 staging。progress 与 response 都受同一 response frame budget 保护：progress 超限时先省略可选 hunk metadata，仍超限则跳过该 display-only update；final response 超限时先去除 hunk snapshots 保留 outcome，仍无法传输时明确要求 `read`，不伪造 unknown success。
- 同 path jobs 保持 coordinator serialization；无交集 path jobs 保持现有 worker concurrency。request id 是 coordinator-memory-lifetime 内的 mutation id：同 id 重连订阅已存在 job 或读取短时缓存 result，不创建第二个 job。完成 result 在 coordinator 内存中仅保留 10 秒，随后释放 patch/progress/result 但保留有界 fingerprint tombstone；只要 id 仍在 record 或 tombstone 中，同 id 只会要求 `read`，绝不重新 mutation。coordinator restart 或 tombstone eviction 后，调用方必须使用新的 request id 并按普通 mutation 前 read/validation 语义处理。每个 connection 可以承载多个 newline-delimited requests，response 按 request id 写回；Pi client 在自身 final response 后主动关闭。socket frame parser 会 drain 同一 chunk 的每个完整 request，SIGTERM/SIGINT 会先销毁所有 accepted sockets，再等待 socket/lock cleanup 后退出。
- baseline 变化、path policy conflict、filesystem error 和 parser error 由 `pi-ext-tools` 形成 stable typed rejection，而不是伪装成 mpatch hunk mismatch。
- details 是 result persistence source；resume 和 global expand 从它渲染 completed outcome，不恢复 pending preview state。

## 验证

聚焦测试至少覆盖：

1. V4A 重复 exact context 不能再静默选择最早位置；返回 one-based ambiguity candidates，workspace 不变。
2. context-not-found 且 fuzzy disabled、fuzzy candidates tie、fuzzy below threshold 的 typed diagnostics、模型 recovery text 和 `isError`。
3. 同 operation 多 hunk时保留准确 hunk index；partial operation semantics 不丢失独立已提交 operation。
4. fuzzy applied result保存 line range/score；ordinary exact 和 whitespace success 不扩大模型内容。
5. actual changed paths、partial applied/rejected grouping、6-candidate model cap、低质量 fuzzy candidate range suppression、details full report。
6. collapsed footer、warning partial glyph、expanded stable hunk diff、resume/global expand，以及 renderer 不读取 current workspace。
7. cancellation、baseline race、path conflict、invalid grammar 和 coordinator/native failures保持既有安全语义。
