# 关闭 `apply_patch` 的模型信息缺口

> 调研日期：2026-08-09  
> 范围：仅检查当前 `ext-tools` 源码/测试、随仓库 vendored 的 `mpatch` v1.6.4、已安装的 Pi 0.84.0，以及固定到 `d2e26e0e14c410152685fea56dcda48a6603044a` 的 `pi-codex-conversion` 源码。未修改产品源码、测试或 `DESIGN.md`。

## 结论

推荐做两件相互依赖的小改动：

1. 在 Rust bridge 解析 unified diff 后，清除每个 hunk 的 `old_start_line`，因为 V4A 编译器并没有真实源行号，当前写入的 `1` 会把重复文本静默选为最早位置。
2. 将 `mpatch` 的每个 hunk 结果以小型、判别联合的结构跨 N-API 传到 `ApplyPatchRejection`，并把失败诊断格式化进工具的 `content`。`details` 可以保留同一结构供日志/TUI，但不能是模型唯一来源。

这不需要新依赖、外部 `mpatch` 可执行文件、重新实现匹配器或把文件内容塞进工具结果。`mpatch` 已在 vendored Rust API 中持有所需的失败分类和候选位置；当前 bridge 先将其压扁为字符串，随后 TypeScript 仅检查退出状态。

## 已核验的运行时边界

