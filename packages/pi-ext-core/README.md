# @hheei/pi-ext-core

`@hheei/pi-ext-core` 为独立的 `pi-<name>` 扩展提供轻量、强类型且无副作用的会话生命周期、跨扩展服务协作、后台任务状态机、完成门控、TUI 视图路由与公共基础设施原语。

本包**不是** Pi extension（不声明 `pi.extensions` 入口）；导入本包没有全局副作用。只有扩展显式调用注册 API 后，core 才会创建对应运行时状态或挂载宿主监听。

## 子路径与优化

- `@hheei/pi-ext-core`: 统一公共入口（导出全部公共 API）。
- `@hheei/pi-ext-core/errors`: 仅包含轻量错误处理辅助函数（`errorMessage`, `abortError`, `throwIfAborted`），供 worker 或子进程快速导入，避免载入完整模块图开销。

---

## 核心机制与 API 分类清单

### 1. 生命周期与资源管理 (Lifecycle & Cleanup)

负责 session start/shutdown 时的串行初始化、失败回滚与逆序清理。

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `registerExtensionLifecycle(pi, options)` | 函数 | 注册以扩展包名为稳定 key 的会话生命周期，提供幂等资源清理与 `context.signal` |
| `DisposerRegistry` | 类型 | 集中管理资源清理闭包的注册表，逆序安全执行，汇总清理异常 |
| `errorMessage(error)` | 函数 | 跨不可信边界安全提取 Error 实例或未知值的可读字符串 |
| `abortError(message?)` | 函数 | 构造标准名为 `AbortError` 的 DOMException/Error 实例 |
| `throwIfAborted(signal)` | 函数 | 若 AbortSignal 已触发中止，立即抛出标准 `AbortError` |

### 2. 跨扩展服务注册中心 (Service Registry)

支持扩展间 1:1 独占能力的解耦协作。以 `ExtensionAPI` 隔离，首次提供者生效（first-provider-wins），随 session 自动注销。

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `createServiceKey<T>(id)` | 函数 | 创建带泛型约束的稳定服务标识符（基于命名空间字符串） |
| `provideService(context, key, value)` | 函数 | 在当前运行时注册服务，生命周期结束自动注销；重复注册返回 `false` |
| `getService(pi, key)` | 函数 | 同步获取当前已注册的服务实例（未提供时返回 `undefined`） |
| `waitForService(pi, key, options?)` | 函数 | 异步等待服务就绪，支持传入 `AbortSignal`，配合非阻塞 continuation 避免死锁 |
| `MEMORY_COMPACTOR_SERVICE_KEY` | 常量 | 预置内存压缩服务 Key（例如 `pi-ext-addon` 在 409 恢复时调用 `pi-ext-memory` 的即时压缩） |
| `TASK_REGISTRY_SERVICE_KEY` | 常量 | 预置后台任务注册表 Key |

### 3. 统一后台任务状态机 (TaskRegistry)

集中管理后台 Bash 命令任务与 Subagent 会话任务的并发控制、状态机与结算。

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `TaskRegistry` | 类 | 任务注册中心，提供 ID 生成、入队排队、并发控制、取消与终态沉降（`settle`） |
| `isTerminalTaskStatus(status)` | 函数 | 判断状态是否为终态（`completed`, `failed`, `cancelled`, `stopped`） |
| `TASK_REGISTRY_SERVICE_KEY` | 常量 | 共享注册表服务 Key，支持多扩展跨包获取单一实例 |
| 异常与限制常量 | 常量 / 类 | `TaskCapacityError`, `TaskQueueFullError`, `DEFAULT_TASK_CONCURRENCY` 等 |

### 4. 后台交付与完成门控 (BackgroundDelivery)

为后台任务与异步报告提供与父会话忙闲状态协调的单次唤醒门控。

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `createBackgroundDelivery(pi)` | 函数 | 为当前运行时创建后台交付协调器 |
| `getBackgroundDelivery(pi)` | 函数 | 获取当前会话共享的 `BackgroundDelivery` 实例 |
| `BackgroundWorkSource` | 接口 | 活动任务计数抽象（只要有任务活跃，父会话空闲时不提前唤醒） |
| `BackgroundDeliveryChannel` | 接口 | 交付通道（支持紧急报告如 `blocked` 立即唤醒，普通报告等待全部完成后统一唤醒） |

### 5. 扩展点与动态钩子 (Extension Points)

