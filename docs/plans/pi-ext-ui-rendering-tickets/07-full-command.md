# 07：展开 bash 能检查完整命令

**依赖：** 03；持久化/跨包契约扩大必须另确认。**状态：** 实现完成（F1/F2 + resume + python 嵌套 + 上限入口，未提交）；待 parent 跑全仓 typecheck 与真实 host integration 验收。
**来源：** 排查第 5.2 节。

## 交付

分开 compact summary 与完整 request。检查顶层 bash、codemode 捕获参数、python_eval 有界摘要三条路径，不能仅取消 header 的省略号。

## 验收条件

- [ ] 确认用户 rg 示例来源；若无会话记录，记录无法唯一归属，并用三条路径分别构造可复现用例，不宣称找到了原调用。
- [x] 顶层 bash：Level 0 允许摘要；打开详情可看到完整 args.command，长行换行，多行保留顺序；耗时不挤掉请求正文。（F1）
- [x] codemode 嵌套 bash：从原 args 构建详情，而不是 70 字符 inline summary；完整请求与结果可区分，copy 不复制截断摘要。（live 用捕获 args；resume 用分支 `nestedCalls`）
- [x] python_eval：查明完整 args 是否在事实账本/会话可恢复。现有 EvalTrace/EvalCall 的 72 字符摘要不能冒充完整请求；恢复方案含 live、resume 和旧数据行为。（live 用 tracker，resume 用分支 `nestedCalls`；旧数据显式提示）
- [x] 若 python_eval 需要持久化或跨包读取变更，先记录数据 owner、保存/清理/读取失败行为及大小限制，取得批准再实现；未解决完整请求入口前本票不得标 done。（批准为 D4-B：只读公开 `sessionManager.getBranch()`，不新增持久化）
- [x] 历史记录仅有摘要且不可恢复时明确提示，不能猜补命令；新记录保证完整命令有可检查入口。超展示上限给真实完整路径/入口，不静默截断。（F2；上限提示入口仍是 D3）
- [x] 覆盖 >120 字符、多行、引号、glob、管道、Unicode 和终端控制序列；展示安全剥离控制序列不改变执行命令，copy 规则明确且与原请求一致。（F1/F2）
- [x] 三条路径都有聚焦测试，含请求末尾唯一标记的断言，证明展开不是仍只显示摘要。（顶层 bash、codemode live/resume、python_eval 顶层与嵌套 board 均已覆盖）

## 验证

改动文件 Biome；受影响 ext-ui 与 python-eval 测试、对应 package build。公共类型/持久化数据契约变化升级 typecheck，补恢复测试；真实 kernel 路径改变时补对应 integration。拒绝以修改快照接受缺失内容。

## 排查结论（只读，2026-10-14）

方法：先 `graphify query` 定位，再读源码核实；未运行 kernel、子代理、测试；未改实现/测试/DESIGN/README。上游依据为本地安装的 `@earendil-works/pi-coding-agent@1.3.0`。锚点取自排查时的工作树；06 等票的在途未提交改动会移动行号，实现前以符号名重新定位（`renderer.ts` 的 `renderOwnedPresentation` 已新增 `header.meta`，把耗时移出摘要）。

### 顶层 bash：请求正文已存在，缺的是展示安全、精确 copy 和上限入口

