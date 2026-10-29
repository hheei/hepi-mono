# 09：未知工具不参与有效调用统计

**状态：** 实现完成（未提交）；待 parent 跑全仓 typecheck 与真实 host integration 验收。
**依赖：** 03；如改变 childCount 公共契约需先批准。
**依据：** [补充排查第 4 节](../pi-ext-ui-delegation-usage-status-audit.md)。

## 事实阻塞（ticket 10 期间核对）

- 顶层未解析工具：host 不为其提供 tool renderer，`toolMember` 已返回 undefined，因此断组且不进入 header calls 与分类统计。该子项已自然满足。
- 容器内嵌套子调用：现有全部事实（`ToolPresentationChild`、`ToolViewChild`、codemode `details.calls`、host `nestedCalls` 记录）只有 name/summary/status/duration/error，没有“当时是否解析到真实工具”的字段；host 把未知工具与真实失败都记为 error 结果。
- 结论：`有子调用但全为未知 → 有效数 0` 需要提供者或持久化新增解析事实（公共数据契约变更），在获得批准前不实现；不用错误文案匹配、不用当前工具清单过滤、不按 isError 一刀切。

## 验收条件

- [x] grep ×4、未知 codemodE ×1、edit ×31：统计仅 grep ×4 · edit ×31，有效 calls 为 35；未知调用的完整报错仍可检查。（用等价构造用例验证；未找到原始会话，不声称已复现）
- [x] 已注册且实际解析成功的大小写工具名正常计数，不按名称猜测，不做 lowercase/fuzzy 自动修正。（python_eval 精确同名；`Read` 不进入执行）
- [x] 真实工具执行失败照常计数，不按 isError 全部剔除；明确参数验证/取消/权限拒绝的既有边界。（已解析 + isError 计 failed；未解析的失败归未知）
- [x] 顶层和 codemode/python_eval 嵌套一致；有效 childCount 与分类一致，有界预览不改变总数。（`childCount` = 有效数，python_eval 的 `calls` 计数是事实而非预览）
- [x] 有子调用但全部未知的容器为 0 次有效子调用，不错误回退父计 1；真正没有子调用沿用既定父计数。（`childCount: 0` 被 `ToolGroupView` 的 `??` 表达式保留）
- [x] live 与恢复历史使用调用当时的解析事实；当前工具清单变动不抹去旧有效调用。若历史缺乏该事实，记录限制与方案，不伪造已判定结果。（事实随 details 持久化；旧记录显示 `N unknown`）
- [x] 源码使用工具解析/执行边界事实，不匹配错误文案，不新增 UI 白名单；公共数据/持久化扩展先说明并批准。（`tool_call` hook + provider 的 `context.tools`；无错误文案匹配）
- [ ] 聚焦回归测试覆盖上述全部路径；有明确现场例子时核对原始 toolCallId，不能把静态猜测称为已复现。（测试覆盖已完成；原始会话未提供，保持未勾）

## 验证

改动文件 Biome、受影响捕获/展示/计数测试、相应 package build；公共契约变化加 typecheck，真实执行驱动变化补 integration；代码修改更新 Graphify。不要求默认全仓 check。

## 本轮契约（09 实现前定稿，用户已批准事实扩展）

### 解析事实的真实边界（上游证据）

- `nested-tool-calls.js` 的 `execute()` 在 `host.runToolCall()` **之前** 发 `tool_execution_start` 并 `recorder.start()`；因此 start 事件与 host `nestedCalls` 记录都**不是**解析成功事实（未知工具同样被记录为 error）。
- `prepareToolCall` 顺序是：`tools.find(name)` → 参数准备/校验 → `beforeToolCall`（即扩展 `tool_call` 事件）。所以 **`tool_call` handler 被调用 = 该调用已解析到真实工具且参数通过校验**。
- 反向不成立：`tool_call` 未触发可能是未知工具、参数校验失败、被阻止或取消。**缺失只表示未知，绝不写成 false**。

### 记录与传递

- ext-ui 在 `tool_call`（带 `parentToolCallId`）记录正向事实：子调用 id → 已解析。
- 父调用 `tool_result` 时把该父调用下观察到的 id 列表写入结果 details 的 `__piExtUiResolvedCalls`（最多 256，仅字符串 id），随调用事实持久化；不改 content/isError，不新增存储通道。
- `extractNestedCalls` 读回该字段：命中 → `resolved: true`；字段缺失（旧记录）或 id 未命中 → 未知（`undefined`）。
- python_eval 由 provider 在自己的执行边界记录：调用前用 `context.tools`（`executeTool` 的解析列表）精确同名匹配，命中写 `resolved: true`，写入自身 details 的 trace/call 事实。不命中不写 false。

