# Pi BTW 首版历史方案

状态：已实现；本文件记录 package 拆分前后的原始范围和验收依据，不定义当前行为。

关联研究：[`implementation-research.md`](../../research/btw/implementation-research.md)

实施前复用清单：[`reuse-inventory.md`](../../research/btw/reuse-inventory.md)

本文件记录 `/btw` 首版的功能边界、架构、预期行为、测试契约和实施顺序。当前实现位于 `packages/pi-btw/src`；当前行为以代码、测试和 `packages/pi-btw/README.md` 为准。

## 1. 一句话方案

在 `@hheei/pi-btw` 内提供一个 session-scoped 的 `/btw <question>` 命令：复制当前 Pi 分支的对话上下文，用当前主模型发起一次无工具的独立侧问请求，在临时 TUI overlay 中显示答案；成功的侧问答可在同一个 Pi session 的后续 `/btw` 请求中继续使用，但永远不写入主 agent transcript、磁盘或主 agent 的工具上下文。

首版采用 `narumiruna/pi-extensions` 的轻量 `SideThread` 思路，吸收 `rpiv-btw` 的成功后提交、取消竞态、宽度安全和错误归一化规则。不会直接复制任何参考仓库的状态、兼容垫片或 UI。

## 2. 功能边界

### 2.1 首版包含

- 顶层命令 `/btw <question>`。
- TUI 交互模式下的临时 overlay。
- 当前 session、当前 active branch 的只读上下文，使用 `sessionManager.buildSessionContext()`。
- 当前主模型和当前 Pi `modelRegistry.getApiKeyAndHeaders()` credential/auth resolution。
- 无工具、无文件修改、无 shell、无搜索的独立模型请求。
- 当前 session 内的成功 side-thread 历史。
- 专用 `AbortController`，`Esc` 取消当前请求并关闭 overlay。
- provider error、鉴权错误、空响应、异常和取消的明确显示。
- ANSI/cell-width 安全的换行、截断和窄终端布局。
- session switch、reload、shutdown 时的幂等清理。
- 纯模型/消息/状态函数测试和 TUI 行为测试。

### 2.2 首版明确不包含

- 不注册 `btw` model-facing tool。
- 不启用 `read`、`bash`、`edit`、`write` 或任何 MCP tool。
- 不创建独立 `AgentSession`，不允许 side-thread 改变文件或主 session。
- 不把答案作为 custom message、assistant message 或 follow-up 写回主 transcript。
- 不做磁盘持久化、session custom entry、跨进程恢复或跨 session hint。
- 不做 globalThis、`Symbol.for` 或模块级跨 runtime 状态。
- 不新增 settings、模型选择器、thinking-level 配置或 `/btw:model` 等子命令。
- 不做 `/btw:new`、`/btw:clear`、`/btw:inject`、`/btw:summarize`、`--save`、transfer。
- 不做 RPC/WebUI widget、浏览器 overlay 或鼠标选择。
- 首版每次 `/btw <question>` 处理一个问题；不在 overlay 内提供第二个 composer。
- 首版不做流式 token 展示；模型返回后一次性显示答案。若延迟成为实际问题，再单独评估 streaming。

这些排除项是行为边界，不是未来 API 承诺。任何新增能力都需要单独更新设计和测试契约。

## 3. 用户可见行为

### 3.1 命令

```text
/btw <question>
```

规则：

| 输入 | 预期结果 |
| --- | --- |
| `/btw` | 显示 `Usage: /btw <question>`，不打开 overlay、不调用模型 |
| `/btw   ` | 同上；问题按 trim 后判空 |
| `/btw question`，非 TUI | 通知 `/btw requires interactive mode`，不调用模型 |
| `/btw question`，无 active model | 通知 `/btw requires an active model`，不打开 overlay |
| `/btw question`，已有 BTW 请求 | 拒绝新请求并通知当前请求仍在运行；不并发覆盖旧 overlay |
| `/btw question`，正常 | 打开 overlay，显示 pending，完成后显示答案 |

命令参数只作为问题文本使用，不解析 flag，不把问题内容当作命令或系统指令。

### 3.2 Overlay

Overlay 使用 `ctx.ui.custom`，遵循 `DESIGN.md` 的平面、方形、语义化 TUI 规则：

