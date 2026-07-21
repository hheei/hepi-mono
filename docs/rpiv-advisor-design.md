# rpiv-advisor 设计摘要

## 1. 定位与边界

`rpiv-advisor` 是 Pi Agent 扩展，实现 advisor-strategy：当前 executor 通过零参数 `advisor` 工具，把当前会话分支交给独立配置的 reviewer 模型；reviewer 只返回计划、纠正或停止信号，executor 再继续。扩展不把 advisor 暴露为可调用工具链：side-call 明确传入 `tools: []`，advisor 不调用工具，也不直接产生面向用户的输出。[README](../references/rpiv-mono/packages/rpiv-advisor/README.md#L11-L21) [系统提示词](../references/rpiv-mono/packages/rpiv-advisor/prompts/advisor-system.txt#L1-L9) [执行](../references/rpiv-mono/packages/rpiv-advisor/advisor/execute.ts#L119-L127)

包入口注册工具、`/advisor` 命令及四个生命周期处理器：`before_agent_start`、`model_select`、`thinking_level_select` 和 `session_start`。配置持久化由 `@juicesharp/rpiv-config` 提供，主逻辑依赖 Pi 的 AI、coding-agent、TUI peer API；`typebox` 是运行时依赖，用于工具参数 schema。[入口](../references/rpiv-mono/packages/rpiv-advisor/index.ts#L1-L30) [元数据](../references/rpiv-mono/packages/rpiv-advisor/package.json#L29-L51)

**实现含义（基于上述事实）**：advisor 是一次独立的、无工具模型调用，不是第二个 executor；扩展的主要职责是选择/持久化 reviewer、按 executor 策略动态控制工具可见性，以及构造兼容 provider 的上下文。

## 2. 公共 API 与关键类型

包根入口默认导出 `ExtensionAPI` 初始化函数；初始化顺序为注册工具、命令、before-agent hook、模型/思考级别 hook、session-start restore。[入口](../references/rpiv-mono/packages/rpiv-advisor/index.ts#L13-L30)

`advisor/index.ts` 是包内公共 barrel，导出：

- `registerAdvisorTool`、`DEFAULT_PROMPT_SNIPPET`、`DEFAULT_PROMPT_GUIDELINES`；
- `registerAdvisorCommand`；
- `restoreAdvisorState`、`registerAdvisorSessionStart`；
- `registerAdvisorBeforeAgentStart`、`registerModelSelectHandler`、`registerThinkingLevelSelectHandler`；
- 配置 `loadAdvisorConfig`、`saveAdvisorConfig`；
- 状态 getter/setter：`getAdvisorModel`、`setAdvisorModel`、`getAdvisorEffort`、`setAdvisorEffort`；
- 策略 setter `setDisabledForModels`；上下文处理 `stripInflightAdvisorCall`、`ensureUserTailForAdvisor`；缓存 `getInventoryMessage`、`stableStringify`；常量 `ADVISOR_TOOL_NAME`。[barrel](../references/rpiv-mono/packages/rpiv-advisor/advisor/index.ts#L7-L39)

工具注册使用 `Type.Object({})`，即无参数；描述和默认 prompt guidance 指导 executor 在实质性工作前、卡住时和宣布完成前咨询 advisor。配置中的 `guidance` 经 `validateGuidanceFields` 校验后覆盖 snippet/guidelines。[工具注册](../references/rpiv-mono/packages/rpiv-advisor/advisor/register.ts#L14-L49)

工具结果是 `AgentToolResult<AdvisorDetails>`：`content` 始终为一个文本块；`details` 可含 `advisorModel`、`effort`、`usage`、`stopReason`、`errorMessage`。[执行结果类型](../references/rpiv-mono/packages/rpiv-advisor/advisor/execute.ts#L38-L64)

持久化配置的内部形状为：`modelKey?: string`、`effort?: ThinkingLevel`、`guidance?: GuidanceFields`、`disabledForModels?: DisabledForModelsEntry[]`；blocklist 项是字符串，或 `{ model: string; minEffort?: ThinkingLevel }`。[配置](../references/rpiv-mono/packages/rpiv-advisor/advisor/config.ts#L12-L20)

## 3. 核心流程与数据模型

### 初始化与选择

1. 扩展加载时注册 `advisor`，但有效使用依赖已选模型；没有模型时 session restore 和每轮 hook 会移除工具。
2. `/advisor` 要求交互 UI；从 `ctx.modelRegistry.getAvailable()` 构造模型项，并追加 `No advisor` 哨兵。用户选中 reasoning 模型时，再选择 `off` 或宿主支持的 reasoning levels；`xhigh` 仅在 `getSupportedThinkingLevels(model)` 包含它时出现。[命令](../references/rpiv-mono/packages/rpiv-advisor/advisor/command.ts#L35-L59) [命令处理](../references/rpiv-mono/packages/rpiv-advisor/advisor/command.ts#L104-L145)
3. 启用/禁用均先写盘，成功后才改变内存状态和 active tools；写盘失败只发错误通知，不留下半应用状态。[命令](../references/rpiv-mono/packages/rpiv-advisor/advisor/command.ts#L61-L102)
4. 配置路径由 `configPath("rpiv-advisor", "advisor.json")` 得出；README 记录默认 `~/.config/rpiv-advisor/advisor.json` 且权限为 0600。当前变更记录说明读取支持 XDG 路径和旧路径回退。[配置](../references/rpiv-mono/packages/rpiv-advisor/advisor/config.ts#L7-L24) [README](../references/rpiv-mono/packages/rpiv-advisor/README.md#L15-L20) [CHANGELOG](../references/rpiv-mono/packages/rpiv-advisor/CHANGELOG.md#L8-L15)

### 一次 advisor 调用

`executeAdvisor` 在入口快照 effort 和当前 advisor model，避免等待期间配置变化造成返回详情与实际请求不一致。随后依次检查：未配置模型、认证配置失败、无 API key；这些路径都返回统一文本 envelope，不抛给调用方。[执行](../references/rpiv-mono/packages/rpiv-advisor/advisor/execute.ts#L76-L98)

调用上下文每次实时读取 `ctx.sessionManager.getEntries()` 与 leaf，通过 `buildSessionContext` 获取 Pi 已解析的上下文（包括 compaction/branch summary），再 `convertToLlm`。之后：

- 从尾部移除当前正在执行的 `advisor()` toolCall，避免孤立 toolCall 被 provider 拒绝；其他同尾 toolCall 保留；
- 若尾消息仍为 assistant，追加最小 user nudge，满足拒绝 assistant-prefill 的 provider 要求；
- 从 `pi.getAllTools()` 生成可缓存的 executor tool inventory，并置于会话消息最前面（无工具时不添加）。[上下文](../references/rpiv-mono/packages/rpiv-advisor/advisor/context.ts#L11-L40) [执行](../references/rpiv-mono/packages/rpiv-advisor/advisor/execute.ts#L100-L112)

请求使用固定 `ADVISOR_SYSTEM_PROMPT`、上述消息、`tools: []`，并传入 API key、headers、abort signal、快照的 reasoning effort。`completeSimple` 运行时优先加载 `@earendil-works/pi-ai/compat`，仅在模块解析失败时回退 package root；非解析错误继续抛出。[提示词加载](../references/rpiv-mono/packages/rpiv-advisor/advisor/prompt.ts#L1-L14) [兼容层](../references/rpiv-mono/packages/rpiv-advisor/advisor/pi-compat.ts#L1-L64)

响应语义：`aborted` 返回取消错误；`error` 包装 provider error；文本块拼接并 trim，空文本返回 empty-response 错误；其他情况返回 advisor 文本及 usage/stopReason。[执行](../references/rpiv-mono/packages/rpiv-advisor/advisor/execute.ts#L119-L179)

### 工具 inventory 缓存

inventory 按工具名排序，格式包含名称、描述和稳定序列化后的 parameters，忽略安装位置相关的 `sourceInfo`。`stableStringify` 递归排序对象键，保持 JSON 对 `undefined` 的对象/数组语义。缓存放在 `globalThis[Symbol.for("rpiv-advisor")]`，签名只由工具名集合构成，因此同名集合即使顺序、描述、sourceInfo 改变也复用同一 Message；工具集合变化才重建。[inventory](../references/rpiv-mono/packages/rpiv-advisor/advisor/inventory.ts#L1-L79)

## 4. 配置、扩展点与生命周期整合

- **配置扩展**：`guidance.promptSnippet` 和 `guidance.promptGuidelines` 可替换工具注入 executor prompt 的指导；`disabledForModels` 可按 executor 模型永久禁用，或从某个 effort 阈值起禁用。[注册](../references/rpiv-mono/packages/rpiv-advisor/advisor/register.ts#L24-L44) [策略](../references/rpiv-mono/packages/rpiv-advisor/advisor/policy.ts#L30-L49)
- **模型/努力级别**：模型选择来自 Pi registry；reasoning 能力和 levels 由 Pi AI API 决定，不在包内硬编码模型清单。默认 advisor effort 为 `high`，但选择器允许 `off`。[命令](../references/rpiv-mono/packages/rpiv-advisor/advisor/command.ts#L48-L58) [消息常量](../references/rpiv-mono/packages/rpiv-advisor/advisor/messages.ts#L17-L22)
- **session_start**：读取配置、校验 blocklist、解析 model key，并从 registry 查找模型；缺失/不可解析/不再可用时清理内存选择并移除 advisor tool。有效模型按 executor 当前模型和 effort 判断是否激活。恢复通知通过进程级 latch 只显示一次，但状态每次事件都会更新。[restore](../references/rpiv-mono/packages/rpiv-advisor/advisor/restore.ts#L15-L94)
- **before_agent_start**：无 advisor model 或 executor 命中 blocklist 时移除工具，否则保持/恢复工具。[handlers](../references/rpiv-mono/packages/rpiv-advisor/advisor/handlers.ts#L40-L47)
- **model_select / thinking_level_select**：执行模型或其 thinking level 改变时即时 reconcile；状态变化才调用 `setActiveTools` 并在有 UI 时通知禁用/恢复。[handlers](../references/rpiv-mono/packages/rpiv-advisor/advisor/handlers.ts#L24-L37) [handlers](../references/rpiv-mono/packages/rpiv-advisor/advisor/handlers.ts#L50-L87)
- **UI**：两个 picker 共用 bordered custom panel，支持输入过滤、DEL/backspace、上下导航、Enter 选择、Esc 取消，最多显示 10 行。过滤是大小写不敏感的 subsequence，连续字符和词边界得分更高，同时匹配 label 与 value。[UI](../references/rpiv-mono/packages/rpiv-advisor/advisor-ui.ts#L43-L143) [fuzzy](../references/rpiv-mono/packages/rpiv-advisor/fuzzy.ts#L19-L73)

**实现含义**：active-tool 列表是运行时开关；blocklist 不删除配置，只控制当前 executor 下 advisor 是否进入 active tools，因此也控制其 prompt/schema 成本（CHANGELOG 明确记录该设计目的）。[CHANGELOG](../references/rpiv-mono/packages/rpiv-advisor/CHANGELOG.md#L104-L110)

## 5. 行为、错误与边界语义

- 未配置 advisor：工具调用返回 `ERR_NO_MODEL` 文本和 `errorMessage: "no advisor model selected"`；正常生命周期会把工具移除。[消息](../references/rpiv-mono/packages/rpiv-advisor/advisor/messages.ts#L33-L40) [执行](../references/rpiv-mono/packages/rpiv-advisor/advisor/execute.ts#L85-L89)
- 认证配置失败、缺 API key、side-call 抛异常、provider `error`、`aborted`、空文本均返回结果 envelope；调用方可从 `details.errorMessage`、`stopReason`、`usage` 判断。[执行](../references/rpiv-mono/packages/rpiv-advisor/advisor/execute.ts#L92-L98) [执行](../references/rpiv-mono/packages/rpiv-advisor/advisor/execute.ts#L129-L177)
- blocklist 字符串为任意 effort 阻断；对象无 `minEffort` 同样永久阻断；有阈值时 executor effort 必须达到或超过阈值。未定义 effort 的 ordinal 为 -1，因此不会触发阈值阻断。[策略](../references/rpiv-mono/packages/rpiv-advisor/advisor/policy.ts#L30-L45) [策略测试](../references/rpiv-mono/packages/rpiv-advisor/advisor.policy.test.ts#L45-L65)
- blocklist 比较规范化为 `provider/modelId`；策略兼容旧的 `provider:modelId` 存储值。当前保存格式和迁移说明见 changelog；运行中 advisor 标签仍按 `provider:id` 形成。[策略](../references/rpiv-mono/packages/rpiv-advisor/advisor/policy.ts#L18-L28) [CHANGELOG](../references/rpiv-mono/packages/rpiv-advisor/CHANGELOG.md#L31-L35) [执行](../references/rpiv-mono/packages/rpiv-advisor/advisor/execute.ts#L90-L94)
- `/advisor` 非交互模式直接报错；取消任一 picker 不改变状态；未知选择报错。禁用选择会清掉 model 和 effort，并移除 active tool。[命令](../references/rpiv-mono/packages/rpiv-advisor/advisor/command.ts#L104-L145)
- `stripInflightAdvisorCall` 只处理尾部 assistant 消息中的名为 `advisor` 的 call，不修改更早消息或其他 toolCall；空尾 assistant 会被整体移除。[上下文](../references/rpiv-mono/packages/rpiv-advisor/advisor/context.ts#L11-L23)

## 6. 测试与可观测覆盖

测试覆盖可作为当前行为契约索引：

- [advisor.execute.test.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor.execute.test.ts)：成功、compaction 后上下文、abort/error/空响应/抛异常、无模型和认证 envelope；
- [advisor.command.test.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor.command.test.ts)：命令注册、交互门槛、取消/禁用、reasoning effort、持久化失败的 persist-first 语义、生命周期 handler；
- [advisor.restore.test.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor.restore.test.ts)：配置缺失/非法/模型不可用、恢复激活、无可用模型时清理工具、通知 latch；
- [advisor.policy.test.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor.policy.test.ts)、[advisor.handlers.test.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor.handlers.test.ts)：blocklist 阈值和 active-tool reconcile；
- [advisor.config.test.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor.config.test.ts)：配置读写、字段清理、权限、blocklist 校验；
- [advisor.strip.test.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor.strip.test.ts)：孤立 advisor call 移除和 user-tail nudge；
- [advisor.inventory.test.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor.inventory.test.ts)：稳定序列化、工具排序、缓存签名和 globalThis 缓存；
- [fuzzy.test.ts](../references/rpiv-mono/packages/rpiv-advisor/fuzzy.test.ts)、[advisor-ui.filter.test.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor-ui.filter.test.ts)、[advisor-ui.panel.test.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor-ui.panel.test.ts)、[advisor-ui.picker.test.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor-ui.picker.test.ts)：过滤评分、面板内容、键盘交互和预选行为；
- [pi-compat.test.ts](../references/rpiv-mono/packages/rpiv-advisor/pi-compat.test.ts)：宿主 pi-ai 版本兼容加载；[ship-manifest.test.ts](../references/rpiv-mono/packages/rpiv-advisor/ship-manifest.test.ts)：发布文件清单。

## 7. 源码地图与依赖

- 入口与发布契约：[index.ts](../references/rpiv-mono/packages/rpiv-advisor/index.ts)、[package.json](../references/rpiv-mono/packages/rpiv-advisor/package.json)、[README.md](../references/rpiv-mono/packages/rpiv-advisor/README.md)。
- 领域 barrel/常量/状态：[advisor/index.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/index.ts)、[messages.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/messages.ts)、[state.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/state.ts)。
- 配置/策略/生命周期：[config.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/config.ts)、[policy.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/policy.ts)、[restore.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/restore.ts)、[handlers.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/handlers.ts)、[command.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/command.ts)。
- 调用上下文与模型请求：[context.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/context.ts)、[inventory.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/inventory.ts)、[prompt.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/prompt.ts)、[execute.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/execute.ts)、[pi-compat.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor/pi-compat.ts)、[prompts/advisor-system.txt](../references/rpiv-mono/packages/rpiv-advisor/prompts/advisor-system.txt)。
- 交互层：[advisor-ui.ts](../references/rpiv-mono/packages/rpiv-advisor/advisor-ui.ts)、[fuzzy.ts](../references/rpiv-mono/packages/rpiv-advisor/fuzzy.ts)。
- 外部运行时依赖：`@juicesharp/rpiv-config`（配置路径、JSON 读写、模型 key、guidance 校验）、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`。[package.json](../references/rpiv-mono/packages/rpiv-advisor/package.json#L43-L51)

文档中的 API、错误和边界均以当前源码、README、CHANGELOG 与测试中的可观察行为为准；未将 reviewer 的“计划/纠正/停止”进一步编码为结构化枚举，因为实现返回的是文本内容。