### 计数

- 有效 calls 只计 `resolved === true`；未知不计，但在 header 单独显示 `N unknown`，未知行仍完整显示（含错误文本）。
- 真实执行失败（`resolved === true` 且 isError）照常计数。
- `childCount` 传有效数（允许 0）。`ToolGroupView` 的 `member.childCount ?? (children ? children.length : 1)` 已能表达 0，**不需要跨文件改动**；无子调用事实时仍按父计 1。
- 恢复历史只用记录当时的字段；不用当前工具清单、错误文案、大小写或模糊匹配推断。

### 明确不可达（外部 codemode）

- host 的 codemode 不暴露解析 seam，ext-ui 不能在其内部加事实。未知工具名、参数校验失败、权限阻止、取消在外部 codemode 中**不可区分**，统一为未知。
- codemode 的 `models.*` 行不是工具调用，也不会触发 `tool_call`，因此同样是未知、不计入有效 calls（行仍可见）。
- 旧会话没有该字段：全部未知、有效 0，明确显示 `N unknown`，不伪造。

## 本轮实现（09，未提交）

### 代码

- `packages/pi-ext-ui/src/tracker.ts`：`recordNestedCallResolved` 只记录 host `tool_call` 真正触发过的子调用 id（该 hook 在工具解析且参数校验通过之后才发）；`getResolvedNestedCalls(parentId)` 供渲染与持久化读取。缺失一律未知。
- `packages/pi-ext-ui/src/renderer.ts`
  - `withResolvedCallFacts`：父调用 `tool_result` 时把该父调用下观察到的 id 写入 details 的 `__piExtUiResolvedCalls`（≤256，纯 id 数组），随调用事实持久化；不新增存储通道，不改 content/isError。
  - `callResolved`：`resolved === true`（或 live 事实命中）才算有效调用；未知不计。
  - header 事实：`callStatsParts(有效数, 有效失败数)`，未知追加 `N unknown`；`childCount` 传有效数（允许 0）。
- `packages/pi-ext-ui/src/payload-parser.ts`：`extractNestedCalls` 读回 `id` 与 `__piExtUiResolvedCalls`，命中才写 `resolved: true`；字段缺失保持 `undefined`。
- `packages/pi-python-eval/src/bridge.ts`：调用前用 `context.tools`（`executeTool` 的解析列表）精确同名匹配，命中写入 trace 的 `resolved: true`；未命中不写 false。
- `packages/pi-python-eval/src/transcript.ts` / `presentation.ts`：`calls` 事实新增 `resolved`（有效数），`failed` 只统计已解析调用；trace/call 持久化 `resolved`；summary 追加 `N unknown`；`childCount` = 有效数。

### 测试

- ext-ui `nested-call-recovery.test.ts`：`tool_call` → `tool_result` 写入事实；嵌套 result 与顶层 call 不写；只有已解析的计入 header；未知行保留错误文本；已解析失败计失败；旧记录 `0 calls · 1 unknown`；`view.childCount` 分别为 1 与 0。
- ext-ui `collapsible-tool-frame.test.ts` / `diff-view.test.ts`：持久化 fixture 带上解析事实，计数断言按“只计已解析”更新。
- python_eval：bridge 精确名/大小写/未注册三态；details 持久化 `resolved`；presentation 有效/未知计数与旧记录降级。

### 验证结果

- `pnpm exec vitest run packages/pi-ext-ui/test packages/pi-python-eval/test packages/pi-ext-tools/test`：30 文件 / 476 测试通过。
- 两个受影响 package build 通过；改动文件 Biome 通过。
- `pnpm run typecheck`：通过（全仓 0 错误）；未执行：`pnpm test`、`test:integration`、`pnpm run check`。

### 跨文件结论

- `ToolGroupView` 的 `member.childCount ?? (children ? children.length : 1)` 已能表达 0，**无需改动 agent5 文件**；ext-ui 现在会为有子调用事实的容器传 `childCount`（含 0）。

### 明确不可达（如实记录，未伪造）

- 外部 codemode 没有解析 seam：未知工具名、参数校验失败、权限阻止、取消都无法区分，统一为未知、不计入有效 calls，行与错误仍可见。
- codemode 的 `models.*` 行不会触发 `tool_call`，因此同样是未知、不计入有效 calls。
- 旧会话没有 `__piExtUiResolvedCalls`：有效 0、显示 `N unknown`，不按当前工具清单或错误文案回填。