# 文件工具渲染解耦与独立／嵌套呈现计划

## 1. 审查结论与目标

状态：设计修订；第 8 节步骤 2（edit 独立 DiffView 与嵌套摘要）、write、eval 渲染转移与步骤 3 的 apply_patch 均已实施（packages/pi-ext-ui，含 V4A 流式 preview 重实现与旧渲染删除）；read 已回归 Pi 原生 renderer。步骤 4–5（批量删除 bash/codemode/edit/write 旧 pretty renderer 与文档收尾）尚未实施。用户已确认单列 diff、一个空格分隔、独立 apply_patch 成功时不显示顶层 ✓、部分成功必须可见，以及工具在独立和 meta-tool 内有不同呈现方式。

原计划方向可取，但尚不足以直接实施：ToolPresentation 重复 ToolViewSpec；嵌套结果的数据来源缺失；把 apply_patch 当作原子批次、把每个文件简化成成功／失败，以及承诺从局部 diff 复制完整文件，都不符合现有执行契约。本修订以真实数据和 Pi 原生接口为约束。

目标是让 pi-ext-ui 只维护少量高价值专用 renderer，并同时提供可组合的 ToolView／DiffView 视觉 API。没有专用 UI 的工具继续使用 Pi host 的原生 renderer；具体 extension 可以显式使用 pi-ext-ui 的视觉 API，但 pi-ext-ui 不按工具名接管全部工具、不读取文件、不执行工具，也不 import 具体 extension。高自由度来自原生 Component 的组合能力；不新增全工具 facts 适配层、多列布局系统或通用注册中心。

## 2. 现有实现证据

- `packages/pi-ext-ui/src/tool-view.ts`：已有 ToolViewSpec、RailSection、三层折叠、复制区和原生 Component 内容插槽。
- `packages/pi-ext-ui/src/renderer.ts`：已有 Pi renderer resolver，但 NestedCallRecord 未保留 child id，也没有原始 args／result。
- Pi 1.0.2 `dist/extensions/codemode/execute.js`：子调用记录包含 id、name、截断后的 args 字符串、status、durationMs 和 error；不保存子工具 result.details。运行中临时 id 为 `<parent>/?`，完成后才写入真实 id。
- Pi 官方 `docs/extensions.md`：ctx.executeTool 发出带 parentToolCallId 的原生事件；嵌套结果不独立写入 transcript；持久化 nestedCalls 是有容量限制的调用记录，明确不保存结果。
- `packages/pi-ext-tools/src/apply-patch/outcome.ts`：结果区分 pending、applied、partial、fuzzy、rejected、unconfirmed、not_applied；包含 operationIndex、hunk outcomes 和 snapshots。
- `packages/pi-ext-tools/src/apply-patch-tool.ts`：已有 success／partial／failed 聚合规则；confirmed changes 不回滚。
- 原生 edit 返回局部 diff／patch／firstChangedLine；原生 write 没有旧文件基线 details。两者均不能保证渲染器得到完整修改前后文件。

## 3. Ownership 与数据流

```text
pi-ext-tools 或 Pi 原生工具
  参数校验、读写、锁、远程执行、取消、真实 outcome
                 ↓ Pi renderCall/renderResult
pi-ext-ui
  少量专用 renderer + ToolView/DiffView 视觉 API
                 ↓
Pi host
  transcript、渲染生命周期、原生 expanded 与刷新

没有专用 renderer 的工具 ───────────────→ Pi native renderer
```

- 执行方拥有事实：哪些路径／hunks 已确认改变，哪些拒绝、未执行或结果未确认。UI 不根据请求 patch 推断执行成功。
- pi-ext-ui 拥有主题、排版、折叠呈现和复制文本选择；渲染不读取文件、发起 SSH 或重跑工具。
- 工具 details 保持 JSON-safe，不存 ANSI、Component、Theme 或闭包。Component 只存在于前端渲染过程。
- 本次采用 UI 解耦路径：pi-ext-tools 保留必要执行注册、远程能力和 eval 调用注入。彻底删除 read/edit/write 注册、回归纯原生执行会改变能力，作为单独范围决策处理。
- pi-ext-ui 不加载时，执行及模型收到的 content 仍完整可用；保留简洁的原生／文本 renderer 回退。

## 4. 抽象：复用现有容器，增加必要的呈现能力

### 4.1 两种呈现共用解释逻辑，不强制同时构造