```text
BTW · side thread

Q  <当前问题>

<答案，按 terminal width 换行>

↑/↓ scroll · x clear history · Esc close
```

状态：

- `pending`：显示问题和简短的等待状态；答案区域不显示伪造内容。
- `answer`：显示成功答案；过高内容从顶部裁剪，答案底部和 footer 保持可见。
- `error`：显示可读错误，使用 error 语义色；不把错误写入 side history。
- `aborted`：关闭 overlay，不把取消当作错误，不写 side history。

按键：

- `Esc`：取消当前模型请求并关闭 overlay；关闭动作幂等。
- `↑` / `↓`：滚动答案和历史问题；边界处不改变状态。
- `x`：清除当前 session 的 side history，并取消当前 pending 请求；只影响未来 BTW 请求，不修改主 session。
- 其他输入：不发送、不写 editor、不改变 Pi 主会话。

有历史时 overlay 显示最近的 side questions，答案历史是否显示由高度决定；模型请求上下文始终包含所有已成功提交的 user/assistant turn，不能因为 UI 裁剪而丢失 provider history。

### 3.3 主 session 隔离

成功或失败的 BTW 都不会产生：

- `pi.sendMessage()` 或 `pi.sendUserMessage()`；
- `appendEntry()`；
- 主 transcript custom message；
- 主 agent follow-up；
- active tool set 变化。

`/btw` 只读取当前主 session；side history 保存在当前 runtime 的内存中，session shutdown 后释放。

## 4. 模型和上下文契约

### 4.1 请求消息

每次请求的消息顺序固定为：

```text
main branch context
+ successful BTW user/assistant turns for this session
+ current BTW question
```

主 branch context 在每次 `/btw` 调用时从当前 active branch 重新构建，而不是建立长期快照。这样首版不需要 `message_end` snapshot hook，也不会因为 `/tree`、`/compact`、`/resume` 事件遗漏而使用旧 branch。

主 context 的转换策略：

- 使用 `ctx.sessionManager.buildSessionContext().messages` 作为来源；不得手写 `getBranch()` 过滤来绕过 compaction、branch summary 或 session context 规则。
- 使用 Pi 的 `convertToLlm` 转换普通 user/assistant 消息。
- 不把 `custom` entries、BTW overlay 内容或其他 session 的消息注入请求。
- 工具调用和工具结果不得以 provider tool-call 结构进入 BTW 请求；实现必须把它们序列化为普通背景文本，或在 Phase 0 做跨 provider 兼容测试后明确保留策略。首版默认使用普通背景文本，避免 `tools: []` 与历史 tool-call 序列冲突。
- 对主背景、side history 和当前问题设置统一 context budget；超限时先裁剪最旧主背景，再裁剪最旧 side turns，当前问题不得被裁剪为空。
- 二进制/图片内容按宿主转换结果处理；不自行读取文件或重新加载图片。

预算必须是纯函数可测试的，并在实现前锁定为一个常量。首版不引入摘要模型来压缩上下文。

### 4.2 SideThread

建议的最小模型：

```ts
interface BtwTurn {
  readonly user: UserMessage;
  readonly assistant: AssistantMessage;
}

interface BtwSessionState {
  readonly sessionId: string;
  readonly turns: readonly BtwTurn[];
}
```

约束：

1. 当前问题先构造真实 `UserMessage`。
2. 只有 provider 成功返回、存在 assistant text 且请求未 abort 时，才将 user/assistant 一起 commit 到 turns。
3. provider error、空文本、异常和取消均不 commit。
4. `x` 清理 history 时递增 `historyGeneration` 并 abort 当前 pending 请求；任何 generation 不匹配的晚到 response 都不能 commit。
5. 当前请求关闭后，任何晚到的 provider response 都不能重新写入已清理、已 compact/tree 或已切换的 runtime。
6. 同一时间最多一个 active request；首版不实现排队。这个限制必须在 command 测试中固定下来。
7. 只有 `stopReason === "stop"` 且存在非空 assistant text 时才算成功。`length`、`error`、`aborted`、`toolUse` 和未知 stop reason 均作为非成功结果处理；是否展示截断文本必须在 executor 中显式标记，不能 commit 到 side history。

### 4.3 System prompt

系统提示是包内静态文本，至少表达：