- 请求权威来源是 `args.command`（assistant toolCall.arguments，随 session 持久化），没有数据丢失。
- 正文已从原 args 构建：`renderer.ts:95-118`（`createInputCodeSection`，首行 `$ `、后续两空格）+`renderer.ts:457`。上限：Level 1 每 section 9 行（`tool-view.ts:92,556`），Level 2 500 行（`:93`）与 64KB（`:94,583-586`）。
- Level 0 只有 header：bash 没有 `collapsedRows`，折叠态看到的是摘要（本票允许）。摘要由 `renderer.ts:121-160` 在 120 列渲染上游 `renderCall` 后取首个非空行（上游 `renderers/bash.js:13-21` 的 `formatShellCall` 输出 `$ <command>` + timeout），并剥掉 `$ `（`renderer.ts:141-143`）。因此多行命令只剩第一行、宽命令在 120 列处被截断，且这一步是"反向解析原生视图"，还会触发上游 `startToolTimer` 副作用。
- 耗时不挤占正文：耗时拼在 header 尾部（`renderer.ts:369-390`），正文独立；窄宽下先被截断的是摘要尾部。
- 展示未剥离控制序列：`createInputCodeSection` 只去 `\r`/替换 `\t`（`renderer.ts:104-105`），没有 `stripTerminalSequences`；而 `DESIGN.md:123` 明确要求命令正文 "terminal escapes stripped"。命令里的 CSI/OSC 会原样进入 TUI 行。
- copy 与请求不完全一致：`renderer.ts:528-533` 的 primary 来自 `extractHeavyInputCommand`，该函数对 command 做 `.trim()`（`payload-parser.ts:200-213`）；full 是 trim 后命令 + `\n---\n` + 已剥离输出。首尾空白丢失，控制序列保留。
- 上限提示没有指向真实入口：`tool-view.ts:580-588` 只给 `… (N more lines)` / `64KB`；且 N 按逻辑行计（`:556-573`），单条超长行被折行截断时报 "1 more lines"，与实际隐藏的折行数不符。copy（shift+click）本身仍持有完整请求。
- 结论：本票"顶层 bash 看不到完整命令"不是数据丢失，而是折叠态只有 120 列首行摘要 + 正文未剥离 + 上限提示不提 copy。

### codemode 嵌套：live 路径已基本满足，resume 才丢请求

- live：tracker 捕获原 args（`tracker.ts:28-56`；`renderer.ts:328-339`；session 关闭清理 `extension.ts:68`）。折叠行是 70 字符摘要（`payload-parser.ts:389-405`）。展开子体用原 args 走 child renderer，显示 `$ <command>` 正文（`nested-calls-view.ts:401,430-475`）；已有测试 `collapsible-tool-frame.test.ts:743-830` 证明展开显示 `$ echo hello`、copy 得到原命令。审计 5.2 第 1 条"展开只显示 detail"对当前 NestedCallsView 路径已过期；`ToolGroupView.#renderTools` 也是渲染成员组件本身（`tool-group-view.ts:400-421`），不降级展开。
- live 缺口：折叠行摘要就是全部可见文本（展开需要点击行，可发现性差）；copy 对整段调用 `stripTerminalSequences`（`nested-calls-view.ts:252-263`），含控制序列的命令 copy 后与原请求不一致。
- resume/legacy：tracker 为空；`extractNestedCalls` 读 `result.details.calls`（`payload-parser.ts:214-230`），上游 codemode 只把 args 存成 200 字符 JSON 预览（`extensions/codemode/execute.js:12,29-33,412`）。`NestedCallRecord` 没有 args/result，展开落到 `(no output)`（`nested-calls-view.ts:508-515`）；copy 回退到 `call.summary`（`:82-85`），把 200 字符预览当请求复制，直接违反本票"copy 不复制截断摘要"。
- host 有权威副本但 UI 不可达：toolResult 消息的 `nestedCalls` 保存 arguments（每次 ≤8KB、总计 ≤32KB、≤256 次；`core/nested-tool-calls.d.ts` 的 `NESTED_CALL_LIMITS`），写入点 `core/agent-session.js:719-721`；但渲染器只收到 `{ content, details }`（`modes/interactive/components/tool-execution.js:243`），1.3.0 里工具渲染拿不到。

### python_eval：live 与 resume 都没有完整请求入口