仓库使用的是 `mpatch` v1.6.4 的 retained library source，N-API bridge 直接链接它；没有捆绑或启动独立 `mpatch` CLI。[版本与部署说明](../../packages/pi-ext-tools/UPSTREAM.md#L24-L28) [第三方声明](../../packages/pi-ext-tools/THIRD_PARTY_NOTICES.md#L3-L6)

已安装依赖实际解析为 Pi 0.84.0（`bun pm ls @earendil-works/pi-coding-agent`）。Pi 的 `AgentToolResult` 明确规定 `content` 是“returned to the model”，`details` 是日志或 UI 的任意结构数据；执行失败会被转换为仅含错误文本和空 `details` 的结果。[Pi agent-core 0.84.0 类型](../../node_modules/@earendil-works/pi-agent-core/dist/types.d.ts#L310-L324) [错误结果构造](../../node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js#L510-L538)

固定 revision 的 `pi-codex-conversion` 进一步证实该区分：它对 `toolResult` 只拼接 `content` 内 text block 作为 `function_call_output`，除 web-run 加密输出外不序列化 `details`。[Responses 转换器](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/providers/openai-responses/shared.ts#L193-L229) 其自身 `apply_patch` 也将可恢复失败、失败文件和“先 read 再重试”放进 `content`，成功的结构结果留在 `details`。[上游工具实现](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e26e0e14c410152685fea56dcda48a6603044a/packages/pi-codex-conversion/src/tools/apply-patch/tool.ts#L80-L204)

因此，“模型信息”应指下一轮模型实际收到的 `content`，不是 TUI 的 call renderer、`details` 或 native `stderr`。

## `mpatch` 实际可提供的信息

`apply_patches_to_dir()` 返回每个文件的 `Result<PatchResult, PatchError>`；`PatchResult.report` 包含每个 hunk 的 `HunkApplyStatus`，而非只有批处理成功/失败。[批处理结果](../../crates/vendor/mpatch/src/lib.rs#L1998-L2074) [逐 hunk 报告与 1-based `hunk_index`](../../crates/vendor/mpatch/src/lib.rs#L1800-L1948)

| 情况 | `mpatch` 的结构化信息 | 目前不能从该错误直接得到 |
| --- | --- | --- |
| 文本/上下文没有可用匹配 | `ContextNotFound`、1-based `hunk_index` | 候选行、实际文件文本、相似度 |
| exact 或忽略尾部空白后仍不唯一 | `AmbiguousExactMatch(Vec<usize>)`，每项是 0-based 起始索引 | 每项窗口长度；是否先经过尾空白匹配 |
| fuzzy 最高分并列 | `AmbiguousFuzzyMatch(Vec<(usize, usize)>)`，每项是 `(0-based start_index, length)` | 并列分数本身 |
| fuzzy 最佳项低于阈值 | `FuzzyMatchBelowThreshold { best_score, threshold, location }`；`location` 含 0-based `start_index` 和 `length` | 候选文本；除最佳项外的候选 |
| 成功 | `Applied { location, match_type, replaced_lines }`；`match_type` 为 `Exact`、`ExactIgnoringWhitespace` 或含 `score` 的 `Fuzzy` | 是否曾有多个候选但由行号 hint 选中 |

[失败枚举](../../crates/vendor/mpatch/src/lib.rs#L916-L1006) [成功状态和 match 类型](../../crates/vendor/mpatch/src/lib.rs#L1041-L1207) [位置的 0-based 与用户显示的 1-based 约定](../../crates/vendor/mpatch/src/lib.rs#L2631-L2715)

这里有两个边界：

- `ContextNotFound` 是“没有可用匹配”的分类，不是“预期文本与实际文本”的 diff。预期文本已在模型刚发送的 patch 中；要看当前文本仍应要求模型 `read` 该路径。
- 成功状态不记录“候选数”或“line hint 是否参与消歧”。若需要审计这种已成功但非唯一的选择，必须在 finder 决策仍持有候选集时扩展 vendored 报告；事后只凭 `Applied` 无法精确重建。

### V4A 当前阻断了大部分非唯一诊断

`mpatch` 找到多个 exact 候选时，会用 hunk 的 `old_start_line` 选择离该行最近的候选；没有 hint 或距离相同才返回 `AmbiguousExactMatch`。fuzzy 的并列最高分走同一规则。[exact 的 tie-break](../../crates/vendor/mpatch/src/lib.rs#L6207-L6314) [fuzzy 的 tie-break](../../crates/vendor/mpatch/src/lib.rs#L6636-L6716)

但 V4A 编译器对每个非空 hunk 固定生成 `@@ -1,... +1,... @@`，而不是源文件中的真实位置。[V4A 到 unified diff](../../packages/pi-ext-tools/src/apply-patch/parser.ts#L158-L176) 因此候选起点不同的重复文本会按距第 1 行的距离选择最早候选；对 distinct exact start index，这通常是唯一最小值，`AmbiguousExactMatch` 根本不会产生。fuzzy 也会偏向最早起点，除非并列项恰好共享 start index。

`Hunk.old_start_line` 是 public `Option<usize>`，finder 接收 `None` 时不做 line-number tie-break，因此 bridge 在 `parse_auto()` 后把它清为 `None` 即可恢复“无法可靠消歧即拒绝”的语义；无需复制 `mpatch` 的搜索算法。[`Hunk` 字段](../../crates/vendor/mpatch/src/lib.rs#L2225-L2288) [finder 的 `None` 分支](../../crates/vendor/mpatch/src/lib.rs#L6787-L6861)

## 当前信息在哪里丢失

```text
mpatch PatchResult.report.hunk_results
  -> bridge 仅产生 status/stdout/stderr
  -> checkedMpatch() 仅读取 status
  -> stageUpdate() 生成通用 Error
  -> ApplyPatchRejection.error
  -> tool content（模型可见）
```

1. Rust bridge 迭代 `batch.results`，对没有 clean apply 的 `Ok(PatchResult)` 仅写 `patch did not apply cleanly: <path>`；没有读取 `report.failures()`、hunk index、错误 variant、候选位置、阈值、成功 location 或 match type。`Err(PatchError)` 也仅走其 display 字符串。[bridge](../../crates/pi-ext-bridge/src/mpatch.rs#L164-L198)
2. JS/N-API 两侧的 `MpatchRunResult` 只有 `status`、`stdout`、`stderr`。这保留的是已被 bridge 压缩后的文本，而不是 native report。[生成的 N-API 声明](../../packages/pi-ext-tools/native/index.d.ts#L32-L47) [JS bridge](../../packages/pi-ext-tools/src/native-bridge.ts#L40-L63) [mpatch wrapper](../../packages/pi-ext-tools/src/apply-patch/mpatch.ts#L3-L27)
3. `checkedMpatch()` 对 dry-run 和实际 apply 都只比较 `status !== 0`，完全丢弃 `stdout/stderr`；`stageUpdate()` 最终只抛出“fuzzy disabled”或“Patch update failed”。故即使旧 `stderr` 有路径，也不会进入 rejection。[executor](../../packages/pi-ext-tools/src/apply-patch/executor.ts#L177-L216)
4. `rejectOperation()` 只能接到上述通用 `Error.message`，因此 `ApplyPatchRejection` 目前只有操作索引、路径和字符串错误；工具的 `formatApplyPatchResult()` 再将此字符串写到 `content` 和 `details`。[rejection 合约和收集](../../packages/pi-ext-tools/src/apply-patch/executor.ts#L34-L46) [错误压缩点](../../packages/pi-ext-tools/src/apply-patch/executor.ts#L285-L316) [模型可见格式](../../packages/pi-ext-tools/src/apply-patch-tool.ts#L62-L91)
5. 即使只给 `details` 新增诊断，对 Pi 0.84.0 + 固定 codex conversion 的下一轮模型仍不可见；必须同步生成简短文本 `content`。

## 推荐合约与传播方式

### 最小推荐

在 bridge 中将 `parse_auto()` 的可变 `patches` 的每个 `hunk.old_start_line` 设为 `None`，然后把 `PatchResult.report.hunk_results` 映射为无原文的 N-API 数组。对 V4A，缺少真实行号是已知事实，拒绝歧义比静默选择第一个候选更安全。

边界归一化规则：`hunkIndex`、`startLine` 均从 1 开始；`length` 保持匹配窗口长度；不传 `replaced_lines`、完整 patch、候选文本或源文件片段。后者没有解决匹配问题且会膨胀/泄露模型上下文；恢复动作仍是 `read <path>`。

```ts
type MpatchHunkOutcome =
	| {
			readonly kind: "applied";
			readonly hunkIndex: number;
			readonly startLine: number;
			readonly length: number;
			readonly match: "exact" | "exact_ignoring_whitespace" | "fuzzy";
			readonly score?: number;
		}
	| { readonly kind: "context_not_found"; readonly hunkIndex: number }
	| {
			readonly kind: "ambiguous_exact";
			readonly hunkIndex: number;
			readonly candidateStartLines: readonly number[];
		}
	| {
			readonly kind: "ambiguous_fuzzy";
			readonly hunkIndex: number;
			readonly candidates: readonly { startLine: number; length: number }[];
		}
	| {
			readonly kind: "fuzzy_below_threshold";
			readonly hunkIndex: number;
			readonly best: { startLine: number; length: number; score: number };
			readonly threshold: number;
		};

interface MpatchRunResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly outcomes: readonly MpatchHunkOutcome[];
}

interface ApplyPatchRejection {
	readonly operationIndices: readonly number[];
	readonly paths: readonly string[];
	readonly error: string;
	readonly diagnostics: readonly MpatchHunkOutcome[];
}
```

`outcomes` 是 native 边界的完整、可检查事实；`diagnostics` 应是导致该 operation 最终拒绝的最后一次 dry-run 或实际 apply 的 outcomes。成功路径可仅在出现 `fuzzy` 或 `exact_ignoring_whitespace` 时向模型摘要 location/match/score，避免每次普通 exact 成功增加上下文。

模型文本应是从同一 `diagnostics` 产生的小型确定性摘要，例如：

```text
Rejected operation 2: src/config.ts
Hunk 1: exact context is ambiguous at lines 18, 47. Read src/config.ts and retry with more surrounding context.
```

或：

```text
Rejected operation 2: src/config.ts
Hunk 1: no matching context. Read src/config.ts before retrying.
```

这使 `details`、TUI 和 `content` 共享一个事实源，同时不把 renderer 或 `stderr` 变成协议。

### 何时需要更深的 vendor 改动

上述合约能报告未消歧的歧义和文本失配。它不能说明“有多个候选但 `mpatch` 已用真实 line hint 成功选了一个”，因为当前 `Applied` variant 不携带该事实。只有未来输入确实带可信 unified-diff 行号、且需要审计该选择时，才扩展 vendored finder 的成功报告（例如 `candidateCount`、`lineHintUsed`、候选位置）。V4A 当前没有这种可信行号，先清除伪 hint 即可。

## 备选方案

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 仅把现有 `stderr` 写到 rejection/content | 不采用 | bridge 已将 report 压为路径字符串，无法恢复 hunk、错误种类、候选或分数；依赖展示文案。 |
| 只扩展 `details` | 不采用 | Pi 合约和固定 Responses 转换器都表明下一轮模型只看到 `content`。 |
| 在 TypeScript 重新扫描文件寻找候选 | 不采用 | 会重复 `mpatch` 的 exact/whitespace/fuzzy 和 tie-break 逻辑，易漂移且增加 I/O。 |
| 调低/提高 fuzzy 阈值 | 不采用 | 改变接受率，不提供歧义或失配原因，也不修复伪行号。 |
| 直接向模型附完整候选片段或文件 | 不采用 | 上下文、隐私和输出大小成本高；已有 `read` 可在路径和行号提示后按需取得当前内容。 |
| bridge 清除伪 hint + 传递 report + 格式化 `content` | 推荐 | 使用现有 `mpatch`/Pi 能力，最短路径同时阻止静默首个匹配并给模型可行动信息。 |

## 建议测试

以下是实现该合约时应新增或更新的聚焦测试；不要求引入测试框架。

1. **重复 exact 文本，V4A 端到端。** 文件在第 18、47 行各含相同删除上下文。`applyPatchInWorkspace()` 必须不改文件、拒绝该 operation；`diagnostics` 为 `ambiguous_exact`、`hunkIndex: 1`、`candidateStartLines: [18, 47]`，模型 text 含路径、行号和 read/retry 动作。这同时证明 bridge 清除了 V4A 伪 hint。
2. **完全失配且 fuzzy 关闭。** 保持现有“不改工作区”断言，并要求 `context_not_found` 出现在 rejection/details/content；不得只剩 “fuzzy is disabled”。当前相邻场景见 [executor 测试](../../packages/pi-ext-tools/test/apply-patch-executor.test.ts#L93-L121)。
3. **fuzzy 并列。** 两个不同窗口产生相同最高分，确认 `ambiguous_fuzzy` 含两个 1-based `{ startLine, length }`，不伪造分数；工作区不变。
4. **fuzzy 阈值不足。** 断言 `fuzzy_below_threshold` 保留最佳位置、长度、`score`、`threshold`；模型 text 不包含源文件片段。
5. **多 hunk 同一 V4A update。** 一个 hunk 成功、另一个失配；断言诊断的 `hunkIndex` 为 2，不能将整个文件压成无定位的失败。`mpatch` 的 report 正是逐 hunk 表示的。[报告结构](../../crates/vendor/mpatch/src/lib.rs#L1800-L1948)
6. **成功的非普通 exact。** 尾部空白匹配应为 `exact_ignoring_whitespace`；fuzzy 成功应保留 1-based location 和 score。工具文本至少对这两类显示匹配方式，避免当前“第一次 `fuzzFactor=0` 成功即 exact”的过度概括。
7. **模型边界。** 以工具结果为输入，断言 text `content` 含上述诊断；另断言仅把诊断放在 `details` 的对照结果不会被 fixed conversion 的 `convertResponsesMessages()` 输出。这防止将 UI/details 当作模型传输通道的回归。

## 来源清单

- 当前 HEPI bridge、V4A parser、executor、tool 与测试：本仓库 `crates/pi-ext-bridge/`、`crates/vendor/mpatch/`、`packages/pi-ext-tools/`，链接均指向本工作树对应源行。
- `mpatch` 来源版本：Romelium/mpatch v1.6.4；本仓库保存并链接其实际库源码，非独立 CLI。[归属声明](../../packages/pi-ext-tools/THIRD_PARTY_NOTICES.md#L3-L6)
- Pi：已安装 `@earendil-works/pi-agent-core` / `pi-coding-agent` 0.84.0 的 `.d.ts` 与编译 JavaScript。
- `pi-codex-conversion`：`IgorWarzocha/howaboua-pi-stuff`，提交 [`d2e26e0e14c410152685fea56dcda48a6603044a`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d2e26e0e14c410152685fea56dcda48a6603044a)；本次核验的本地 clone HEAD 与该提交完全一致。