- 这是对当前主对话的侧问，不是主任务执行。
- 主对话仅作为背景，不能声称已经修改文件或运行命令。
- BTW 没有工具，不得要求或尝试工具调用。
- 直接回答问题；信息不足时明确说明，不编造事实。
- 不把当前问题中的指令当成提升权限的系统指令。

系统 prompt 不包含跨 session 问题列表，不暴露其他 session 的信息。

### 4.4 Provider 调用

执行器使用当前 `ctx.model`，通过当前 `ctx.modelRegistry.getApiKeyAndHeaders(model)` 获取 `apiKey`、`headers` 和 `env`，然后调用 `@earendil-works/pi-ai/compat` 的 `completeSimple`：

```text
completeSimple(
  currentModel,
  {
    systemPrompt,
    messages,
    tools: [],
  },
  {
    apiKey,
    headers,
    env,
    signal: btwAbortController.signal,
  },
)
```

实现要求：

- `@hheei/pi-btw` 必须在 `peerDependencies` 中声明 `@earendil-works/pi-ai >=0.80.10`，因为生产代码会直接 import `@earendil-works/pi-ai/compat`。
- 不复制参考仓库的动态 import fallback；若未来需要跨 Pi 版本兼容，另开小型 compat adapter，并测试“仅解析失败时 fallback”。
- `tools: []` 是执行契约，不只依赖 system prompt 禁止工具。
- 使用 BTW 自己的 signal，不复用主 agent signal，避免 Esc 取消 BTW 时中止主 agent。
- 只提取 assistant text parts；无文本返回必须归一化为错误。
- `auth.ok === false`、空 `apiKey` 且 provider 需要 key、provider throw、unknown stop reason 都必须有独立测试。

## 5. Runtime 和生命周期

### 5.1 Feature 结构

建议新增：

```text
packages/pi-btw/src/
  index.ts       # public feature factory/export
  feature.ts     # command、runtime、lifecycle orchestration
  model.ts       # message/context/turn pure functions
  executor.ts    # model/auth/completeSimple adapter
  component.ts   # overlay component
  prompt.ts      # static BTW system prompt

packages/pi-btw/test/
  model.test.ts
  executor.test.ts
  feature.test.ts
  component.test.ts
```

入口在 `packages/pi-btw/src/extension.ts` 创建 `createBtwFeature()` 并注册 command/lifecycle hooks。`BtwFeature` 持有当前 `HePiRuntimeContext` 和 session-local state，不把 runtime 放在模块全局。

### 5.2 Session lifecycle

- `session_start`：由现有 `HePiLifecycleController` 创建 runtime；清空或重新初始化 BTW state；注册 session-local cleanup。
- `session_shutdown`：abort active request、关闭 overlay、移除 abort listener、释放 turns 和 component 引用；cleanup 可重复执行。
- `/new`、`/resume`、`/fork`、`/clone`：旧 runtime shutdown 后新 session 获得空 BTW history；不跨 session 复制 history。
- `/reload`：旧 feature cleanup 后重新绑定新 runtime；不从磁盘恢复 BTW history。
- `session_before_tree`、`session_before_compact`：递增 `contextRevision`，abort active request，并通过 guarded `done()` 关闭 overlay；不能等待后续 `session_tree` 或 compact 完成。
- `session_tree`、`session_compact`：由于主 context 每次重新读取，不需要 BTW 自己维护主消息快照；已完成的 side history 在同一 session 内保留，但任何 tree/compact 前发出的 pending response 都因 revision 不匹配而禁止 commit。

### 5.3 并发和 stale callback

每个 invocation 生成一个 request token 或 revision：

```text
sessionId + runtimeRevision + contextRevision + historyGeneration + requestRevision
```

异步 provider 返回、overlay `done`、abort cleanup 和 history commit 都必须验证 token 仍属于 active request。任何旧 session、旧 branch/compact context、旧 history generation 或旧 request callback 都不能更新新 session 的 UI、history 或 status。

## 6. 错误和取消矩阵