独立视图直接生成已有 ToolViewSpec；嵌套视图只计算紧凑摘要和状态，不创建 diff body、复制内容或整棵 Component 树。工具特有 details 的解释集中在相应适配中，两种消费者复用它。

不新增复制 header／sections／copy 的完整 ToolPresentation DTO，也不把所有工具塞入 mutation.ts。read 是读取；codemode 是协调；文件变更的共同排版由 DiffView 承担。

嵌套摘要的最小内部结果可表示为：

```ts
type InlinePresentation = Readonly<{
  summary: string;
  status: ToolStatusKind;
}>;
```

复用现有 ToolStatusKind。name、id、duration 由调用记录提供；摘要不重复携带。先保持 package 内部契约，确有跨 package 消费者后再确定公共导出。

### 4.2 一个专注的 DiffView

DiffView 使用 Pi 原生 Component 的 render(width)／invalidate()，隐藏 patch 解释、行号、单列布局、语义着色和 ANSI／单元格宽度处理。它不负责 ToolView header、fold state、执行 outcome 或剪贴板副作用。

优先消费已有 patch 或已确认的 hunk snapshots；确有 before／after 时复用现有 diff 依赖。不手写 Myers 算法，不重新设计通用多列引擎，不承诺固定代码行数。

输入按真实来源选择互斥的判别联合，避免 patch／before／after 全 optional 的无效组合。原生 edit 的展示 diff 与标准 unified patch 是不同格式，分别适配，不能盲目传给同一个 parser。解析失败保留原始文本和诊断，不能静默变成空 diff。

无需强迫调用方构造格式化行、ANSI 或通用 FileMutation。内部对齐模型和辅助函数保持私有；统计从同一次解释中获得，避免单独 summarizeDiff 重复解析。

### 4.3 深模块判定

删除 ToolView 后，折叠、交互和布局复杂度会回流到多个 renderer；删除 DiffView 后，代码／diff 排版会回流到 edit、write 和 apply_patch。两者有实际 leverage。

删除一个仅转发 ToolViewSpec 的 ToolPresentation 包装层，复杂度不会回流，因此该层应省掉。文件少、函数少或“纯函数”本身不能证明模块深度。

## 5. 显示与复制契约

只实现 unified 单列。ToolView 提供唯一外侧 rail；DiffView 不再绘制 rail。符号及行号与源代码之间只有一个分隔空格；源代码本身的缩进保留。

```text
▾ ✓ edit src/index.ts · +2 -1                          󰆏 
▎  12 const a = 1;
▎ -13 const oldVal = "foo";
▎ +13 const newVal = "bar";
▎ +14 const extra = true;
```

无行号右侧 │、无双列、无额外空白 padding 行。行号右对齐；续行不重复原行号和变更符号。主题使用既有语义 token。rail／行号／符号仍会进入鼠标网格选区，不能宣称选区无污染；复制按钮提供纯文本。

- Level 0：普通工具单行；apply_patch 可显示操作概览；codemode 显示直接子调用概览，不自动递归展开子文件。
- Level 1：有明确行数预算及省略提示；多文件批次控制总展示预算，不能仅逐文件限高导致整体无限增长。告警摘要必须可见。
- Level 2：解除 UI 行数限制；源结果截断、缺失或只含局部上下文时如实提示。展开不能恢复不存在的数据。
- 点击、Ctrl+点击、Ctrl+O、wheel 透传及复制按钮右侧安全间距沿用既有 ToolView 契约。
- read 使用 Pi 原生 renderer 负责正文与复制；write 复制已有完整输入内容；edit／apply_patch 优先复制实际可用的 diff 或 patch。局部 diff 不能还原完整文件；V4A 请求不能冒充可供 git apply 的 unified patch。
- partial／unconfirmed 时明确区分请求补丁与已确认改动。不能把请求全文标为已应用结果；具体复制字段在适配真实数据时确定。

## 6. apply_patch 的真实状态

apply_patch 保持一个真实工具调用；UI 可用 edit／create／delete／move 等标签描述操作，不伪造独立 ToolCall，也不把它改造成多个工具执行。它不是全有或全无的原子事务。

| 事实 | 独立顶层 | 嵌套摘要 |
| --- | --- | --- |
| success | 无顶层 ✓ | ✓ + 紧凑摘要 |
| partial | ! + 部分应用摘要 | ! + 同一语义摘要 |
| failed | ✗ + 失败摘要 | ✗ + 失败摘要 |

