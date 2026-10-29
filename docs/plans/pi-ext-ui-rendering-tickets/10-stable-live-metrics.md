# 10：稳定 CH、block 时间与已完成工具计数

**状态：** 已实现（除 09 阻塞项）。**依赖：** 01–03 已交付；不依赖 00 的尾部布局决策。

## 用户明确要求

thinking 期间 CH 不应退回 —；新 block 的时间从该 block 的起点计算，不应借用整回合起点；有效工具统计在调用完成后入账，不在输出 tool schema/args 或执行中预估父/子调用数量。

## 静态发生点

- ToolGroupView.#usage 将最后一个存在 usage 的 assistant 直接设为 latest。流式 thinking 的初始 usage 若全为 0，会覆盖前一已知值；cacheHitRate 遇 prompt<=0 返回 —。缺 usage 会跳过，但零占位会覆盖，必须区分。
- — 表示历史 block 没有可观测起点。每个 block 在首个 live member 首次出现时创建自己的时钟；原生断组冻结旧 block，后续 block 独立计时；agent_end 冻结仍活跃的 block。恢复历史保留未知，不能套用后续实时 block 的时钟。
- #calls 不看完成状态，每个 tool member 都按 childCount/children.length/1 累加。输出 args 时先计父 1，出现子调用后替换为 N；运行中子项继续增长，造成跳动。
- toolMember 在 argsComplete=true 且没有 result 时，当前也可能推断成 ok；故不能直接以 status===ok 判断最终完成。

## 验收条件

- [x] 已知 CH → 新 thinking 零 usage/缺 usage → 请求最终 usage：中间保持已知 CH，完成后更新为最新有效 prompt 的命中率。
- [x] 无任何已知 usage 时 CH=—；有效新 prompt 的 cacheRead=0 显示 0%，不能粘住旧命中率；缺数据和真实 0 必须分开。
- [x] 每个 block 从首个 live member 首次可观测时独立计时；原生断组或 agent_end 冻结该 block；重绘与重建保留其时钟。无可恢复起点的历史仍显示 —。
- [x] 测试精确覆盖 0s、1m 05s、1h 02m 03s，证明格式化与 block 生命周期分别正确；重绘/resize 不重置时间。
- [x] 输出工具名称/args/schema、执行开始、partial result 均不增加有效 calls 或分类次数；真实完成（成功或真实工具失败）仅入账一次。
- [x] codemode/python_eval 完成前不以父 1 或逐步 children 预估统计；完成后使用最终有效子数一次入账，父不重复计。无子调用完成后计父 1。
- [ ] **阻塞** 有子调用但均未知的容器最终有效数 0：见下方“09 阻塞事实”，当前 UI 边界没有解析事实，未实现。
- [x] 连续帧 fixture：容器 args streaming→执行→partial 1 child→partial 3 children→final 3 children，统计只在 final 增加 3；后续重绘/恢复不重复增加。
- [x] 分类显示、header calls 使用同一完成条件；不改变正在运行工具的原样显示与错误检查能力，不把未完成工具从 transcript 隐藏。

## 实施边界

先记录查明的真实完成信号和 run ownership，再改代码。不要借本票实现 04 的尾部/footer布局或 delegate；不新增 host hook、公共事件总线、定时防抖或无依据的 fallback。未知工具解析事实若尚不可得，记录 09 阻塞，不能宣称已解决。

## 验证

改动文件 Biome、受影响 UI 单测、UI build、真实 host transcript integration；公共契约改变才升级 typecheck。更新 Graphify AST。记录实际命令、结果与 herdr 未验证项。

## 实现记录

### 查明的 host 事实（Pi 1.3.0 dist）

- `ToolExecutionComponent`：`isPartial` 初始 true，只有 `updateResult(result, false)`（最终 result、`tool_execution_end`、以及 aborted/error 注入的最终错误）会置为 false；`argsComplete` 由 `message_end` 的 `setArgsComplete()` 设置，恢复历史时从不设置；`result` 在首个 partial 就存在。因此完成事实是 `isPartial === false && result !== undefined`，不能用 `argsComplete` 或 `status === "ok"` 反推。
- 历史恢复（`renderSessionItems`）：有 toolResult 的调用 `updateResult(message)` → 已完成；被中断、没有 result 的调用保持 `isPartial === true` → 不计。
- `agent_end` 会清空 pendingTools 并移除仍 streaming 的 assistant 组件，但已存在的工具组件与 group 身份不变。
- 顶层未解析工具没有 `ToolView` callRenderer，`toolMember` 已返回 undefined → 断组且不计数。

### 代码

- `packages/pi-ext-ui/src/host-transcript-patch.ts`：`toolMember` 增加 `completed` 事实；`RunBox` 记录组件首次可观测时间、稳定 block 时钟身份和活跃时钟；真实边界冻结当前 block，`endRun` 认领组件后冻结仍活跃的 block。
- `packages/pi-ext-ui/src/tool-group-view.ts`：`#calls` 与工具分类名称只统计 `completed` 成员；未完成工具仍留在列表并可展开，空计数时分类标签退化为 `tools`；`#usage` 拆出 `measured` 与 `latestPrompt`，CH 只跟随最后一条测到 prompt 的 usage，零占位/缺 usage 不清空已知值；`update` 接受 block-local clock；block 首次获得时钟后保持不变，恢复历史在实时内容加入时开始计时。
- 未新增 host hook、定时器、持久化或公共契约；`ToolGroupView` 未从 index 导出，签名变化属于包内实现。

### 测试

- `packages/pi-ext-ui/test/host-transcript-patch.test.ts` 新增：CH 保持与 0%/— 区分、相邻 block 独立起止与冻结、成员变化重建保留时长、恢复历史不被实时 block 改写、恢复 block 被实时内容加入、0s/1m 05s/1h 02m 03s 与重绘 resize、容器连续帧（args→执行→partial 1→partial 3→final 3 只在 final 计 3，重绘不重复）、运行中工具保留行但不计数；并更新受完成条件影响的既有断言（partial 不再计数）。
- `packages/pi-ext-ui/test-integration/host-transcript-patch.test.ts`：真实 bundled CLI + PTY 的 regular/fullscreen/notice 三种运行核对 partial 不入账、完成后入账、settled 帧保留 block 时长。

### 验证结果

- `node_modules/.bin/biome check --write` 三个改动文件 → 0 问题。
- `pnpm exec vitest run packages/pi-ext-ui` → 9 files / 176 tests 通过。
- `pnpm --filter @hheei/pi-ext-ui run build` → 通过。
- `pnpm run test:integration -- packages/pi-ext-ui` → 5 files / 12 tests 通过（含 pi-ext-ui 3 个真实 host 场景）。
- `pnpm run verify:changed` → 见最终报告（含 graphify AST 更新）。
- 未运行 herdr 逐帧观察；未运行全仓 `pnpm run check`。

### 09 阻塞事实

嵌套子调用事实（`ToolPresentationChild` / `ToolViewChild` / codemode `details.calls` / host `nestedCalls` 记录）只有 name、summary、status、duration、error，没有“该名称当时是否解析到真实工具”的字段；host 对未知工具与真实失败都记录为 error 结果，且错误文案匹配被 09 明确禁止。因此“有子调用但全为未知 → 有效数 0”无法在不新增提供者/持久化事实（公共契约变更）的情况下实现，未伪造。顶层未知工具已自然不计数。
