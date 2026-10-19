# Apply Patch 结果架构

> 状态：已实现。本文定义 `pi-apply-patch` 的 Codex V4A `apply_patch` 结果、模型信息和 TUI 合约；当前运行时边界见 [ext-tools README](../ext-tools/README.md)，术语以仓库根目录 [CONTEXT.md](../../CONTEXT.md) 为准。逐 path Publish 见 [ADR-0018](../adr/0018-apply-patch-per-path-publish.md)。

## Contract

`apply_patch` 必须把一次 V4A request 的实际 Path Outcome，而不是请求 patch 或 renderer-local state，同时交给模型、TUI、Trace collapse 和 session resume。

### 执行

- local Linux/macOS/Windows 使用同一套 Patch Core。没有 detached coordinator、request id 重连或 request-level rollback。
- 每个 path 独立 Publish：sibling 临时文件 + replace/remove 确认后才是 Changed。已确认 path 不撤回。
- 同一 `Update File` 的 hunk 依 patch 顺序作用于同一 staging copy。失败 hunk 记为 Rejected，但不阻止后续 hunk 尝试；至少一个 hunk 成功时，以成功 hunk 的 staging 结果只 Publish 一次，并把该 operation 标为 `partial`。没有 hunk 成功时该 path 为 Rejected，原档不动。多个没有 `Move to` 的 `Update File` 按 patch 顺序作用于同一文件。`Update + Move to` 是 dest Publish 与 source delete 两次独立 mutation。
- live progress 阶段为 `parsed`、`publishing` 与 `done`。model-time preview 与 `parsed` 都不代表已验证或已 Publish。
- 完成后的 TUI 只读取实际结果。展开的 diff 是 Publish 当时的稳定 hunk snapshot，不重读可能已变化的 workspace。

### 验证与并发

- 语法错误、缺原子 replace 在任何 path 改变前拒绝整次 request。同一 workspace 的 apply_patch / edit / write 共用一把 mutation lock；后到的请求排队，取消排队中的请求不会改 workspace。
- patch bytes、operation 数、hunk 数和 hunk 行数有硬上限；超限在 mutation 前拒绝，要求模型拆分 patch。
- V4A 不包含可信源行号。重复上下文不得因伪造 unified-diff line hint 而静默选择文件中最早位置。
- `@@ 文本` 是顺序定位锚点，不是注释；后续 hunk 只在锚点限定范围匹配，锚点不存在时不得退回全文搜索。`*** End of File` 将匹配限定在文件末尾。没有内容 hunk 的 `Update File` + `Move to` 是纯移动，保留源文件字节。
- Update 保留源文件换行风格与末尾换行状态，未修改的混合换行行不应被全局归一化。
- 发布前重新核对已读取的源基线；确定的外部修改归为 Rejected，不覆盖或删除该内容。Move 目标确认发布后，删除源前仍核对源；此时冲突保留已发布目标并报告源拒绝，不回滚目标。
- 复核与 rename/remove 不是原子 compare-and-swap，检查后的外部写入仍存在竞态窗口；不得将此机制描述成阻止所有外部修改。

### 诊断与恢复

- local V4A path 可为绝对或相对 path。相对 path 从 workspace root 解析，允许以 `..` 到 workspace 外；判断只做 lexical resolve，不 `realpath`，所以 workspace 内 symlink 指向外部不会被当成外部写入。实际 Changed 的 local path 在 lexical workspace 外时，模型 result 末尾必须给出一行 warning；Rejected、Unconfirmed 与 NotApplied 不警告。
- 仅 Changed+Rejected 且无 Unconfirmed/NotApplied 时为 `partial`、`isError: false`。出现 Unconfirmed 或 NotApplied 时 `isError: true`，已 Changed 的 path 仍报告。
- 一次调用应包含本次所有文件变更；多余的 `*** Begin Patch` / `*** End Patch` 只保留最外层一对。

```text
V4A patch
  -> parser + structural path validation
  -> mutation lock
  -> per-path sequential hunk staging
  -> Publish once when at least one hunk succeeded
  -> Patch Outcome
     +-> model content
     +-> structured details
     +-> TUI / collapsed footer
```

## Ownership

`pi-apply-patch` 拥有 V4A parse、内部单 hunk unified-diff 编译、jsdiff worker 匹配、local path resolution / external-write warning、Publish、共享 mutation lock 的调用、`fuzzFactor` admission、Patch Outcome、model formatter、Pi `tool_result` error marking、renderer 和 Trace footer。

ext-core 不拥有 patch policy 或结果；它只提供已有的 shared lifecycle primitives。没有自有 N-API bridge 或 vendored mpatch。

## jsdiff matching contract

V4A compiler 生成内部 unified diff 时没有真实旧行号。路径只来自已解析的 V4A operation；jsdiff header 不得选择文件。每个 Update hunk 先在 worker 内做 exact 候选扫描：重复 exact 一律拒绝，不因伪造 `@@ -1` hint 选择最早位置。