支持 1:N 的松耦合事件与能力挂载机制。

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `createExtensionPointKey(id)` | 函数 | 创建带上下文与钩子类型的扩展点标识符 |
| `registerExtensionHook(context, key, hook)` | 函数 | 向指定扩展点注册动态钩子，生命周期结束自动解绑 |
| `openExtensionPoint(pi, key, options?)` | 函数 | 开放扩展点并执行挂载的钩子集，支持动态订阅与取消信号 |

### 6. 工具托管与装配清单 (Managed Tools & Loadout)

管理非原生工具的可见性、按需激活策略与统一资源元数据。

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `setSessionToolsActive(context, names, active)` | 函数 | 批量变更当前会话工具的激活集合，并在退出时自动清理 |
| `registerLoadoutResource(pi, resource)` | 函数 | 注册技能、扩展或自定义资源到装配清单 |
| `observeLoadoutInventory(pi, observer)` | 函数 | 监听装配清单变化事件 |

### 7. TUI 视图路由与自定义界面 (Page Router & Surfaces)

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `openExtensionPageRouter(ctx, options)` | 函数 | 打开全局扩展设置多页面路由界面（由 `pi-settings` 承载） |
| `registerExtensionPage(registration)` | 函数 | 注册自定义扩展设置页面 |
| `openTuiSurface(ctx, options)` | 函数 | 打开全屏独立 TUI Surface，支持排队、焦点管理与安全退出 |
| `TuiSurfaceQueueFullError` | 错误类 | 排队超出最大并发上限时抛出 |

### 8. 挂件与编辑器底栏状态 (Widgets & Editor Status)

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `registerWidget(pi, placement, widget)` | 函数 | 在编辑器上方（above-editor）或下方挂载状态挂件 |
| `suspendWidgets(pi)` | 函数 | 临时挂起所有活动挂件（在全屏 Surface 打开时避免遮挡） |
| `EditorWorkingStatusIndicator` | 类 | 编辑器工作状态组件，支持点阵旋转动画与文案展示 |
| `registerActiveEditor(editor)` / `unregisterActiveEditor` | 函数 | 注册当前活动编辑器实例 |
| `setPreTurnWorkingStatus(options)` | 函数 | 设置回合前即时工作状态 |
| `BRAILLE_SPINNER_FRAMES` | 常量 | 标准点阵微旋转动画帧序列 |

### 9. JSON 配置持久化与存储 (JSON Settings Transport)

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `readJsonSettingsRoot(path)` | 函数 | 读取 JSON 配置文件根对象 |
| `updateJsonSettingsRoot(path, updater)` | 函数 | 原子读取、修改并写回 JSON 配置根对象 |
| `readJsonSettingsSection(path, sectionKey)` | 函数 | 读取指定 section 配置 |
| `readMergedJsonSettingsSection(paths, sectionKey)` | 函数 | 合并全局与项目两层配置，标注来源（global/project/mixed） |
| `defaultExtensionSettingsPaths(env?, cwd?)` | 函数 | 获取默认全局与项目 `ext_settings.json` 路径 |
| `createJsonSettingsStorage(options)` | 函数 | 创建轻量强类型配置存储适配器 |
| `registerSettings(pi, provider)` / `getRuntimeSettingsRegistry` | 函数 | 注册扩展配置 Provider 与查询全局配置表 |

### 10. 模型选择与思考深度 (Model Selection & Thinking)

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `modelSelectionOptions(models)` | 函数 | 将可用模型清单转换为 TUI 下拉选择项 |
| `authenticatedModelSelectionOptions(models, authRegistry)` | 函数 | 过滤出具备可用鉴权凭据的模型选项 |
| `createModelSelectionField(options)` | 函数 | 创建支持快捷键、搜索与高亮渲染的模型选择表单项 |
| `clampThinkingLevel(level)` | 函数 | 规范收敛思考级别（off, minimal, low, medium, high, max） |
| `thinkingGlyph(level)` | 函数 | 获取对应思考级别的专用 ASCII/Unicode 指示符号 |

### 11. 上下文用量与 Token 估算 (Context Usage & Token Estimation)

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `resolvePiContextUsage(reading, options)` | 函数 | 解析 Pi 原生 context usage，在会话首回合结合前缀估算准确用量 |
| `estimatePiPrefixTokens(systemPrompt, tools)` | 函数 | 估算系统提示词与工具清单的前缀 token 开销 |
| `estimatePiToolDefinitionTokens(tools)` | 函数 | 估算工具定义结构占用的 token 数量 |
| `estimateTextTokens(text)` | 函数 | 快速估算文本 token 数量（缺省为 chars/4） |

