# `rpiv-ask-user-question` 设计摘要

## 1. 定位与边界

`@juicesharp/rpiv-ask-user-question` 是 Pi extension，注册 `ask_user_question` 工具，让模型以结构化选项向用户提出澄清问题，而不是依赖自由文本猜测。产品边界包括：问题 schema、运行时校验、TUI 问卷、RPC/ACP 的原生 select/input 降级、答案封装、事件通知、工具可见性协调和可选本地化；不负责模型决策，也不持久化问卷答案。[README](../references/rpiv-mono/packages/rpiv-ask-user-question/README.md#L11-L25)

包入口默认函数同时注册工具和 reconciler；公开 exports 还暴露 prompt 事件及其 payload/question/option 类型。包的 npm `exports` 仅有 `.` 与 `./events`，生产文件由 `package.json.files` 明确列出。[index.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/index.ts#L18-L51) [package.json](../references/rpiv-mono/packages/rpiv-ask-user-question/package.json#L11-L13)

> **实现含义（由代码结构直接推出）**：这是 Pi 的交互扩展，不是通用问卷库；外部集成应依赖工具协议或 `events` 合约，不应依赖内部 TUI/state 模块。

## 2. 公共工具 API 与问题 schema

工具名是常量 `ask_user_question`。顶层参数为 `{ questions: Question[] }`：问题数 1–4；每题 `question`、`header`、2–4 个 `options`，可选 `multiSelect`（默认 false）。选项要求 `label`（最多 60 字符）、`description`，可选 `preview`；`header` 最多 16 字符。TypeBox schema 同时作为 Pi 工具参数 schema。[tool/types.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/tool/types.ts#L4-L9) [tool/types.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/tool/types.ts#L40-L93)

运行时校验是独立纯函数，补充 schema/调用入口之外的语义约束：

- 空问题数组 → `no_questions`；超过 4 题 → `too_many_questions`。
- 同一次调用中问题文本必须唯一 → `duplicate_question`。
- 每题少于 2 个选项 → `empty_options`；选项标签必须唯一 → `duplicate_option_label`。
- `Other`、`Type something.`、`Next` 是保留标签，命中时返回 `reserved_label`，且优先于重复标签判断；多选题同样禁止这些标签。[tool/validate-questionnaire.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/tool/validate-questionnaire.ts#L14-L56) [tool/row-intent.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/row-intent.ts#L108-L120)

回答采用 `QuestionAnswer` 判别联合：`kind: "option"` 携带单个选项 label，`kind: "custom"` 携带用户输入，`kind: "multi"` 以 `selected: string[]` 携带选中 labels 且 `answer` 为 null；可附带 `notes`，单选预览选项还可附带 `preview`。结果为 `{ answers, cancelled, error? }`。[tool/types.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/tool/types.ts#L95-L145)

## 3. 执行与交互流程

`registerAskUserQuestionTool` 注册工具，并读取 `rpiv-ask-user-question` 配置中的 guidance 覆盖默认 prompt snippet/guidelines。执行顺序如下：[ask-user-question.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/ask-user-question.ts#L105-L145)

1. `ctx.hasUI` 为 false 时立即返回 `no_ui`，不展示问题。
2. 通过 `validateQuestionnaire`；失败返回英文错误文本和结构化 `details`。
3. 发出 `rpiv:ask-user:prompt` 事件。
4. RPC host 且同时提供 `ui.select`、`ui.input` 时，走顺序式 RPC walker，不加载 TUI 图。
5. 其他可交互 host 懒加载 `QuestionnaireSession`，构造每题的选项/哨兵行后调用 `ctx.ui.custom`。
6. `custom()` 返回 `QuestionnaireResult` 后统一构建 LLM-facing envelope；若返回 `undefined`，有原生 dialog primitive 则转 RPC，否则返回 `no_custom_ui`。
7. 无论成功、取消还是异常的 UI 加载失败，最后都会清理 terminal input listener。

TUI session 以 `QuestionnaireState` 为单一状态源，包含当前 tab/焦点、输入模式、答案 map、多选集合、notes 草稿、Submit picker 和 collapsed 状态。键盘输入由 `routeKey` 转为 action，纯 `reduce` 产出新 state 与 effects；`QuestionnairePropsAdapter` 将 state 投影到 TabBar、选项列表、预览、Submit picker 等组件。[state/state.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/state.ts#L4-L55) [state/questionnaire-session.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/questionnaire-session.ts#L50-L170) [state/build-questionnaire.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/build-questionnaire.ts#L75-L90)

`buildItemsForQuestion` 先复制作者选项，再按 `ROW_INTENT_META` 追加运行时哨兵：单选追加 `Type something.`；多选追加 `Type something.` 与不计数的 `Next`。因此作者不应手写这些行。[ask-user-question.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/ask-user-question.ts#L93-L103) [state/row-intent.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/row-intent.ts#L21-L55)

TUI 支持 Tab 切题、单选 Enter、多选 Space/Enter-as-toggle、Next 提交、Submit tab、Esc 取消、预览选项 notes，以及可配置的折叠快捷键（默认 `ctrl+]`，`off` 禁用）。notes 存在独立 `notesByTab` side-band，确认时才合并答案，避免“有 notes 即算已回答”。[state/state.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/state.ts#L13-L35) [README](../references/rpiv-mono/packages/rpiv-ask-user-question/README.md#L15-L25)

RPC walker 逐题调用 `select` 或 `input`。单选额外提供 custom 行，预览内容折叠进标题并限制为 600 字符；多选输入接受逗号/空格分隔的数字并去重，空提交表示空选择，非索引输入保留为 custom answer。任一 primitive 返回 `undefined`，整份问卷取消。[rpc-fallback.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/rpc-fallback.ts#L40-L100) [rpc-fallback.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/rpc-fallback.ts#L102-L166)

## 4. 输出、取消与错误语义

`buildQuestionnaireResponse` 把非取消结果包装为：`User has answered your questions: ... You can now continue with the user's answers in mind.`；每段采用 `"question"="answer"`，可追加 `selected preview` 与 `user notes`。取消、空 answers 或 null result 统一输出 `User declined to answer questions`，并将 `cancelled` 设为 true。[tool/response-envelope.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/tool/response-envelope.ts#L4-L47)

空/空选答案统一格式为 `(no input)`；多选答案以逗号连接 labels。`QuestionnaireResult.error` 用于机器可读失败类别；`no_custom_ui`、`session_load_failed`、`stale_module_cache` 明确说明用户没有看到问题，不应被模型当成用户拒答。[tool/format-answer.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/tool/format-answer.ts#L3-L29) [ask-user-question.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/ask-user-question.ts#L43-L52)

`QuestionnaireSession` 的 TUI 取消由 reducer 发出 `{ answers, cancelled: true }`；RPC 取消同样走共享 envelope。UI 模块动态加载失败会区分普通 `session_load_failed` 与 jiti stale module cache 的 `stale_module_cache`，后者提示重启 Pi。[state/questionnaire-session.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/questionnaire-session.ts#L122-L170) [ask-user-question.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/ask-user-question.ts#L63-L90)

## 5. 扩展点、集成与依赖

- **Pi 集成**：依赖 `ExtensionAPI.registerTool`、`ctx.hasUI`、`ctx.ui.custom`、可选 `ctx.ui.onTerminalInput` 和 `pi.events.emit`；`reconcileAskUserQuestionTool` 在 `before_agent_start` 前按 `ctx.hasUI` 从 active tools 移除/恢复工具，操作幂等。[reconcile.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/reconcile.ts#L20-L47)
- **事件集成**：`rpiv:ask-user:prompt` payload 是 JSON-safe 的问题摘要，包含 `multiSelect`、选项 label/description 和 `hasPreview`，不传预览正文。事件稳定策略要求 channel 不改名，payload 仅追加可选字段；破坏性改变需新 channel。[events.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/events.ts#L1-L43) [ask-user-question.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/ask-user-question.ts#L24-L38)
- **配置集成**：配置从 `@juicesharp/rpiv-config` 加载，可覆盖 `guidance` 与 `collapseKey`；collapse key 严格遵循 pi-tui key-id 语法，无效值回退 `ctrl+]`，`off` 关闭。[config.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/config.ts#L4-L75)
- **本地化**：`@juicesharp/rpiv-i18n` 是 optional peer。入口动态注册 `locales/`；桥接层在运行时解析 sentinel/UI 文案，缺 SDK 时使用内置英文 fallback，不使扩展离线。[index.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/index.ts#L23-L39) [state/i18n-bridge.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/i18n-bridge.ts#L1-L51)
- **依赖边界**：运行依赖为 `@juicesharp/rpiv-config`、`typebox`；Pi agent、pi-tui、i18n 为 peer（i18n optional）。TUI render graph 延迟加载，RPC 路径可避免加载它。[package.json](../references/rpiv-mono/packages/rpiv-ask-user-question/package.json#L80-L93)

> **实现含义**：新增哨兵行应先扩展 `WrappingSelectItem` union，再补 `ROW_INTENT_META`，并由构造 walker 决定出现条件；新增 UI 文案应走 i18n bridge 的调用时解析，而非模块级缓存。

## 6. 测试覆盖与源代码地图

测试覆盖已观察到以下契约：工具注册/schema 与默认 guidance、无 UI/校验早返回、取消和 envelope、`custom()` 不可用时 RPC fallback、TUI factory 渲染与真实 pi-tui key sequences、state reducer 的导航/多选/tab/notes/submit/cancel、row-intent 哨兵规则、RPC 输入解析、配置 key 校验、i18n bridge fallback、事件 payload、禁止旧 boolean flags，以及发布 manifest 覆盖所有生产 `.ts` 模块。[ask-user-question.execute.test.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/ask-user-question.execute.test.ts#L29-L246) [factory.test.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/factory.test.ts#L92-L103) [state/state-reducer.test.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/state-reducer.test.ts#L13-L157) [ship-manifest.test.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/ship-manifest.test.ts#L4-L8)

主要源文件：

- [入口与工具执行](../references/rpiv-mono/packages/rpiv-ask-user-question/index.ts)、[ask-user-question.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/ask-user-question.ts)
- [公开事件](../references/rpiv-mono/packages/rpiv-ask-user-question/events.ts)、[工具类型](../references/rpiv-mono/packages/rpiv-ask-user-question/tool/types.ts)
- [校验与输出](../references/rpiv-mono/packages/rpiv-ask-user-question/tool/validate-questionnaire.ts)、[response-envelope.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/tool/response-envelope.ts)、[format-answer.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/tool/format-answer.ts)
- [TUI 状态/路由](../references/rpiv-mono/packages/rpiv-ask-user-question/state/state.ts)、[state-reducer.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/state-reducer.ts)、[key-router.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/key-router.ts)、[questionnaire-session.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/questionnaire-session.ts)
- [视图组装](../references/rpiv-mono/packages/rpiv-ask-user-question/state/build-questionnaire.ts)、[view/](../references/rpiv-mono/packages/rpiv-ask-user-question/view/)
- [RPC 降级与工具协调](../references/rpiv-mono/packages/rpiv-ask-user-question/rpc-fallback.ts)、[reconcile.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/reconcile.ts)
- [配置与本地化](../references/rpiv-mono/packages/rpiv-ask-user-question/config.ts)、[state/i18n-bridge.ts](../references/rpiv-mono/packages/rpiv-ask-user-question/state/i18n-bridge.ts)、[locales/](../references/rpiv-mono/packages/rpiv-ask-user-question/locales/)