- 顶层 cell source 是权威的 `args.code`，但 presentation 用的是 `.trim()` 后的 code（`presentation.ts:178`）做 summary/request/copy（`:203,236,249`），同样不是字节一致；source 走 `highlightCode`（`:257-266`）。
- 嵌套：`EvalNestedTrace.args` 确实存在（`bridge.ts:22,115`），但 `boundedTrace` 直接丢弃（`transcript.ts:262-271`），只留 72 字符摘要（`presentation.ts:19,330-340`）；`EvalTrace`/`EvalCall` 没有 args 字段（`:26-33,61-68`），details 持久化的 `calls.items` 也只有 summary（`tool.ts:185-192`）。
- 折叠行是预格式化字符串（`presentation.ts:242`），没有 handleMouse、没有 copy、没有展开入口；`renderOwnedPresentation` 优先返回 `presentation.collapsedRows`（`renderer.ts` 的 `collapsedRows` 立即返回分支，排查时 :690-692），因此紧随其后的 tracker 分支（:693-709）对 python_eval 永远不执行。resume 和 legacy 同样没有入口。
- 持久化完整 args 已被明确否决：`eval-frame.test.ts:590-606`（"persists a nested call's summary instead of its arguments"）与 72 字符上限测试 `:608-621`。
- 与 codemode 相同，host `nestedCalls` 存有完整 args（≤8KB），但渲染器不可达。

### 数据归属与可恢复性

| 路径 | 权威请求来源 | live | resume | legacy |
| --- | --- | --- | --- | --- |
| 顶层 bash | assistant toolCall.arguments | 完整 | 完整 | 完整 |
| 顶层 python_eval | args.code | 完整（展示/复制被 trim） | 完整 | 完整 |
| codemode 嵌套 | tracker（live）/ details.calls 200 字符预览 / host nestedCalls ≤8KB | 完整 | 仅预览，不可恢复 | 同 resume |
| python_eval 嵌套 | kernel trace args（进程内）/ details.calls 72 字符摘要 / host nestedCalls ≤8KB | 进程内即丢弃 | 仅摘要 | 同 resume |

### 证据缺口（不宣称找到原调用）

- 用户 rg 截图没有附 toolCallId、session 路径或原始参数，无法唯一归属到上面三条路径；`docs/plans/pi-ext-ui-rendering-audit.md:151` 已记录同一限制。本票不宣称找到原调用，只用三条路径分别合成用例。
- 仓库没有含 `nestedCalls` 的 session JSONL fixture（全仓仅文档提及），也没有覆盖 resume 嵌套 args 的测试；因此"resume 不可恢复"是读源码得出的结论，未做真实会话回放。
- 未检查用户 `~/.pi` 下的历史会话（隐私与范围外）。

## 最小可持续修复

### 本地可做（不新增持久化、不改跨包契约）

- **F1 展示剥离、copy 原样**：`createInputCodeSection`（`renderer.ts:95-118`）只对展示行 `stripTerminalSequences`，保留原始 args 供 copy；copy 的 primary 改用未 trim 的 `args.command`/`args.code`（`payload-parser.ts:200-213` 的 trim 只用于展示）。统一规则：**copy = 请求原文 + 已剥离的输出**；把 `nested-calls-view.ts:258-261` 与 `renderer.ts` copy 构造处的 strip（排查时 :678-681）收窄到输出部分。
- **F2 历史不可恢复显式化**：删掉 `nested-calls-view.ts:82-85` 把 `summary` 当请求 copy 的回退；`NestedCallRecord` 展开时显示明确的 "request not recorded (summary only)" 行，而不是 `(no output)`。python_eval 在没有 captured args 时给一行 dim 提示，说明本会话只记录了摘要。
- **F3 python_eval live 入口**：`renderOwnedPresentation`（`renderer.ts:677-700`）在 `presentation.children` 带 id 且 `getCapturedNestedCalls(context.toolCallId)` 覆盖全部 children 时，用 `NestedCallsView`（children + tracker args）替代静态 collapsedRows；否则回退静态行 + F2 提示。只复用现有 `ToolPresentationChild.id`（`pi-ext-core/src/tool-presentation.ts:36-42`）与 tracker，无新持久化。注意 `bridge.ts:65,93` 的失败分支用本地 `eval-<uuid>`，与 host id 不同：按 id 匹配不全时整体回退，不做部分匹配。

### 需 owner 决策/批准（本票不实现）