`fuzzFactor` 默认 `0`。全局 settings 可显式设为整数 `2`；project 只能收紧，不能高于 global。这是 jsdiff 的行编辑 context 容差，不是相似度分数，也不是最大行偏移。`fuzzFactor: 0` 仍会搜索 offset；删除行必须匹配，插入点附近 context 保持 exact。开启 fuzzy 时接受 jsdiff first-fit，不承诺 fuzzy 歧义检测，也不保留 mpatch 的多候选评分。

每个 Update 的全部 hunk 在一个短生命周期 worker thread 中顺序作用于内存 copy。worker 不写 staging 目录、不启动 native process。取消 `terminate()` 该 worker。文件上限仍为 32 MiB。

匹配计算集中在 package 内部的同步模块 `jsdiff-matching.ts`：输入为源字节、逐 hunk 的 V4A 与内部 unified diff、`fuzzFactor` 和 snapshot path，输出为 `PreparedPatchUpdate`。它不拥有线程、文件 I/O 或取消信号；生产环境只由 worker 调用，匹配测试可直接调用。worker 入口只负责执行与结果/错误回传；`jsdiff.ts` 继续拥有启动、取消、退出清理与跨线程结果验证。匹配规则使用内存表驱动测试，线程传输、错误和取消保留真实 Worker 测试，文件发布、锁与恢复由 executor 测试覆盖。

worker 只从 `@hheei/pi-ext-core/errors` 取共享的 error helper：导入 ext-core 桶入口会让每个 worker 先把整套 ext-core 模块图载入新线程（实测每次 operation 约 220ms，一个多文件 patch 每个文件各付一次）。新增 worker 依赖时保持这条边界，不要在 worker 内引用桶入口。

```ts
type PatchHunkOutcome =
  | {
      kind: "applied";
      hunkIndex: number;
      startLine: number;
      length: number;
      match: "exact" | "fuzzy";
    }
  | { kind: "context_not_found"; hunkIndex: number }
  | {
      kind: "ambiguous_exact";
      hunkIndex: number;
      candidateStartLines: number[];
    };
```

`hunkIndex` 与 `startLine` 都是 one-based；`length` 是匹配窗口行数。`context_not_found` 不伪造 candidate 或 expected-text diff；模型已提交 patch，需要当前文本时调用 `read`。不再报告 `exact_ignoring_whitespace`、`ambiguous_fuzzy`、`fuzzy_below_threshold` 或 similarity `score`。

## Patch Outcome

一次 V4A operation 产生一个 Patch Outcome。`Update File` 的全部 hunk 共享一份 staging copy，依序尝试；成功 hunk 修改 staging，拒绝 hunk 只记录 diagnostic，后续 hunk 继续尝试。至少一个 hunk 成功时只 Publish 一次；零个成功 hunk 不 Publish。它是唯一的结果事实源：

```ts
type PatchOutcome = {
  status: "success" | "partial" | "failed";
  applied: AppliedOperation[];
  rejected: RejectedOperation[];
  unconfirmed: RejectedOperation[];
  notApplied: RejectedOperation[];
  changedPaths: string[];
};
```

- `applied` 保存 operation index、动作、实际 changed path、每个已确认 hunk 的 match outcome，以及 Publish 时的 before/after snapshot。
- `rejected` 保存确定未写入的 path 或未应用 hunk：hunk mismatch、已存在的 Add、过大文件等。partial Update 同时有一条 `applied` 和一条带 hunk diagnostics 的 `rejected`。
- `unconfirmed` 是 replace/remove 已发出但未见确认。必须先 `read` 再 mutation。
- `notApplied` 是从未发出 replace/remove，通常因为前面的 path 已经 halt。
- `changedPaths` 仅来自确认后的 Publish，不从 request 推导。

普通 exact 成功不向模型逐 hunk 展开。fuzzy 成功向模型报告 path、hunk 和实际 line range，不带百分比或 score。fuzzy 成功不强制额外 `read`。

## 模型内容

工具定义只保留必要语法和一次批量提交要求。停用的 `apply_patch` 不注入额外 prompt，不拦截流式 shell 命令，不中止或唤醒回合；可用工具由 Pi host 的 active catalog 决定。

模型只接收 deterministic text `content`，不接收 `details` 或 TUI render tree。结果只报告执行事实与诊断，不追加 `Next:`、Recovery 或重试指令。解析失败保留原始原因与 V4A source 行号，parsed preview 不代表验证或 applied；异常保留原始原因，不通过关键词分类追加提示。

成功结果列出真实 changed paths。若一个已确认的 local change 以 lexical path 落在 workspace 外，末尾附加一条 warning：

```text
Applied patch: 2 operations in 2 files.
Changed:
- src/config.ts: updated
- src/routes.ts: updated

Fuzzy-applied:
- src/routes.ts, hunk 1: lines 42-49, fuzzy

Warning: changed path outside the workspace: /tmp/config.ts
```

