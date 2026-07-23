# Pi Basics BTW 可复用代码清单

状态：实施前审阅

关联文件：

- [`pi-basics-btw-plan.md`](./pi-basics-btw-plan.md)
- [`pi-basics-btw-research.md`](./pi-basics-btw-research.md)

本文件回答一个具体问题：哪些代码可以直接沿用，哪些只能 copy 后修改，哪些只应作为设计参考。结论以当前 Pi `0.80.10`、`pi-basics` 的 strict TypeScript、`exactOptionalPropertyTypes`、`DESIGN.md` 和 BTW 首版边界为准。

## 1. 总结结论

### 优先直接复用本仓库代码

以下代码已经属于 `pi-basics`，无需复制：

- `HePiLifecycleController` 和 `HePiRegistry`：session runtime 创建、逆序 cleanup、重复 shutdown 保护。
- `createAskFeature()` 的 `ctx.ui.custom` 调用结构、AbortSignal 转发和 `finally` cleanup 模式。
- Ask component 的 `settle()`、`dispose()` 和 exactly-once `done()` 模式。
- `ui/text.ts` 的 ANSI/cell-width-safe 文本工具。
- `ui/keymap.ts` 的 `keyGlyph` 和 `formatKeymap()`。
- `ui/scrollbar.ts` 的纯 scrollbar renderer。
- Goal 的 session/tree/compact stale guard 思路。
- Auto Title 的 model/auth/revision/dispose 测试结构。
- 现有 integration harness 和 deferred async fixture。

### 可以从参考仓库 copy 后小改

- narumiruna `buildSideThreadMessages()`：保留消息顺序和成功 turn 规则，改成统一预算、revision guard 和当前 Pi message 类型。
- narumiruna `extractAssistantText()`：保留 text part 提取，删除“空响应也算成功”的 fallback。
- narumiruna `buildUserPrompt()` / `buildFollowUpPrompt()`：保留问题和上下文隔离格式，补充无工具和不提升权限的 system prompt。
- narumiruna `completeSideThreadTurn()` 的 abort/error/commit 骨架：拆分 executor 和 model，增加 stop reason、history generation、context revision 检查。
- rpiv overlay 的 viewport clamp 和 bottom-anchor 算法：移除其主题/边框/固定布局，接入 `pi-basics` text primitives。
- rpiv response normalization 的分支结构：改为首版只接受 `stopReason === "stop"`。
- Firstp1ck 的 promise-tail / controller cleanup：当前首版明确“不排队”，所以只提取 per-request cancellation/finally 结构，不复制 queue。
- Firstp1ck 的 transcript textification：只借鉴 tool call/tool result 转普通背景文本的规则，改为消费 `buildSessionContext()`。

### 只能借鉴并重写

- 所有参考仓库的 command handler 和入口注册。
- 所有完整 TUI overlay/transcript pager。
- `getBranch()` 手工过滤和 context 构造。
- `completeSimple` 动态兼容 loader。
- 参考仓库的 settings/model/thinking 配置。
- dbachelder 的独立 AgentSession、工具事件 transcript、save/inject/summarize。
- Firstp1ck 的 RPC/WebUI widget、transfer payload 和 summary。

### 明确不要复制

- `globalThis` / `Symbol.for` / process-global BTW state。
- 跨 session question hints。
- BTW custom entries、主 transcript 注入、磁盘持久化。
- `read`、`bash`、`edit`、`write`、MCP tool 权限。
- `Ctrl+C` 作为 BTW 关闭键；首版统一 `Esc`。
- 参考仓库中的固定宿主布局常量、独立边框和第二套颜色语言。
- 参考测试文件整体复制；只重写行为意图。

## 2. 本仓库：应直接 import 的代码

### 2.1 Session runtime 和 cleanup

| Symbol | Source | 复用方式 | 注意 |
| --- | --- | --- | --- |
| `HePiLifecycleController` | `packages/pi-basics/src/runtime/lifecycle.ts:15-65` | 直接由现有 composition root 使用 | BTW 不自己维护 session_start/shutdown 主循环 |
| `HePiRegistry.registerLifecycle` / `cleanup` | `packages/pi-basics/src/runtime/registry.ts:20-70` | `runtime.registry.registerLifecycle({ id: "btw", cleanup })` | cleanup 仍需 BTW 自身幂等 |
| `HePiRuntimeContext` | `packages/pi-basics/src/runtime/context.ts:4-33` | 作为 feature 的 runtime 输入 | 不把 `ctx` 和 runtime 写入模块级共享状态 |
| `sameSession` 语义 | `packages/pi-basics/src/modules/goal/feature.ts:89-95` | 在 BTW 内实现一个窄 guard | 不复制 Goal reducer/persistence |