- **D1 header 语义冲突**：`DESIGN.md:123` 要求 bash "header 只放 call facts，命令只出现在正文"，本票却允许 Level 0 摘要；当前实现是"120 列首行摘要"。06 的在途改动已把耗时放进 `header.meta`（`tool-view.ts:35,166-195`），不再占用摘要文本。是否保留折叠态命令摘要仍需 owner 决定（同时影响 06 的 header 着色），决定前不动 header。
- **D2 交互与提示行**：F3 让 python_eval 折叠行可点击、并新增提示行，需在 `DESIGN.md:136` 补一句（本票不改 DESIGN）。
- **D3 上限入口提示**：让截断提示指向 copy 需要给导出的 `RailSection`（`tool-view.ts:22-27`）加可选字段，或让 ToolView 依据 copy 生成提示，属 ext-ui 公共类型变更，需批准；否则保留计数提示，只在 DESIGN 写明 copy 规则。
- **D4 resume 完整请求**（三选一，均需批准）：
  - A（推荐，最小）：保持现有持久化，resume 只显示摘要 + F2 明确提示。无数据契约变化。
  - B：ext-ui 从 host `sessionManager` 读 toolResult 消息的 `nestedCalls`。owner=host；大小 ≤8KB/次、≤32KB/总计、≤256 次；只读、无清理；读取失败或 legacy 缺失回退摘要；需按 toolCallId 建索引并处理 session 替换。属新的跨包持久化读取。
  - C：python_eval 持久化有界请求预览。owner=pi-python-eval；需定大小上限、清理、resume/legacy 与失败行为；与 `eval-frame.test.ts:590` 的既有决定冲突。
- **D5 范围**：未知工具解析（09）、delegate、04/05 的 tail/footer 不在本票。

## 复现与断言设计（含末尾唯一标记）

- 标记：命令末尾放 `ZZ_TAIL_<id>`；覆盖 >120 字符、>720 字符（Level 1 折行上限）、多行、引号、glob、管道、Unicode、控制序列（`\x1b[31m`、`\x1b]0;x\x07`）。
- 顶层 bash（fixture：`pi-ext-tools/test/fixtures/harness.ts` 的 `toolHost`/`toolFor`，`optional-renderers.test.ts:31-50` 的 context）：Level 0 行无标记且含 `…`；Level 1 行含标记、多行顺序为 `$ line1` / `  line2`，宽度 30/80/120；超过折行上限时提示数字与实际隐藏行一致；copy primary 与 `args.command` 字节相等（含首尾空白与控制序列）；展示行不含 `\x1b`。
- codemode live（fixture：`collapsible-tool-frame.test.ts` 的 `createMockContext` + `recordToolExecutionStart/End`，:743-830 模式）：折叠行摘要无标记；点击行后正文含标记；shift+copy 与原命令字节相等。
- codemode resume：构造带 200 字符 JSON 预览的 `details.calls`，断言展开显示 "request not recorded"、clipboard 从未收到该预览。
- python_eval live（fixture：`eval-frame.test.ts` 的 stub runtime + `hostText`/`nativeHost`；`eval-presentation.test.ts` 的 `nestedTool`）：F3 后点击行正文含标记、copy 精确；无 tracker 时只有静态行 + 提示，不出现标记。
- python_eval resume：只给 details，断言提示行存在、无标记、无 copy。
- 安全断言：任何渲染行不含 ESC；copy 保留 ESC；用 `visibleWidth` 校验窄/宽布局。

## 实现后的验证

- `pnpm exec biome check <changed files>`
- `pnpm exec vitest run packages/pi-ext-ui/test/collapsible-tool-frame.test.ts packages/pi-ext-ui/test/tool-header.test.ts packages/pi-ext-tools/test/optional-renderers.test.ts packages/pi-python-eval/test/eval-presentation.test.ts packages/pi-python-eval/test/eval-frame.test.ts`
- `pnpm --filter @hheei/pi-ext-ui run build`、`--filter @hheei/pi-python-eval run build`、`--filter @hheei/pi-ext-tools run build`
- 若采纳 D3（ext-core/ext-ui 类型变更）升级 `pnpm run typecheck`；不改 kernel 路径则不需要 `test:integration`。
- 完成后 `pnpm run verify:changed`（含 `graphify update`）。

## 本轮实现（F1/F2，未提交）

### 代码