### 12. 进程内子代理协调器 (Subagent Coordinator)

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `startSubagent(spec)` | 函数 | 启动进程内轻量子代理（支持 `completion`, `task`, `conversation` 模式） |
| `lookupSubagent(pi, id)` | 函数 | 查询当前会话中活跃的子代理句柄 |
| `redeliverTask(pi, options)` | 函数 | 重新交付尚未确认的子代理任务结果 |
| `configureSubagentCoordinator(pi, options)` | 函数 | 配置会话级并发上限与配额预算 |
| `ensureSubagentCoordinator(pi)` | 函数 | 初始化或获取会话级子代理协调器 |

### 13. 工具 TUI 交互与渲染 (Tool TUI)

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `createToolTui()` | 函数 | 创建统一工具 TUI 渲染实例，支持本地工具 `frame()` 包装与宿主 MCP `renderers()` 接入 |
| `getToolTui(pi)` | 函数 | 获取会话共享的工具 TUI 实例 |
| `registerToolTuiTrace(pi)` | 函数 | 注册工具输出追踪条目与宿主工具生命周期监听（支持 MCP 工具时长与终态追踪） |
| `isTuiScrolledUp(tui)` | 函数 | 判定 TUI 是否正处于向上翻页滚动状态，防止自动输出刷屏 |
| `ToolRendererDefinition` | 接口 | 纯渲染器工具定义接口（`name`, `label?`, `renderCall?`, `renderResult?`） |

### 14. 响应遥测与底栏边框 (Response Telemetry & Editor Rail)

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `createResponseStatusFeature(pi, options)` | 函数 | 创建模型推理性能（生成速率、耗时、token）遥测展示组件 |
| `formatTelemetryStatus(metrics)` | 函数 | 格式化遥测性能状态条文本 |
| `renderBottomRailBorder(options)` | 函数 | 在编辑器底栏渲染对齐的边框线与状态信息 |
| `wrapEditorBottomRail(editor, renderRail)` | 函数 | 装饰编辑器底栏渲染逻辑，嵌入自定义状态条 |

### 15. 通用辅助函数 (Utilities)

| API | 类型 | 核心契约与说明 |
| --- | --- | --- |
| `runCommand(command, args, options?)` | 函数 | 一次性安全执行外部命令（支持超时、输出上限与取消信号） |
| `shellQuote(str)` | 函数 | POSIX shell 参数安全转义 |
| `isSubagentProcess(env?)` | 函数 | 检测当前进程是否运行在子 Agent 环境中 |
| `expandHome(filepath, env?)` | 函数 | 展开路径中的 `~` 符号 |
| `splitSubcommand(text)` | 函数 | 解析斜杠命令首个子命令与后续参数 |
| `subcommandCompletions(subcommands, options?)` | 函数 | 为斜杠命令提供规范的双层子命令与参数自动补全 |
| `fitRow(text, width)` | 函数 | 将 ANSI 彩色单行文本安全截断或补充至指定单元格宽度 |
| `isRecord(value)` | 函数 | 严格类型守卫：判定值是否为非数组、非 null 的 Plain Object |
| `escapeXml(str)` | 函数 | 转义 XML 关键字符（`&<>"'`） |
| `isSkillEnabled(pi, name)` 等 | 函数 | 查询与管理当前会话技能启用/禁用状态 |
| `textToolResult(text, isError?)` | 函数 | 构造标准文本型工具执行结果对象 |
| `agentResultText(result)` | 函数 | 从工具执行结果中提取主要文本内容 |
| `formatDuration(ms)` | 函数 | 规范化耗时格式化（毫秒或带小数点的秒） |

---

## 边界与设计约定

- 根入口 `@hheei/pi-ext-core` 是唯一公共导入面；具体扩展禁止 deep import `src/` 内部模块。
- 本包不承载具体业务功能状态、私有 schema、命令策略或具体 UI 内容。
- 更多设计原则见 [pi-ext-core 开发约定](../../docs/development/pi-ext-core.md) 与 [pi-ext-core 架构提案](../../docs/architecture/pi-ext-core.md)。