| 条件 | 用户可见结果 | 是否写 side history | 是否影响主 agent |
| --- | --- | --- | --- |
| 空问题 | usage notification | 否 | 否 |
| 非 TUI | error notification | 否 | 否 |
| 无 model | error notification | 否 | 否 |
| credential lookup 失败 | overlay error 或 notification | 否 | 否 |
| API key 为空 | 明确 auth error | 否 | 否 |
| provider 返回 error | overlay error | 否 | 否 |
| provider 返回 aborted | 关闭/取消状态 | 否 | 否 |
| provider 返回无 text | no text error | 否 | 否 |
| provider throw，signal 未取消 | normalized exception error | 否 | 否 |
| provider throw，signal 已取消 | 取消 | 否 | 否 |
| overlay close while pending | abort + close | 否 | 否 |
| success with text and `stopReason === "stop"` | answer | 是，user+assistant 原子 commit | 否 |
| success with `stopReason === "length"` | truncated/error state | 否 | 否 |
| success with `stopReason === "toolUse"` | protocol error | 否 | 否 |
| `x` while pending | abort + clear history | 否 | 否 |
| tree/compact while pending | abort + close overlay | 否 | 否 |
| session shutdown | abort + dispose + close overlay | 不提交未完成 turn | 否 |

`success` commit 必须在 UI 更新前完成或由同一个 guarded completion 顺序完成，不能出现 UI 显示成功但 side history 没有该 turn 的不一致状态。

## 7. 与现有 pi-basics 的整合规则

- 复用 `HePiRuntimeContext`、`HePiLifecycleController`、`ctx.ui.custom(..., { overlay: true })` 和 `requestRender` 模式。
- 复用 `packages/pi-basics/src/ui/text.ts` 的 `wrap`、`truncateToWidth`、`padToWidth`，必要时复用 `renderScrollbar` 和 `keyGlyph`。
- 颜色只使用 `DESIGN.md` 已定义的 `accent`、`text`、`muted`、`dim`、`error`、`border`；不新增 BTW 专用 palette。
- overlay 最多拥有一个平面语义 surface，不做 nested card、圆角、阴影、渐变或装饰背景。
- 不把 BTW 加进 `/hepi` tab；BTW 是即时命令，不是 Settings/Loadout module。
- 不改变 `ToolActivationCoordinator`、Loadout、Ask、Goal、Todo 或 Statusbar 的 active tool 和持久化契约。
- 若需要显示轻量运行状态，只使用已有 `ctx.ui.setStatus("btw", ...)`，请求结束或 cleanup 时清除；首版不修改 footer owner。
- README 必须记录 `/btw`、TUI-only、无工具、session-memory-only、不会修改主 transcript 及不兼容项。

## 8. 分阶段实施

### Phase 0：Host seam 和边界确认

1. 核对当前 lock 中 `@earendil-works/pi-ai/compat` 的 `completeSimple`、`@earendil-works/pi-coding-agent` 的 `convertToLlm`、`buildSessionContext()`、`ctx.ui.custom` 类型。
2. 确认 `completeSimple` 的 response stop reason、text parts、abort signal、`env` 传递行为。
3. 确认 `sessionManager.buildSessionContext()` 的 active branch 和 compaction-aware 语义。
4. 确认 `ctx.ui.custom(..., { overlay: true })` 的 `done()`、dispose、shutdown Promise 行为。
5. 创建最小 test double；不写生产 BTW 代码。

**Gate：** 可以在测试中稳定模拟 success/error/aborted/no-text/length/toolUse，能够从当前 branch 得到 compaction-aware messages，并能证明 overlay shutdown 不悬挂 command handler。

### Phase 1：纯模型和 SideThread

实现 `model.ts`：

- 输入清洗和 usage validation；
- branch message 过滤/转换；
- main context、side history、当前问题的统一 budget 和从旧到新的裁剪；
- side turn message 构造；
- success-only commit；
- history clear；
- text extraction；
- request token、context revision、history generation guard。

**测试：** 消息顺序、主 context 只出现一次、成功 commit、失败/取消/length/toolUse 不 commit、clear+late response、tree/compact+late response、裁剪、控制字符和空文本。

### Phase 2：模型执行器

实现 `executor.ts`：

- current model/auth resolve；
- `tools: []` assertion；
- `completeSimple` adapter；
- response normalization；
- signal forwarding；
- error classification；
- package peer dependency/ship manifest check for `@earendil-works/pi-ai`。