- `packages/pi-ext-ui/src/payload-parser.ts`
  - `extractHeavyInputCommand` 返回请求原文（不再 `trim`），只有全空白请求视为无请求（`undefined`），保留原空输入语义。
  - bash 的 `formatArgumentSummary` 先 `stripTerminalSequences` 再截 70 字符，避免把控制序列截半留下 `[0m` 残片。
- `packages/pi-ext-ui/src/renderer.ts`
  - `createInputCodeSection` 只对展示文本 `trim` + 剥离控制序列后再 highlight/分行；copy 仍用请求原文。
  - call 与 result 两处 copy primary 直接使用 `extractHeavyInputCommand` 的原文；`full` 仍是"请求原文 + `---` + 已剥离输出"。
- `packages/pi-ext-ui/src/nested-calls-view.ts`
  - `extractChildToolCopyText` 删除"用 summary 冒充请求"的回退；没有 args/result 时返回空串。
  - 新增内部 `requestCopyText`（bash command / codemode、python_eval code / write content）与 `copyText`：只有当 copy 文本以请求原文为前缀时保留请求字节，仅剥离其后（结果）部分；否则整段剥离。
  - `#triggerCopy` 无内容可复制时不写剪贴板，复用既有失败反馈显示 `✗`。
  - `#renderChildBody` 对只有摘要的持久化记录显示 `(request not recorded; summary only)`，不再显示 `(no output)`；字符串 args 展示前剥离控制序列。
- `packages/pi-python-eval/src/presentation.ts`
  - copy primary/full 使用未 `trim` 的 `args.code`；summary、`request` 与 input section 仍用 trim 后文本。
  - `inputSection` 在 highlight 前剥离控制序列。
- 输出渲染保持现状：工具结果里的合法 ANSI 颜色继续显示；只有复制时剥离结果部分。

### 文档契约（先于实现写入）

- `DESIGN.md`：bash 请求正文条目补"copy 取请求原始字节（不 trim、不剥离），full 只剥离输出半段"；python_eval 条目把"copy primary 是 code"改为"code 原文（不 trim、不剥离）"。
- `docs/architecture/collapsible-tool-rendering.md` §4：新增复制契约——请求部分原始字节，仅输出部分剥离；只有摘要的记录不写入剪贴板并显示 `✗`，展开正文说明 `(request not recorded; summary only)`。

### 测试

- `payload-parser.test.ts`：请求字节原样保留（含引号、制表符、首尾空白）；全空白请求仍为 `undefined`。
- `collapsible-tool-frame.test.ts`
  - 顶层 bash：引号、glob、管道、Unicode、>120 列单行、末尾唯一标记 `ZZ_TAIL_07`、控制序列；折叠态只有首行摘要，展开含标记且无 ESC，每行不超过 80 列；copy 与请求字节相等，shift+copy 为请求 + `---` + 输出。
  - codemode live 嵌套 bash：命令长于 70 字符摘要，标记只在展开正文出现；copy 精确；结果里的 `\u001b[32m` 保留，请求里的 `\u001b[31m` 不进入展示。
  - 只有摘要的持久化调用：copy 不写剪贴板、显示 `✗`、展开正文出现 `(request not recorded; summary only)`。
  - 原"复制持久化摘要"用例改为断言"摘要不是请求"，保留后续展开断言。
- `eval-presentation.test.ts`：python_eval 顶层 copy primary 为 code 原文（含 `ZZ_TAIL_07`、首尾空白、控制序列），展示行剥离控制序列。

### 验证结果

- 改动文件 Biome：逐文件 `pnpm exec biome check <file>` 全部通过（markdown 不在 Biome 处理范围）。
- `pnpm exec vitest run packages/pi-ext-ui/test packages/pi-python-eval/test packages/pi-ext-tools/test`：27 个文件、441 个测试全部通过。
- `pnpm --filter @hheei/pi-ext-ui run build`、`pnpm --filter @hheei/pi-python-eval run build`、`pnpm --filter @hheei/pi-ext-tools run build`：通过。
- 未执行：全仓 `typecheck`（无跨包类型/公共契约变化）、`pnpm test`、`test:integration`（未改 kernel/host 生命周期路径）、`pnpm run check`。
- `graphify update .` 在代码完成后运行。