实现应在 `pi-basics/src/index.ts` 的 lifecycle `onStart(runtime)` 中调用 `btw.start(runtime)`，然后捕获当前 session id 注册 cleanup，和 Goal/Ask 的现有模式一致。

### 2.2 Custom UI 和 exactly-once settle

| Symbol/pattern | Source | 复用方式 |
| --- | --- | --- |
| `requestAsk()` 的 custom UI try/finally | `packages/pi-basics/src/modules/ask/index.ts:75-135` | copy-adapt 到 `btw/feature.ts` |
| `AbortController` signal forwarding | `packages/pi-basics/src/modules/ask/index.ts:104-125` | 直接采用独立 BTW controller，不能复用主 agent signal |
| `settle()` guard | `packages/pi-basics/src/modules/ask/component.ts:171-206` | copy-adapt 到 `btw/component.ts` |
| `dispose()` 的未 settle/已 settle 分支 | `packages/pi-basics/src/modules/ask/component.ts:366-447` | 直接采用结构，替换 Ask state 为 BTW state |
| `ui.custom` overlay | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:115-125` | 必须显式传 `{ overlay: true }` |

关键约定：`Esc`、abort、tree/compact、session shutdown 和 dispose 都必须最终调用同一个 guarded `done()`，且最多一次。只调用 `component.dispose()` 不足以结束外层 `ctx.ui.custom()` Promise。

### 2.3 文本、键盘和滚动原语

| Symbol | Source | 复用方式 |
| --- | --- | --- |
| `visibleWidth` | `packages/pi-basics/src/ui/text.ts:7-10` | 直接 import |
| `truncateToWidth` | `packages/pi-basics/src/ui/text.ts:12-16` | 直接 import |
| `wrap` | `packages/pi-basics/src/ui/text.ts:18-22` | 直接 import |
| `padToWidth` | `packages/pi-basics/src/ui/text.ts:38-40` | 直接 import |
| `keyGlyph` | `packages/pi-basics/src/ui/keymap.ts:3-11` | 直接 import |
| `formatKeymap` | `packages/pi-basics/src/ui/keymap.ts:25-52` | 直接 import |
| `renderScrollbar` | `packages/pi-basics/src/ui/scrollbar.ts:3-23` | 直接 import，BTW 自己管理 viewport |

BTW component 不应复制上游的 `escapeTerminalControls`、`wrapTextWithAnsi`、`visibleWidth` 或手写 `string.length` 逻辑；应统一经过本地原语。对于 provider text，显示前要做控制字符治理，但不得修改实际发给 provider 的 payload。

### 2.4 Model/auth 和 stale result 模式

| Pattern | Source | 复用方式 |
| --- | --- | --- |
| `modelRegistry.find()` + `hasConfiguredAuth()` | `packages/pi-basics/src/modules/auto-title/index.ts:308-326` | 借鉴查找/失败提示；BTW 使用当前 `ctx.model`，不解析 model ref |
| revision + active operation + dispose | `packages/pi-basics/src/modules/auto-title/index.ts:353-508` | copy-adapt 到 `sessionId + runtimeRevision + contextRevision + historyGeneration + requestRevision` |
| tree/compact/switch/fork abort guard | `packages/pi-basics/src/modules/goal/feature.ts:453-480` | copy-adapt事件注册和 abort 顺序 |

BTW executor 的实际认证契约是：

```ts
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
```

`auth.ok === false` 必须 fail closed；成功结果中的 `apiKey`、`headers`、`env` 按 exact optional 规则组装，不能无条件写入 undefined 字段。

### 2.5 测试设施

| Fixture/pattern | Source | 复用方式 |
| --- | --- | --- |
| extension integration harness | `packages/pi-basics/test/integration/index.test.ts:22-230` | 扩展或提取 BTW 专用 fixture |
| deferred async prompt | `packages/pi-basics/test/modules/auto-title.test.ts:101-221` | copy-adapt provider deferred response |
| repeated trigger/dispose abort tests | `packages/pi-basics/test/modules/auto-title.test.ts:101-221` | 改成 BTW request/overlay/shutdown tests |
| lifecycle idempotence | `packages/pi-basics/test/integration/index.test.ts:180-230` | 增加 BTW shutdown/reload/tree/compact cases |

## 3. narumiruna：逐函数沿用清单

来源目录：`references/narumiruna-pi-extensions/extensions/pi-btw/src/`。

### A：可近乎原样作为逻辑起点

| Function | Source | 目标 | 必要改动 |
| --- | --- | --- | --- |
| `createSideThread` | `side-thread.ts:83-85` | `btw/model.ts` | 改成 readonly turns、加入 session/revision ownership；不保留模块级状态 |
| `extractAssistantText` | `side-thread.ts:186-191` | `btw/executor.ts` | 保留提取/trim，空值返回错误而不是 `No response received.` |
| `buildUserPrompt` | `side-thread.ts:194-209` | `btw/prompt.ts` | 补充 no-tools、不可执行主任务和不提升权限规则 |
| `buildFollowUpPrompt` | `side-thread.ts:211-216` | `btw/model.ts` | 保留 follow-up 消息格式，加入当前问题 bound |
| `formatError` | `side-thread.ts:291-293` | `btw/executor.ts` | 保留 `unknown` narrowing；不要使用 `any` |

这些函数属于窄的纯逻辑块，但仍需检查当前 Pi message 类型和 `exactOptionalPropertyTypes`。不能整体复制整个 `side-thread.ts`，因为原文件还包含 thinking settings、动态 loader、默认 fallback 和宽泛的泛型 API。

### B：可 copy 后改写

| Function | Source | 改写原因 |
| --- | --- | --- |
| `buildSideThreadMessages` | `side-thread.ts:87-108` | 加入统一 context budget、主 context 一次注入和历史 generation |
| `completeSideThreadTurn` | `side-thread.ts:125-155` | 拆分 executor/model；增加 `stopReason === "stop"`、context revision、late response guard |
| `buildStreamOptions` | `side-thread.ts:226-239` | 删除 thinking-level；按 auth 的 `apiKey/headers/env` presence 构造 exact optional object |
| `sanitizeSingleLine` | `btw.ts:378-386` | 作为问题/显示文本纯函数，按本地 printable/control-char 规则重写 |
| `buildConversationContext` | `btw.ts:408-461` | 只能改写为 `buildSessionContext().messages`，不能继续手工 `getBranch()` |
| `BtwAnsweringView` 的 signal/scroll/finish/dispose | `transcript-pager.ts:173-271` | 只抽 lifecycle 思路，改成 `ctx.ui.custom({ overlay: true })` + `Esc` |

### C/D：不应直接带入

- `loadCompleteSimple`/default loader：当前目标明确 peer `@earendil-works/pi-ai >=0.80.10` 并直接使用 `/compat`，暂不复制旧 fallback。
- `resolveBtwModel`、settings reader、thinking-level：首版不做 model override/settings/disk persistence。
- `runBtwThread`、composer、`BtwTranscriptPager`：交互模型是连续 composer，首版定义为一次 command 一个问题。
- `Ctrl+C` close、旧的 reserved app rows、旧的 border/color layout：与 Pi Basics DESIGN 不一致。
- 原测试整体：缺少目标所需的 tree/compact/clear/late response/overlay Promise 契约。

## 4. rpiv：只抽取的窄代码块

来源目录：`references/juicesharp-rpiv-mono/packages/rpiv-btw/`。

### 可采用的逻辑

- `assistantMessageText()`：`btw.ts:135-144`，作为 response text extraction 的起点。
- `executeBtw()` 的 abort/error/no-text 分支：`btw.ts:200-268`，改成严格 stop reason normalization。
- `btw-ui.ts` 的自然内容、底部锚定和 scroll clamp：约 `btw-ui.ts:129-156`、`:263-385`。
- `pi-compat.ts` 的错误分类测试意图：`pi-compat.ts:21-64`，首版若静态 import 则不复制 loader，只保留“真实初始化错误不可被 fallback 掩盖”的测试思想。

### 不采用

- `globalThis[Symbol.for("rpiv-btw")]`：`btw.ts:30-35`。
- 跨 session history hint：`btw.ts:155-167`。
- session file keyed snapshot：`btw.ts:90-135`；首版每次构建 context，不缓存 snapshot。
- `message_end`/compact/tree snapshot hooks：首版不维护主 context snapshot。
- 完整 `BtwOverlayController`：其 visual styling 需要按 Pi Basics 语义重写。

## 5. Firstp1ck：只抽取的窄代码块

来源目录：`references/Firstp1ck-npm-packages/pi-extension-btw/`。

### 可采用的逻辑

- `textFromContent()` 和 `transcriptLineForMessage()`：`index.ts:64-91`，仅作为 tool/image/background 普通文本序列化的起点。原代码使用显式 `any`，目标必须改成 `unknown` + type guard。
- `buildTranscript()` 的总体意图：`index.ts:102-106`，但目标必须消费 `ctx.sessionManager.buildSessionContext()`，不能复制其 `getEntries()/getLeafId()` 手工构造。
- per-run AbortController 和 `finally` listener cleanup：`side-thread.ts:25-78`，可适配到单请求互斥；原 promise tail queue 不纳入首版。

### 不采用

- `stream()` streaming state：首版不做 streaming。
- `/btw-transfer`、summary model、steering message、WebUI/RPC widget。
- `decodeTransferPayload`：没有 schema/长度校验，且超出首版边界。
- package dependency `@firstpick/pi-utils`：首版不新增 dependency。

## 6. dbachelder：只作反例和未来参考

来源：`references/dbachelder-pi-btw/extensions/btw.ts`。

### 可以借鉴的局部思想

- side session event 到 transcript state 的映射。
- abort、unsubscribe、dispose 的清理顺序。
- 主 context 与 side context 隔离的概念。

### 当前禁止复制

- `createAgentSession()` 和 in-memory sub-session。
- 默认 `read`、`bash`、`edit`、`write` tool set。
- `/btw:save`、inject、summarize、tangent、model/thinking overrides。
- hidden custom session entries 和 restore/replay state。

这些能力会改变 `/btw` 的只读 trust boundary，必须另开需求和设计。

## 7. 许可证和 attribution

四个参考仓库的 BTW 包均声明 MIT：

| 来源 | Copyright |
| --- | --- |
| `narumiruna/pi-extensions` | `Copyright (c) 2026 narumiruna` |
| `juicesharp/rpiv-mono` | `Copyright (c) 2026 juicesharp` |
| `dbachelder/pi-btw` | `Copyright (c) 2026 Dan Bachelder` |
| `Firstp1ck/npm-packages` | `Copyright (c) 2026 Firstpick` |

目标仓库也是 MIT，但这不会自动覆盖上游 attribution。实施时：

1. 如果复制 substantial portion，保留原始 MIT notice 和 copyright。
2. 建议新增 `packages/pi-basics/NOTICE` 或在现有 LICENSE/第三方声明中列出实际采用的来源。
3. 采用窄算法时，在目标文件顶部加简短来源注释，例如“Adapted from ... under MIT License”，并说明已修改。
4. 不要把整份上游文件原样覆盖到 `pi-basics`，这样既会带入不需要的行为，也会让 attribution 和后续维护边界不清楚。

在正式 copy 前应再确认每个 source file 是否含额外第三方代码或不同于仓库根 LICENSE 的声明。

## 8. 推荐的实际 copy 顺序

### Step 1：先不 copy 上游 UI

直接接入本地：

- `HePiRuntimeContext`
- `HePiLifecycleController`
- Ask settle/dispose pattern
- `ui/text.ts`
- `ui/keymap.ts`
- `ui/scrollbar.ts`

先搭出一个空的 `btw/component.ts` 和 deferred test harness，验证 overlay `{ overlay: true }`、`done()`、shutdown 和 resize。

### Step 2：copy narumiruna 的纯 message skeleton

只把以下逻辑搬入临时工作区，再逐行改写：

- `createSideThread`
- `buildSideThreadMessages`
- `buildUserPrompt`
- `buildFollowUpPrompt`
- `extractAssistantText`

完成 `unknown` narrowing、readonly 状态、context budget、stop reason 和 generation guard 后，才放入 `packages/pi-basics/src/modules/btw/model.ts`。

### Step 3：补 rpiv/Firstp1ck 的窄逻辑

- rpiv response normalization 和 viewport clamp。
- Firstp1ck tool/image textification，改掉 `any`。
- 不复制 queue、streaming、WebUI 或 transfer。

### Step 4：最后写 feature orchestration

命令、lifecycle、tree/compact abort、session cleanup 和主入口全部按 `pi-basics` 现有 pattern 新写。不要从任一参考仓库复制入口文件。

## 9. 实施前最终判断

| 代码区域 | 决策 |
| --- | --- |
| `pi-basics` runtime/UI/test primitives | 直接复用 |
| narumiruna pure SideThread/message helpers | copy 后严格改写 |
| rpiv response/viewport snippets | copy 窄逻辑后改写 |
| Firstp1ck textification/cancel snippets | copy 窄逻辑后改写；去掉 any/queue |
| 任何参考 command handler | 重写 |
| 任何参考完整 component | 重写 |
| dbachelder AgentSession/tool workflow | 不采用 |
| global state/persistence/transfer/settings | 不采用 |

因此，实施不会从某个参考仓库整体复制到正式目录，而是先复用本地基础设施，再将约 5 个纯逻辑块作为 MIT attribution 下的改编起点。这样可以减少消息构造、响应归一化和 viewport 计算的工作量，同时保持 `pi-basics` 的 lifecycle、UI 和安全边界不被上游实现带偏。
