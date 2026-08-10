# Apply Patch 结果架构

> 状态：已实现。本文定义 `pi-ext-tools` 的 Codex V4A `apply_patch` 结果、模型信息和 TUI 合约；当前运行时边界见 [ext-tools README](../ext-tools/README.md)，bridge 现况见 [pi-ext bridge](pi-ext-bridge.md)，术语以仓库根目录 [CONTEXT.md](../../CONTEXT.md) 为准。

## Contract

`apply_patch` 必须把一次 V4A request 的实际结果，而不是请求 patch 或 renderer-local state，同时交给模型、TUI、Trace collapse 和 session resume。

- 合规 operation 独立提交；一个 rejection 不回滚其他已提交 operation。
- 任何 partial 或 failed request 对 Pi host 标记为 error；模型内容必须明确哪些 operation 已提交、哪些可重试。
- V4A 不包含可信源行号。重复上下文不得因伪造 unified-diff line hint 而静默选择文件中最早位置。
- 完成后的 TUI 只读取实际结果。展开的 diff 是提交当时的稳定 hunk snapshot，不重读可能已变化的 workspace。

```text
V4A patch
  -> parser + path validation
  -> staging exact/fuzzy mpatch attempt
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

一次 V4A operation 产生一个 Patch Outcome。它是唯一的结果事实源：

```ts
type PatchOutcome = {
  status: "success" | "partial" | "failed";
  applied: AppliedOperation[]; // each operation owns its changed-hunk snapshots
  rejected: RejectedOperation[];
  changedPaths: string[];
};
```

- `applied` 保存 operation index、动作、实际 changed path、每个 hunk 的 native match outcome，以及提交时的 before/after changed-hunk snapshot。
- `rejected` 保存 operation index、目标 path、稳定的 non-native rejection reason，和导致最终拒绝的最后一次 dry-run 或 apply diagnostics。
- `changedPaths` 仅来自实际 commit，不从 request 推导。
普通 exact 成功不向模型逐 hunk 展开。fuzzy 成功向模型报告 path、hunk、实际 line range 和 score；exact-ignoring-whitespace 作为普通成功隐藏。fuzzy 成功不强制额外 `read`，但其事实仍可在 details/TUI 中审计。

partial 保留成功 operation。`tool_result` handler 根据 Outcome 的 `partial`/`failed` 设置 `isError: true`；这不替代模型文本中的 recovery，也不通过 throw 丢失已提交结果。

## 模型内容

模型只接收 deterministic text `content`，不接收 `details` 或 TUI render tree。

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

Recovery: read src/routes.ts around lines 18 and 47, then retry only operation 2.
Do not retry applied operations.
```

`context_not_found` 的 recovery 是读目标 path 后只重试 rejected operation。`fuzzy_below_threshold` 总会给 score 与 threshold，只有 score 严格高于 `threshold * 0.7` 才给最佳 candidate line range；ambiguous fuzzy 的候选共享一个已达 threshold 的 top score。模型内容每个 ambiguity 最多显示 6 个 candidates，并标示总数；完整 facts 仍在 details，不能因 TUI collapse 丢失。

## TUI

执行中，coordinator 在 preflight 后发送 typed Patch Progress，之后每个 commit/rejection 发送下一份全量 snapshot。live state 只属于当前 Trace：`○` 是尚未 commit，`✓` 是 exact/whitespace commit，`!` 是 fuzzy commit（dim score），`✗` 是 rejection。header 的 `+/-` 只累计已 commit operation；row 同时显示 planned delta。final `Patch Outcome` 替代 live state，resume 不恢复 `○` rows。

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

- dry-run、fuzzy attempt、staging apply 与 baseline revalidation 全都服从既有 `AbortSignal`/bridge cancellation。取消不产生 partial diagnostics 或 speculative snapshots。
- 同 path jobs 保持 coordinator serialization；无交集 path jobs 保持现有 worker concurrency。
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