## 剩余边界

- D1（header 是否保留命令摘要）仍由 owner 决定；本轮未改 06 的 header。
- D2/D3/D4 已按批准落地：python_eval 嵌套由 ext-ui 用该包提供的 `children` 事实画交互看板（不重画组），上限提示指向 copy，resume 只读公开 `sessionManager.getBranch()`。
- 仍未做：04/05 tail/footer、12 背景块、09 以外的未知工具策略。
- 未提交、未 push、未发布。

### 主助手直接复核补正与独立验证

- 发现 provider 的 raw code copy 到达 renderOwnedPresentation 后仍被整段 stripTerminalSequences，因此 provider 单测通过不足以证明 UI copy 精确。已删除该二次清洗；provider 拥有请求/结果边界，UI 原样消费它给出的 copy payload。
- NestedCallsView 同样原样消费 provider copy；仅没有 provider copy 时使用通用请求/结果回退清洗。
- owned-presentation.test.ts 增加顶层与嵌套两条真实 UI copy 路径，含首尾空白、Unicode、CSI 和请求末尾标记；分别点击 primary/full 并核对剪贴板字节。
- 独立验证：pnpm exec vitest run packages/pi-ext-ui/test packages/pi-python-eval/test packages/pi-ext-tools/test，27 files / 443 tests passed。
- 独立验证：pnpm --filter @hheei/pi-ext-ui run build、pnpm --filter @hheei/pi-python-eval run build，均通过。
- 独立验证：pnpm exec vitest run -c vitest.integration.config.ts packages/pi-ext-ui/test-integration/host-transcript-patch.test.ts，3/3 通过。
- 改动文件 Biome、git diff --check 通过；graphify update . 已更新 AST。未跑全仓检查，未做 herdr；本票其余阻塞不变。


## 本轮契约（07 续：resume 与 python_eval 嵌套，实现前定稿）

### 请求来源优先级（不新增请求持久化）

1. **live**：`tool_execution_start` 捕获的 `args`（ext-ui tracker，父调用 id 作用域）。
2. **resume/fork/reload**：公开只读 `sessionManager.getBranch()` 当前分支上该父调用 toolResult 的 `nestedCalls`（host 已保存，`id/arguments/argumentsBytes/complete`）。按子调用 id（`<parent>/<n>`）索引；不读 host 私有字段，不新增 hook。
3. 两者都没有：行内明确"未记录请求"，copy 不写入（✗），不用摘要或有界预览冒充。

### 分支与生命周期

- 索引按 session 作用域持有；`session_shutdown` 清理。叶子变化时沿 `parentId` 链只扫描新增 entry；新叶子不在旧链上（fork/切分支/reload）则重建。渲染不触发整条分支扫描。
- 索引有界（最多 512 条子调用），超限按插入顺序淘汰；淘汰只降级为"未记录"。
- `getBranch()` 抛错时视为无来源（降级提示），不缓存错误。

### 截断与完整性

- 单调用 `arguments` 缺失但有 `argumentsBytes`，或记录整体 `complete === false` 导致丢调用：正文明确"请求被会话记录截断/未保存"，copy 拒绝写入，不复制伪完整命令。
- host 上限（8KB/调用、32KB/总计、256 调用）是恢复能力的真实上限，不在 UI 假装更高。
- 结果文本从不进入 `nestedCalls`：resume 只有请求，没有结果，行内不得暗示有完整输出。

### python_eval 嵌套

- provider 保留事实所有权（哪些调用、summary、状态、时长、id）；不再提供静态 `collapsedRows`，由 ext-ui 用同一份 `children` 画交互看板（展开/copy），容器 frame 仍是唯一渲染者，组层不重画、不重建组。
- 子行请求同样按上面优先级解析：live tracker → 分支 `nestedCalls` → 未记录提示。
- 失败/取消行保留错误文本；copy 只在请求存在时写入。

### 展示上限提示