**Gate：** executor 不依赖 TUI、不触碰主 session、不修改 active tools。

### Phase 3：TUI overlay

实现 `component.ts`：

- pending/answer/error 状态；
- narrow/wide layout；
- terminal-width-safe wrapping/truncation；
- bounded vertical viewport；
- `Esc`、`↑`、`↓`、`x`；
- `ctx.ui.custom` overlay options；
- requestRender/invalidate；
- settled/done/dispose 幂等，确保 abort、Esc、shutdown 都会 exactly-once 调用外层 `done()`。

**测试：** 至少覆盖 40、80、120 列；答案超高、超长单行、ANSI 文本、error、pending、Esc、shutdown dispose、resize 和 clear history。

### Phase 4：Feature 和生命周期

实现 `feature.ts` 与入口整合：

- 注册 `/btw`；
- TUI/empty/model/active-request guards；
- overlay-ready 后发起 executor；
- commit/update/close 顺序；
- session start/shutdown/reload cleanup；
- session_before_tree/session_before_compact abort；
- stale callback guard；
- status cleanup。

**测试：** command routing、单请求互斥、主 session 未写入、active tools 未变、session switch/shutdown/tree/compact、overlay Promise 不悬挂、auth/provider branches。

### Phase 5：文档、集成验证和 smoke test

1. 更新 `packages/pi-btw/README.md`。
2. 添加 package exports（只暴露确实需要的 feature/model 类型）。
3. 更新 `packages/pi-btw/package.json` peer dependency 和 ship manifest 覆盖。
4. 运行 focused tests、`bun run typecheck`、`bun run check`，再运行 `bun test`。
5. 使用真实 Pi TUI 做 success/error/Esc/clear/resize/tree/compact smoke test。
6. 检查主 session JSONL，确认 BTW 问题和答案没有被写入。

## 9. Acceptance criteria

### 必须满足

- `/btw <question>` 在 TUI 中可用；空问题、非 TUI、无 model 都 fail closed。
- 当前主模型能收到当前 branch context、成功 BTW history 和当前问题，顺序稳定。
- provider 请求的 `tools` 明确为空，且历史工具信息不会以 provider tool-call 结构与 `tools: []` 冲突。
- 成功答案显示在 overlay，失败/取消行为符合矩阵。
- Esc 不会取消主 agent；session shutdown 会取消 BTW。
- 取消、失败、空文本和晚到 response 不会污染 side history。
- `x` 会 abort pending request、清理后续请求中的 side history，且不会修改主 session。
- 所有渲染行不超过 terminal width，resize 后不崩溃、不重叠。
- 主 session transcript、custom entries、active tools、磁盘均不因 BTW 改变。
- 所有 session-local state 在 shutdown/reload 后释放，overlay custom Promise 不悬挂。
- 现有 `pi-btw` 与 `pi-basics` tests、typecheck、check 不回归。

### 明确不作为首版验收

- token streaming。
- cross-session memory。
- BTW history 的 restart persistence。
- side-agent tool use。
- 主 transcript 注入、总结和 transfer。
- RPC/WebUI 版本化 widget。

## 10. 后续扩展的决策门

只有首版通过 acceptance 后才评估：

1. **Streaming：** 真实 provider latency 和用户反馈证明一次性响应不足时，再引入 stream adapter；必须保留 success-only commit 和 abort race contract。
2. **Overlay 内 follow-up：** 用户确实需要连续对话输入时，再把当前单次 command 改成 composer loop；不能同时改变 session persistence 和主 transcript boundary。
3. **显式 transfer：** 只有用户明确要求把 BTW 结果交给主 agent 时，才设计 `transfer`，并单独定义安全的 custom message/follow-up contract。
4. **Model/thinking settings：** 需要实际需求和 settings schema 评审，不从参考仓库自动带入。
5. **Persistence：** 必须先定义 branch-local semantics、compaction/replay 和隐私边界，不采用 `globalThis` 作为临时替代。

任何扩展都不得默认放开工具权限；如果将来需要可执行 side-agent，应作为独立功能而不是偷偷改变 `/btw` 的只读语义。

## 11. 验证命令

```bash
bun test packages/pi-btw/test
bun run typecheck
bun run check
bun test
```

研究阶段不运行这些命令；它们属于实现阶段的验收顺序。
