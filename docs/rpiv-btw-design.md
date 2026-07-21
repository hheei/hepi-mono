# `rpiv-btw` 设计摘要

## 1. 定位与边界

`@juicesharp/rpiv-btw` 是 Pi Agent 扩展，注册 `/btw <question>` 侧问题命令：使用当前主模型、复制主会话上下文，在底部临时面板显示答案，不把侧问答写入主 agent transcript。包自身不提供工具、独立模型选择器或磁盘持久化；历史只存于当前 Pi 进程的 `globalThis` 状态，进程退出即丢失。[事实：入口注释与 README](../references/rpiv-mono/packages/rpiv-btw/index.ts#L1-L10) [事实：README](../references/rpiv-mono/packages/rpiv-btw/README.md#L13-L72)

从包元数据看，Pi 通过 `package.json` 的 `pi.extensions` 加载 `./index.ts`；运行时依赖由宿主提供的 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` peer dependencies 注入。[事实：package.json](../references/rpiv-mono/packages/rpiv-btw/package.json#L1-L48)

## 2. 对外 API 与关键类型

### 入口注册

- 默认导出函数接收 `ExtensionAPI`，依次注册命令、`message_end` 快照钩子、`session_compact`/`session_tree` 失效钩子。[事实：index.ts](../references/rpiv-mono/packages/rpiv-btw/index.ts#L1-L10)

### `btw.ts` 导出

- `BTW_COMMAND_NAME = "btw"`：命令名。
- `BTW_STATE_KEY = Symbol.for("rpiv-btw")`：进程级共享状态键。
- `CROSS_SESSION_HINT_LIMIT = 10`：跨会话问题提示最多保留 10 条。
- `BTW_SYSTEM_PROMPT`：模块初始化时从 `prompts/btw-system.txt` 读取并去除末尾换行的系统提示词。
- `BtwTurn`：由真实 `UserMessage` 与未修改的 `AssistantMessage` 组成的问答记录。
- `BtwExecResult`：执行结果联合类型：成功包含答案及两条消息；普通失败包含错误；取消包含 `aborted: true`。
- `userMessageText`、`assistantMessageText`：分别提取消息中的文本；数组内容仅保留 text part，用户文本部分以换行连接。
- `clearSessionHistory`、`invalidateSnapshot`：清理指定会话的侧问历史或主会话消息快照。
- `executeBtw`：完成鉴权、组装消息、调用模型并归一化结果。
- `registerBtwCommand`、`registerMessageEndSnapshot`、`registerInvalidationHooks`：供入口注册的三个注册器。[事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L27-L35) [事实：类型与函数](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L55-L73) [事实：执行结果类型](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L174-L177)

### `btw-ui.ts` 导出

- `ShowBtwOverlayParams`：包含扩展命令上下文、当前问题、历史、独立 `AbortController`、清理历史回调。
- `ShowBtwOverlayResult`：返回 `overlayPromise` 与 `controllerReady`。
- `BtwOverlayController`：实现 Pi TUI `Component`；提供 `setAnswer`、`setError`、`handleInput`、`render`、`invalidate`。
- `showBtwOverlay`：创建底部 overlay 并返回控制器就绪及 overlay 完成两个 Promise。[事实：btw-ui.ts](../references/rpiv-mono/packages/rpiv-btw/btw-ui.ts#L60-L71) [事实：控制器](../references/rpiv-mono/packages/rpiv-btw/btw-ui.ts#L73-L161) [事实：工厂](../references/rpiv-mono/packages/rpiv-btw/btw-ui.ts#L214-L237)

### `pi-compat.ts` 导出

- `loadCompleteSimple()`：动态加载 `completeSimple`；优先尝试 `@earendil-works/pi-ai/compat`，仅在模块解析失败时回退到包根入口，若入口存在但初始化失败则重新抛出；两处都没有函数时抛出不支持宿主版本错误。[事实：pi-compat.ts](../references/rpiv-mono/packages/rpiv-btw/pi-compat.ts#L1-L91)

## 3. 核心流程与数据模型

1. `/btw` handler 先检查交互 UI、去除首尾空白后的问题、当前模型；失败时通过 `ctx.ui.notify` 返回固定错误或用法提示，不创建 overlay。[事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L309-L329)
2. 成功路径创建专用 `AbortController`，复制当前会话历史，调用 `showBtwOverlay`；等待控制器就绪后执行模型调用。[事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L331-L344)
3. 主会话上下文来自按会话文件键缓存的消息快照；没有快照时冷启动读取 `sessionManager.getBranch()`，仅取 `message` 条目并通过 `convertToLlm` 转换。请求消息顺序为：主会话消息、此前每个 `BtwTurn` 的用户/助手消息、当前问题。[事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L68-L73) [事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L179-L194)
4. 系统提示为静态提示词加上所有会话中按用户消息时间排序的最近问题列表；问题文本压缩空白、每条最多 200 字符，最多 10 条。[事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L155-L167) [事实：提示词](../references/rpiv-mono/packages/rpiv-btw/prompts/btw-system.txt#L1-L16)
5. `executeBtw` 获取当前模型的 API key/headers，调用 `completeSimple(model, { systemPrompt, messages, tools: [] }, { apiKey, headers, signal })`。成功响应的文本只取 assistant text parts 并 `trim()`；成功后才把真实消息对象加入该会话历史。[事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L200-L267) [事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L342-L358)
6. `message_end` 在非 `toolUse` assistant 消息结束后刷新快照；压缩或会话树变化时删除快照。遇到 Pi 核心“stale after session replacement”错误只在失效流程中吞掉，其他异常继续抛出。[事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L275-L307)

实现含义：快照是避免每次侧问都读取活动分支的缓存，不是持久化边界；`BtwTurn` 复用真实消息对象引用以保持后续请求前缀稳定，代码明确将其用于 cache parity。[事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L55-L57) [事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L187-L193)

## 4. UI 行为与交互语义

Overlay 使用 `bottom-center`、全宽、终端高度 85% 上限、无底部 margin。自然布局为 banner、历史问题、当前问题回显、答案/错误、footer；内容过高时从顶部裁剪，底部答案和 footer 保持可见，滚动窗口显示较旧历史。[事实：btw-ui.ts](../references/rpiv-mono/packages/rpiv-btw/btw-ui.ts#L40-L47) [事实：btw-ui.ts](../references/rpiv-mono/packages/rpiv-btw/btw-ui.ts#L129-L156)

- pending 状态显示 `…`；成功状态显示自动换行的答案；错误状态显示红色错误文本。[事实：btw-ui.ts](../references/rpiv-mono/packages/rpiv-btw/btw-ui.ts#L200-L210)
- `Esc` 调用专用 controller.abort() 并关闭 overlay；取消结果不会更新控制器，也不会写入历史。
- `↑`/`↓` 改变滚动偏移；`x` 清空当前 overlay 的历史并调用会话历史清理回调。
- 答案/错误出现后显示滚动提示；存在历史时显示清理提示；始终显示关闭提示。[事实：btw-ui.ts](../references/rpiv-mono/packages/rpiv-btw/btw-ui.ts#L104-L127) [事实：btw-ui.ts](../references/rpiv-mono/packages/rpiv-btw/btw-ui.ts#L134-L140)

实现含义：overlay 是临时显示层，答案通过控制器注入而非 Pi 主消息 API 注入，因此“主 transcript 不污染”是架构边界而非调用约定。[事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L345-L358)

## 5. 错误、取消与边界语义

- 非交互模式：通知 `/btw requires interactive mode`，提前返回。
- 空问题：通知 `Usage: /btw <question>`，仅按 `trim()` 判空。
- 无模型：通知 `/btw requires an active model`；执行层也独立检查无模型。
- API 配置失败：报告模型标签及 registry 错误；空 API key 报告无 key。
- 响应 `stopReason = aborted`：返回取消；`error`：包装 provider 错误；成功停止但没有文本 part：报告 `/btw returned no text content.`。
- 调用抛异常：若自己的 signal 已取消，转成取消；否则报告 `/btw call threw: ...`。
- `completeSimple` 配置了 `tools: []`，侧 agent 无工具能力；兼容加载器只对模块解析错误回退，避免掩盖真实初始化错误。[事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L205-L267) [事实：pi-compat.ts](../references/rpiv-mono/packages/rpiv-btw/pi-compat.ts#L23-L91)

## 6. 扩展点与依赖关系

正式扩展点是 Pi 的 `ExtensionAPI` 命令/事件注册、Pi UI 的 `custom` overlay、宿主模型 registry 与 `completeSimple`。包没有自定义 provider、工具协议、存储适配器或模型选择 API；要改变这些边界需修改 `btw.ts` 的执行器和 `pi-compat.ts`，而非仅替换 UI。[事实：package.json](../references/rpiv-mono/packages/rpiv-btw/package.json#L38-L48) [事实：btw.ts](../references/rpiv-mono/packages/rpiv-btw/btw.ts#L275-L313)

版本兼容集中在 `pi-compat.ts`：Pi 0.80+ 的 `/compat` 与旧宿主包根导出均被覆盖；Changelog 记录这是为兼容 `completeSimple` 迁移而引入。[事实：pi-compat.test.ts](../references/rpiv-mono/packages/rpiv-btw/pi-compat.test.ts#L1-L66) [事实：CHANGELOG.md](../references/rpiv-mono/packages/rpiv-btw/CHANGELOG.md#L9-L15)

## 7. 测试与可验证行为

- `btw.test.ts` 覆盖文本提取、状态键/提示词、会话清理、成功与鉴权/空响应/异常/取消分支、消息分支组装、快照写入与失效钩子、命令注册。[事实](../references/rpiv-mono/packages/rpiv-btw/btw.test.ts#L1-L382)
- `btw.command.test.ts` 覆盖三种提前返回、成功答案、取消、执行错误、跨会话问题提示。[事实](../references/rpiv-mono/packages/rpiv-btw/btw.command.test.ts#L1-L159)
- `btw-ui.test.ts` 覆盖 pending/answer/error 渲染、按键、历史清理、裁剪滚动、宽度截断及 overlay 行为。[事实](../references/rpiv-mono/packages/rpiv-btw/btw-ui.test.ts#L1-L271)
- `pi-compat.test.ts` 覆盖 `/compat` 成功、旧宿主根入口回退、真实初始化错误重抛、两处均无导出；`ship-manifest.test.ts` 验证发布文件覆盖生产 TypeScript 模块。[事实：pi-compat.test.ts](../references/rpiv-mono/packages/rpiv-btw/pi-compat.test.ts#L1-L66) [事实：ship-manifest.test.ts](../references/rpiv-mono/packages/rpiv-btw/ship-manifest.test.ts#L1-L11)

这些测试表明可观察契约集中在：不污染主会话、正确继承当前分支与侧问历史、取消不写历史、错误显示在 overlay、宿主版本兼容，以及 UI 高度/滚动规则。

## 8. 源码地图

- [入口与生命周期注册](../references/rpiv-mono/packages/rpiv-btw/index.ts)
- [命令、状态、消息组装、模型执行](../references/rpiv-mono/packages/rpiv-btw/btw.ts)
- [底部 overlay 与交互控制器](../references/rpiv-mono/packages/rpiv-btw/btw-ui.ts)
- [`completeSimple` 宿主兼容加载](../references/rpiv-mono/packages/rpiv-btw/pi-compat.ts)
- [侧 agent 系统提示](../references/rpiv-mono/packages/rpiv-btw/prompts/btw-system.txt)
- [包说明、安装与用户可见行为](../references/rpiv-mono/packages/rpiv-btw/README.md)
- [包元数据与 Pi 扩展声明](../references/rpiv-mono/packages/rpiv-btw/package.json)
- [行为测试](../references/rpiv-mono/packages/rpiv-btw/btw.test.ts)、[命令测试](../references/rpiv-mono/packages/rpiv-btw/btw.command.test.ts)、[UI 测试](../references/rpiv-mono/packages/rpiv-btw/btw-ui.test.ts)、[兼容测试](../references/rpiv-mono/packages/rpiv-btw/pi-compat.test.ts)、[发布清单测试](../references/rpiv-mono/packages/rpiv-btw/ship-manifest.test.ts)