- 正文被截断时提示实际入口：有 copy 时写 `shift+click copies all`；单行被折行截断时说明"该行剩余部分隐藏"，不再用逻辑行数冒充隐藏行数。copy 内容本身仍完整（请求原文 + 已剥离输出）。

### 明确不可达

- host 不保存嵌套调用结果，resume 无法恢复子调用输出（只有状态/错误）。
- 超过 host 上限的调用/参数不可恢复；live tracker 的字符串上限 32KB 也不提升恢复能力。


## 本轮实现（07 续，未提交）

### 代码

- `packages/pi-ext-ui/src/tracker.ts`
  - 新增 session 分支索引：`setNestedCallSource(manager)` / `nestedCallArgs(id)`。只读 `sessionManager.getBranch()`；叶子变化时沿 `parentId` 链只扫描新增 entry，fork/切分支/reload 重建；索引上限 512 条，读取失败不缓存；`session_shutdown` 清理。
  - `NestedCallArgsFact` 区分 `args` 与 `truncated`（`argumentsBytes` 有值、`arguments` 缺失）。
- `packages/pi-ext-ui/src/renderer.ts`
  - `withSessionArgs` 在组装子行时补全请求：live 捕获优先，其次分支记录，仍无则保持“未记录”。
  - `renderOwnedPresentation` 优先用 provider 的 `children` 事实画交互看板（python_eval 不再提供静态 `collapsedRows`）。
- `packages/pi-ext-ui/src/nested-calls-view.ts`
  - 记录带 `args` 时正文按请求原文显示（不再只给 JSON 包裹）；`argsTruncated` 显示 `(request truncated by the session record: N bytes)`。
  - 截断请求 copy 直接拒绝（✗），不复制预览或摘要。
- `packages/pi-ext-ui/src/tool-view.ts`
  - 截断提示指向真实入口：有 copy 时追加 `, shift+click copies all`；单行折行被截断时写 `current line continues`，不再把被截断的那一行算作整行省略。
- `packages/pi-ext-ui/src/extension.ts`：lifecycle start 设置分支来源，cleanup 清除。
- `packages/pi-ext-ui/src/index.ts`：导出 `setNestedCallSource`、`nestedCallArgs`、`recordNestedCallResolved`、`getResolvedNestedCalls`。
- `packages/pi-python-eval/src/presentation.ts`：不再输出 `collapsedRows`；`children`（含 id/summary/状态/时长）仍是该包的事实，交互由 ext-ui 同一份 children 绘制。

### 测试

- 新增 `packages/pi-ext-ui/test/nested-call-recovery.test.ts`：
  - resume 请求逐字节显示与复制（含尾标记、控制序列）；
  - `argumentsBytes` 截断提示且拒绝复制；
  - 切分支后不再读到上一分支的调用；
  - live 捕获优先于分支记录；
  - owner board（python_eval 形态的 `children`）绘制、展开、复制。
- `collapsible-tool-frame.test.ts`：新增“截断正文指向真实 copy 入口、单行被截断说明继续”的用例；`__piExtUiResolvedCalls` 进入持久化 fixture；行断言忽略背景填充宽度。

### 验证结果

- `pnpm exec vitest run packages/pi-ext-ui/test packages/pi-python-eval/test packages/pi-ext-tools/test`：30 文件 / 476 测试通过。
- `pnpm --filter @hheei/pi-ext-ui run build`、`pnpm --filter @hheei/pi-python-eval run build`：通过。
- 改动文件逐文件 `pnpm exec biome check`：通过。
- `pnpm run typecheck`：通过（补齐 `nested-call-recovery.test.ts` 的 `TuiMouseEvent.alt` 后全仓 0 错误）；未执行：`pnpm test`、`test:integration`（真实 host 路径变化，由 parent 验收）、`pnpm run check`。

### 明确限制

- host 不保存嵌套结果：resume 只能恢复请求与状态，不能恢复子调用输出。
- host 上限（8KB/调用、32KB/总计、256 调用）就是恢复上限；超出即“未记录/截断”，不伪造。
- python_eval 的嵌套请求同样依赖 host 记录：没有 `nestedCalls` 的旧会话只显示摘要提示。