partial 结果明确区分 Changed / Rejected / Unconfirmed / NotApplied。`context_not_found` 只报告路径、operation、hunk 与匹配失败原因；ambiguity 报告路径、operation、hunk、最多 6 个候选起始行号和候选总数，完整候选仍保存在 details。模型依据这些事实自行选择 read、search 或其他后续操作。Unconfirmed 仍表示写入结果未知，不得当作未写入；取消也不回滚已确认的 Changed。

## TUI

模型生成 arguments 时，TUI 只走纯计算的 call renderer：partial `args.patch` 每出现一个已换行的 operation header 就增加一行 `󰄰 create|modify|delete path`，hunk `+/-` 行到达后更新 planned delta。该 preview 不得读取 workspace、取得锁或声称 validated/applied。`execute()` 仍只在完整 tool 参数后开始。

执行中，Patch Core 在完整 envelope 通过后发送 typed Patch Progress，每个 path Publish 或拒绝后再发下一份 snapshot。live state 只属于当前 Trace：状态 glyph 使用 Nerd Font 字符 `󰄰` pending、`󰄴` applied、`󰪠` partial、`󰾞` fuzzy、`󰘥` unconfirmed、`󰍷` not applied、`󰅚` rejected（`edit`/`write` 的远端 Unconfirmed/NotApplied 行复用后两者）：`󰄰` 尚未 Publish，`󰄴` 是 exact/whitespace Changed，`󰪠` 是 Changed+Rejected partial（显示 `N/M hunks applied` 与拒绝原因），`󰾞` 是 fuzzy Changed，`󰅚` 是 Rejected，`󰘥` 是 Unconfirmed，dim `󰍷` 是 NotApplied。header 的 `+/-` 只累计已确认 operation。final Patch Outcome 替代 live state，resume 不恢复 `󰄰` rows 或 model-time preview。

未展开的完成结果显示 operation rows；prior Trace collapse 由 shared frame 显示 header、空行、tool-owned footer。footer 是 typed metrics，不解析模型 content：

```text
created 1 · modified 1 · +10 -2 lines · 10ms
```

warning glyph `󰪠` 用于 Changed+Rejected partial；Unconfirmed/NotApplied 由 host `isError: true` 呈现。

展开时：

- applied operation 使用 outcome-time `snapshots` 和 pix split/unified renderer 显示 changed hunks；不会因后续操作改变历史 diff。
- fuzzy hunk 显示 path 与 line range，不显示 score。
- rejected / unconfirmed / not-applied 显示 path 与 diagnostic，不追加恢复指令或嵌入源代码。

颜色只作补充。path、operation/hunk 标识、match kind 与 diagnostics 必须在无颜色时可区分。

## 生命周期、取消与并发

- parser、path 与 matching failure 保留稳定错误分类；parser errors 带 source line（若有）。transport 失败不能被静默重试。
- 准备、jsdiff worker 与 Publish 服从 `AbortSignal`。取消不撤回已 Changed 的 path。尚未发出 replace/remove 的为 NotApplied；已发出未见 ACK 的为 Unconfirmed。
- local 无逾时，只靠取消。
- mutation lock 串行化 apply_patch、write 与 edit：按 local workspace，原语为平台原生 exclusive lock。后到的请求排队直到持锁者释放；取消排队中的请求不会取得锁、也不会改 workspace。锁不能阻止外部写入；apply_patch 的源基线复核只提供上述尽力而为的冲突检测。
- `/reload` 取消 execute，不重连进行中的 mutation。
- 现有文件（含 Delete 与 Move 源）大于 32 MiB 在读完整内容前拒绝；Add/Update 结果也不得超过 32 MiB。
- details 是 result persistence source；resume 和 global expand 从它渲染 completed outcome，不恢复 pending preview state。

## 验证

聚焦测试至少覆盖：

1. V4A 重复 exact context 不能再静默选择最早位置；返回 one-based ambiguity candidates，workspace 不变。
2. context-not-found 且 fuzzy disabled、以及 fuzzy first-fit 成功的 typed diagnostics、模型 recovery text 和 `isError`。
3. 同 operation 的成功 hunk 按顺序 Publish 一次、失败 hunk 保留 diagnostics；零个成功 hunk 时整档不 Publish。
4. fuzzy applied result 保存 line range，不保存 score；ordinary exact 不扩大模型内容。
5. actual changed paths、Changed/Rejected/Unconfirmed/NotApplied grouping、6-candidate model cap。
6. collapsed footer、warning partial glyph、expanded stable hunk diff、resume/global expand，以及 renderer 不读取 current workspace。
7. 取消保留已 Changed path；后到的 mutation 排队直到锁释放或排队请求被取消；过大文件拒绝。
8. 多个 `toolcall_delta` 在 `toolcall_end` / `execute()` 之前逐步更新 call preview；abort 在 execute 前不 Publish；两条并行 preview 的 state 不串线。
9. 锚点定位、缺失锚点、范围内歧义、EOF 与纯移动；CRLF、LF、无末尾换行和未修改的混合换行行。
10. 准备期间源发生外部修改时 Update/Delete/Move 拒绝；Move 目标发布后源冲突保留两者并如实报告。