聚合 status 沿用执行方事实；生命周期中的 streaming／running 与最终 outcome 分开。成功 glyph 的隐藏是独立呈现规则，不改变成功事实。

子项按 operationIndex 表示，不能仅以 path 合并：同一路径多次操作、move 和单文件多个 hunks 都有独立语义。

- applied：✓。
- partial：!，保留 appliedHunks／totalHunks 与原因。
- fuzzy：保留 fuzzy 标记，不能抹为普通 exact 成功。
- rejected：✗ + 拒绝原因。
- unconfirmed：! + unconfirmed；不能声称未改变或安全重试。
- not_applied：明确 not applied；不能与已尝试但 rejected 混为一谈。
- pending：规划／运行态标记；不能预先显示 ✓。

成功文件不会回滚；取消后已确认改动保留。恢复说明和“不重试已应用 hunks”必须在展开态可读。统计只计入已确认变更，计划统计需明确标注为预览。

## 7. codemode 集成的限制与分阶段策略

原生 calls 没有 child details。renderer resolver 本身也没有“嵌套投影”入口。因此，仅增加 inlineSummary 字段不能让 codemode 自动获得它。

本次先通过原生 tool_execution 事件在 session 内记录有界的子调用 facts，按真实 toolCallId／parentToolCallId 关联；用于现场摘要的最小事实，而非永久保存所有原始大结果。不要按工具名、调用顺序或截断 args 关联并发调用。实现前核实事件阶段与 codemode 临时 id 的衔接、事件结果是否包含所需的最终 details，并测试多次同名并行调用。

这只是 pi-ext-ui 内部呈现缓存，事件仍是通知；不使用事件总线实现 RPC 或共享状态契约。无 UI 模式无需建立缓存。session 切换、reload、shutdown 清理，取消保留已观察事实，迟到事件不能污染新会话。

恢复历史／fork／缓存被淘汰时，只有 calls／nestedCalls 的已保存信息，使用原生参数预览与 error 摘要降级；无法知道 partial 时不能凭 transport error 猜测 partial，也不能许诺历史嵌套 diff 可恢复。codemode 脚本未输出子结果时，展开下室也不保证存在子工具 diff。

若要求现场和恢复后都具备完整的 nested partial／diff，则必须另行设计由调用方／Pi host 持久化最小 JSON-safe 子结果事实的契约。那属于持久化和公共边界扩展，本计划不偷偷增加 CustomEntry、执行包装器或宿主补丁。

## 8. 实施顺序与验收

1. **先验证数据通路**：用真实 read/edit/write/apply_patch 和原生 codemode 核对 args、details、事件 id、错误和取消行为。以有界缓存及历史降级为当前路径；记录实际数据缺口。
2. **建立纵向路径**：先完成 edit 的独立单列 DiffView 与嵌套摘要，覆盖宽度变化和失败回退，再接 read/write。write 无基线时展示内容，UI 不补读文件。
3. **接 apply_patch**：直接适配现有 operations/outcomes/snapshots，验证单文件 partial、多文件 partial、unconfirmed、move、取消和恢复提示。它是本次真实消费者，不是只预留空接口。
4. **删除旧渲染**：新路径和无 UI 回退验证后，移除旧 pretty renderer 的调用及无消费者代码。先查 apply_patch 等所有引用；保留执行锁、验证、远程能力、eval 注入和依赖 ownership。将默认匹配集合改为语义准确的名字，不继续把文件工具加进 WEB_ACCESS_PILOT_TOOLS。
5. **对齐文档与聚焦验证**：实施时同步 DESIGN.md 及折叠设计文档，替换过时的相关渲染测试，保留执行行为测试。

主要验收：独立／嵌套状态一致但显示规则不同；未知工具保留 next() 回退；ANSI、中文和宽字符在窄宽布局均不越界；图片读取及截断提示保留；复制内容真实；并发同名调用不串数据；历史信息不足时可解释地降级。

验证范围：改动文件 Biome、受影响 Vitest、相关 package build；涉及跨 package 类型、依赖或公共导出时升级到 pnpm run typecheck。涉及实际 CLI／锁／重启路径时运行相关 integration tests。只有影响难以界定或发布边界变更才执行完整 check，不默认全仓测试。

本次仅修订 Markdown，不运行 TypeScript build/test，不改变执行、公共导出或持久化实现。
