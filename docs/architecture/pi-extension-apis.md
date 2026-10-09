# Pi 原生 SDK (`@earendil-works/pi-coding-agent`) 核心接口与生命周期规范参考 (API Reference)

本文档基于 `@earendil-works/pi-coding-agent@1.0.2` 的源码、类型声明（`dist/core/extensions/types.d.ts`、`dist/core/session-manager.d.ts`、`dist/core/agent-session.d.ts` 等）及官方文档整理，完整覆盖 `ExtensionAPI`、`ExtensionContext` 体系、`SessionManager`、`AgentSession`、工具定义与核心事件生命周期。

---

## 一、Extension 入口与工厂契约

每个 Pi Extension 都是一个默认导出工厂函数（`ExtensionFactory`）的模块，或作为 `InlineExtension` 传入 SDK：

```ts
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export type InlineExtension = ExtensionFactory | {
  name: string;
  factory: ExtensionFactory;
  hidden?: boolean;
  replaceable?: boolean;
  builtin?: boolean;
};
```

- **生命周期约束**：
  - 工厂函数支持同步或异步（Pi 启动时会等待 `async` 工厂完成，可用于预取配置或注册 Provider）。
  - **禁止**在工厂函数内直接启动子进程、Socket、文件监听器或定时器（部分 CLI 调用如 `pi config` 会加载扩展但不启动会话）。
  - 长期运行的资源应在 `session_start` 事件或按需在命令/工具执行时初始化，并在 `session_shutdown` 中进行**幂等**清理。

---

## 二、`ExtensionAPI` 接口参考

`ExtensionAPI` 是传递给扩展工厂函数 `export default function(pi: ExtensionAPI)` 的核心对象，用于注册能力、订阅生命周期事件及操作当前会话。

### 1. 事件与扩展间通信

#### `pi.on(event, handler)`
- **签名**：
  ```ts
  on<E extends ExtensionEvent["type"]>(
    event: E,
    handler: ExtensionHandler<Extract<ExtensionEvent, { type: E }>, EventResultFor<E>>
  ): () => void;
  ```
- **作用**：订阅 Pi 生命周期事件，可拦截、修改或取消特定运行时行为。
- **参数**：
  - `event`: 事件名称字符串（如 `"session_start"`, `"before_agent_start"`, `"tool_call"`, `"tool_result"`, `"turn_end"` 等，详见第四节）。
  - `handler`: `(event, ctx: ExtensionContext) => Promise<R | void> | R | void`。注意 `project_trust` 事件的上下文为受限的 `ProjectTrustContext`。
- **返回值**：`() => void` 取消订阅函数。取消订阅不会影响已经在派发中的事件流。
- **使用场景与注意事项**：
  - 处理器按照扩展加载顺序与注册顺序依次执行。
  - 不同事件对返回值的处理策略不同（链式传递、短路拦截、原地修改或最后一个生效），详见第四节事件生命周期。

#### `pi.events` (`EventBus`)
- **类型**：
  ```ts
  interface EventBus {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  }
  ```
- **作用**：进程内跨 Extension 通信的共享事件总线。
- **参数与返回值**：
  - `emit(channel, data)`：向指定频道广播数据，无返回值。
  - `on(channel, handler)`：监听指定频道，返回取消监听函数 `() => void`。通过 `ExtensionAPI` 注册的监听会在 runtime 失效（如 reload）时被自动追踪并清理。
- **注意事项**：仅用于通知，不应作为可变共享状态或紧耦合 RPC 替代品。

---

### 2. 工具注册与激活管理

#### `pi.registerTool(tool)`
- **签名**：
  ```ts
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
    tool: ToolDefinition<TParams, TDetails, TState>
  ): void;
  ```
- **作用**：注册一个可供 LLM 或其他工具（如 `codemode`）调用的工具。若独立定义工具对象，可使用辅助函数 `defineTool(tool)` 保留 TypeBox 泛型参数推导。
- **参数（`ToolDefinition` 核心字段）**：
  - `name: string`：工具唯一标识名称（LLM 调用名）。
  - `label: string`：UI 显示的可读标签。
  - `description: string`：提供给 LLM 的工具描述。
  - `parameters: TParams`：TypeBox Schema（定义输入参数结构）。
  - `outputSchema?: TSchema`：成功结果中 `structuredContent` 的 JSON Schema。声明后，工具应始终返回 `structuredContent`；`codemode` 脚本将直接收到该结构化对象而非文本 `content`。
  - `exposure?: ToolExposure`：控制模型和嵌套调用如何访问该工具（默认 `"direct"`）：
    - `"direct"`：激活时向模型声明，且在激活时可被 `ctx.executeTool()` 调用（注册时默认激活）。
    - `"model-only"`：激活时向模型声明，但**绝不可**被其他工具通过 `ctx.executeTool()` 嵌套调用（适用于编排工具或交互式提问工具，注册时默认激活）。
    - `"codemode"`：只要注册即可被 `ctx.executeTool()` 调用，并在 `codemode` 描述中列出；除非显式激活，否则不直接向模型声明。
    - `"deferred"`：与 `"codemode"` 类似可被嵌套调用，但不在 `codemode` 描述中列出，可通过 `tool_search` 检索并激活。
    - `"hidden"`：已注册但不可达，激活也无效。可用于重新注册同名工具以撤回（隐藏）该工具。
  - `defaultActive?: boolean`：注册时是否默认激活（仅对 `direct` 和 `model-only` 有效，默认 `true`）。
  - `namespace?: ToolNamespace`：`{ name: string; description?: string; instructions?: string }`，用于将相关工具分组（如 `mcp__server`）。
  - `annotations?: ToolAnnotations`：符合 MCP 语义的行为提示 `{ readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }`，供权限扩展判断。
  - `executionMode?: "sequential" | "parallel"`：覆盖工具并发策略。共享内存状态的工具应设为 `"sequential"`；修改文件的工具应使用 `withFileMutationQueue()`。
  - `prepareArguments?: (args: unknown) => Static<TParams>`：在 Schema 验证前对原始参数做兼容转换。
  - `prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined`：当该工具处于激活状态且活跃工具集变化时调用，可动态覆写其他已声明工具的 `descriptions` 或将部分工具放入 `hiddenDeclarations`（隐藏模型声明但保持激活与可调用，如 `codemode` 所示）。
  - `constrainedSampling?: false | ConstrainedSamplingConfig`：Provider 侧受限采样配置。
  - `renderShell?: "default" | "self"`：控制 `ToolExecutionComponent` 是渲染默认的彩色边框外壳（`"default"`）还是由工具完全自定义外框（`"self"`）。
  - `execute(toolCallId, params, signal, onUpdate, ctx: ExtensionToolContext): Promise<AgentToolResult<TDetails>>`：
    - 返回 `{ content: (TextContent | ImageContent)[], details: TDetails, structuredContent?: JsonValue, isError?: boolean, usage?: Usage, terminate?: boolean }`。
    - 抛出异常会使工具结果变为 `isError: true`。若希望报错同时向脚本保留 `structuredContent`，应正常返回对象并设 `isError: true`。
    - 若一个工具批次中所有完成的工具均返回 `terminate: true`，Agent 会在当前工具批次结束后提前终止本轮循环。
  - `renderCall?: (args, theme, context: ToolRenderContext) => Component`：自定义工具调用行 TUI 渲染。
  - `renderResult?: (result, options: ToolRenderResultOptions, theme, context: ToolRenderContext) => Component`：自定义工具结果 TUI 渲染。

#### `pi.registerToolRenderer(resolver)`
- **签名**：
  ```ts
  type ToolRenderers = Pick<ToolDefinition<any, any, any>, "renderShell" | "renderCall" | "renderResult">;
  type ToolRendererResolver = (toolName: string, next: () => ToolRenderers | undefined) => ToolRenderers | undefined;

  registerToolRenderer(resolver: ToolRendererResolver): void;
  ```
- **作用**：拦截或补充任意工具（包括未注册工具，如恢复会话时还未连接上的 MCP 工具）的调用与结果渲染器。
- **参数**：`resolver(toolName, next)`，调用 `next()` 会按扩展加载顺序继续询问后续 resolver 及工具自身的渲染器。使用 `next() ?? myRenderer` 可实现回退兜底渲染。

#### `pi.getActiveTools()` / `pi.setActiveTools(toolNames)` / `pi.getAllTools()`
- **签名**：
  ```ts
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  getAllTools(): ToolInfo[];
  ```
- **作用**：
  - `getActiveTools()`：获取当前向模型声明的活跃工具名称列表。
  - `setActiveTools(toolNames)`：动态设置活跃工具集。未知名称或 `hidden` 工具会被忽略；`codemode` 和 `deferred` 工具无论是否激活都可从脚本中调用。
  - `getAllTools()`：获取所有已配置工具的元数据（`name`, `description`, `parameters`, `promptGuidelines`, `exposure`, `namespace`, `annotations`, `sourceInfo`）。
- **注意事项**：切换活跃工具会在下一轮模型请求前向 transcript 追加工具变更；对于不支持增量工具变更的 Provider，可能触发完整 transcript 检查点并导致 Prompt Cache 失效。

---

### 3. 命令、快捷键与 CLI Flag 注册

#### `pi.registerCommand(name, options)`
- **签名**：
  ```ts
  registerCommand(name: string, options: {
    description?: string;
    getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  }): void;
  ```
- **作用**：注册用户可通过 `/name` 触发的斜杠命令。
- **参数**：
  - `name`：命令名（不含 `/`）。
  - `options.description`：命令列表与补全菜单中显示的说明。
  - `options.getArgumentCompletions`：可选的命令参数自动补全回调。
  - `options.handler(args, ctx)`：命令执行逻辑。接收 `ExtensionCommandContext`（比普通事件上下文多出会话切换、分叉、树导航、重载等控制方法）。
- **注意事项**：即使在 Agent 流式生成期间，用户输入的扩展命令也会立即派发执行。

#### `pi.getCommands()`
- **签名**：`getCommands(): SlashCommandInfo[]`
- **作用**：获取当前会话中所有可用的斜杠命令（来源包括 `"extension" | "prompt" | "skill"`）。

#### `pi.registerShortcut(shortcut, options)`
- **签名**：
  ```ts
  registerShortcut(shortcut: KeyId, options: {
    description?: string;
    handler: (ctx: ExtensionContext) => Promise<void> | void;
  }): void;
  ```
- **作用**：在交互式 TUI 模式下注册全局键盘快捷键。

#### `pi.registerFlag(name, options)` & `pi.getFlag(name)`
- **签名**：
  ```ts
  registerFlag(name: string, options:
    | { description?: string; type: "boolean"; default?: boolean }
    | { description?: string; type: "string"; default?: string }
  ): void;
  getFlag(name: string): boolean | string | undefined;
  ```
- **作用**：注册自定义 CLI 启动参数（如 `--my-flag`），并在运行时通过 `getFlag(name)` 读取解析后的值（未传入时返回 `default`）。

---

### 4. 消息发送、状态持久化与渲染注册

#### `pi.sendMessage(message, options?)`
- **签名**：
  ```ts
  sendMessage<T = unknown>(
    message: {
      customType: string;
      content: string | (TextContent | ImageContent)[];
      display: boolean;
      details?: T;
    },
    options?: {
      triggerTurn?: boolean;
      deliverAs?: "steer" | "followUp" | "nextTurn";
    }
  ): void;
  ```
- **作用**：向会话发送一条参与 LLM 上下文的自定义消息（`CustomMessageEntry`，构建上下文时会转换为 user 角色消息传给模型）。
- **参数**：
  - `message.customType`：扩展自定义类型标识，用于重连时过滤或绑定自定义渲染器。
  - `message.content`：发送给 LLM 的文本或图文内容。
  - `message.display`：`true` 时在 TUI 中以特殊样式渲染；`false` 时在 TUI 中隐藏（仅作为上下文注入给模型）。
  - `message.details`：扩展私有元数据，保存在会话文件中供 UI 渲染或状态恢复使用，**不会**发送给 LLM。
  - `options.triggerTurn`：空闲时是否立即触发一轮模型回复。
  - `options.deliverAs`：控制投递时机：`"steer"`（打断当前流并注入）、`"followUp"`（当前流结束后继续）、`"nextTurn"`（挂起，随下一次用户输入一起作为上下文发送）。

#### `pi.sendUserMessage(content, options?)`
- **签名**：
  ```ts
  sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: {
      deliverAs?: "steer" | "followUp";
      expandPromptTemplates?: boolean;
    }
  ): void;
  ```
- **作用**：以真实用户身份发送消息，**总是**会触发一轮 Agent 运行。若当前正在流式输出，通过 `deliverAs` 指定作为 `"steer"` 或 `"followUp"` 排队；`expandPromptTemplates: true` 时会派发扩展命令并展开技能与提示模板。

#### `pi.appendEntry(customType, data?)`
- **签名**：`appendEntry<T = unknown>(customType: string, data?: T): void`
- **作用**：向会话树当前叶子节点追加一条 `CustomEntry`（`type: "custom"`）。
- **使用场景与注意事项**：
  - **不参与** LLM 上下文（`buildSessionContext` 会忽略它）。
  - 专用于持久化跟随会话分支的扩展内部状态。在 `session_start` 时，应通过 `ctx.sessionManager.getBranch()`（而非 `getEntries()`）扫描 `customType` 来重建当前分支的状态。

#### `pi.registerMessageRenderer(customType, renderer)`
- **签名**：
  ```ts
  type MessageRenderer<T = unknown> = (
    message: CustomMessage<T>,
    options: { expanded: boolean; outputPad: number },
    theme: Theme
  ) => Component | undefined;

  registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
  ```
- **作用**：为 `display: true` 的 `CustomMessageEntry`（通过 `sendMessage` 发送）注册自定义 TUI 组件渲染器。

#### `pi.registerEntryRenderer(customType, renderer)`
- **签名**：
  ```ts
  type EntryRenderer<T = unknown> = (
    entry: CustomEntry<T>,
    options: { expanded: boolean },
    theme: Theme
  ) => Component | undefined;

  registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;
  ```
- **作用**：为 `CustomEntry`（通过 `appendEntry` 写入的非上下文条目）注册 TUI 聊天记录渲染器。

#### `pi.registerMarkdownTransformer(transformer)`
- **签名**：
  ```ts
  type MarkdownTransformer = (
    markdown: string,
    context: {
      messageType: "user" | "assistant" | "assistant-thinking";
      isStreaming: boolean;
      availableWidth: number;
    }
  ) => string;

  registerMarkdownTransformer(transformer: MarkdownTransformer): void;
  ```
- **作用**：在交互式 TUI 渲染用户消息、助手回复或思考块之前，对 Markdown 文本进行预处理转换。

---

### 5. 会话元数据、模型与设置控制

#### `pi.setSessionName(name)` / `pi.getSessionName()`
- **签名**：`setSessionName(name: string): void` / `getSessionName(): string | undefined`
- **作用**：设置或读取当前会话的显示名称（写入 `session_info` 条目，并触发 `session_info_changed` 事件，展示在会话选择器中）。

#### `pi.setLabel(entryId, label)`
- **签名**：`setLabel(entryId: string, label: string | undefined): void`
- **作用**：在指定的会话条目上设置或清除书签标签（`label` 为 `undefined` 时清除），便于在 `/tree` 视图中标记和导航。

#### `pi.setModel(model)`
- **签名**：`setModel(model: Model<any>): Promise<boolean>`
- **作用**：切换当前会话使用的模型（不会修改新会话的全局默认设置）。若该模型的 Provider 未配置有效认证，返回 `false`。

#### `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)`
- **签名**：`getThinkingLevel(): ThinkingLevel` / `setThinkingLevel(level: ThinkingLevel): void`
- **作用**：获取或设置当前会话的思考深度（`"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`，会自动按当前模型能力截断）。

#### `pi.getSettings()`
- **签名**：`getSettings(): Settings`
- **作用**：获取当前合并后的有效设置（全局设置、项目设置与运行时覆盖合并后的深拷贝）。

#### `pi.exec(command, args, options?)`
- **签名**：
  ```ts
  exec(command: string, args: string[], options?: {
    signal?: AbortSignal;
    timeout?: number;
    cwd?: string;
  }): Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>;
  ```
- **作用**：直接派生子进程执行外部命令（不经过 Shell 解析参数，支持 `AbortSignal` 与超时控制）。

---

### 6. Provider、虚拟模型与 MCP Server 注册

#### `pi.registerProvider(...)` & `pi.unregisterProvider(name)`
- **签名**：
  ```ts
  registerProvider(provider: Provider): void;
  registerProvider(name: string, config: ProviderConfig): void;
  unregisterProvider(name: string): void;
  ```
- **作用**：注册、覆盖或卸载模型提供商（支持 Chat、Image、Classifier 模型、自定义 `streamSimple` 适配器、动态 `refreshModels` 以及 `/login` OAuth 流程）。
- **注意事项**：在扩展初始加载阶段调用会进入队列并在 Runner 绑定时生效；绑定后（如在命令或事件中调用）会**立即生效**，无需 `/reload`。

#### `pi.registerVirtualModel(model)` & `pi.unregisterVirtualModel(provider, id)`
- **签名**：
  ```ts
  registerVirtualModel<TState = unknown>(model: ExtensionVirtualModel<TState>): void;
  unregisterVirtualModel(provider: string, id: string): void;
  ```
- **作用**：注册或移除一个“虚拟模型”（出现在模型目录中供用户选择，但在每次请求前通过 `route(request, ctx)` 动态路由到具体的物理模型与思考等级）。
- **路由参数 `ModelRouteRequest<TState>`**：
  - `model`, `thinkingLevel`：当前选中的虚拟模型与虚拟思考等级。
  - `reason`：`"user"`（用户新消息的首个请求）、`"continuation"`（工具结果或扩展消息后的继续请求）、`"retry"`（失败或溢出压缩后的自动重试）、`"direct"`（Agent 循环外的直接调用，如压缩摘要或扩展调用 `streamSimple`）。
  - `previous`：当前上下文中最后一次成功响应所使用的物理模型与思考等级。
  - `failed`：`reason === "retry"` 时提供刚才失败请求的物理模型、思考等级及含 `errorMessage` 的 `AssistantMessage`。
  - `state`：保存在当前会话分支上的路由器状态（返回新的 JSON 可序列化 `state` 对象会自动持久化到分支的 `pi.virtual-model-state` 条目；返回 `undefined` 或原 `request.state` 引用则不写入新条目）。

#### `pi.registerMcpServer(name, config)` / `pi.unregisterMcpServer(name)` / `pi.getMcpServers()`
- **签名**：
  ```ts
  registerMcpServer(name: string, config: McpServerConfig): void;
  unregisterMcpServer(name: string): void;
  getMcpServers(): RegisteredMcpServer[];
  ```
- **作用**：
  - `registerMcpServer`：为当前会话动态注册一个 stdio 或 HTTP MCP Server（配置结构与 `mcp.json` 一致，支持 `exposure: "codemode" | "deferred" | "direct" | "hidden"` 及 `toolExposure` 通配符覆写）。
  - `unregisterMcpServer`：移除本扩展注册的 MCP Server 并关闭连接。
  - `getMcpServers`：获取所有由扩展注册的 MCP Server 列表（供负责连接 MCP 的扩展使用）。
- **注意事项**：
  - 初始加载时注册的 Server 会在 `session_start` 时连接；运行时注册的会立即触发 `mcp_servers_change` 并连接。
  - 注册信息不落盘；`mcp.json` 中同名配置优先级更高；若与其他扩展注册的名称冲突或配置无效会抛出异常。

---

## 三、`ExtensionContext` 及其派生上下文参考

Pi 根据调用场景提供不同权限级别的 Context：
1. **`ExtensionContext`**：所有生命周期事件处理器的标准上下文。
2. **`ExtensionToolContext`**：继承自 `ExtensionContext`，传给工具的 `execute()`，额外提供受控的嵌套工具调用能力。
3. **`ExtensionCommandContext`**：继承自 `ExtensionContext`，传给斜杠命令 `handler()`，额外提供会话树导航、分叉、新建/切换会话与重载能力。
4. **`ReplacedSessionContext`**：继承自 `ExtensionCommandContext`，在 `newSession` / `fork` / `switchSession` 的 `withSession` 回调中提供，绑定到新会话并支持直接发送消息。

### 1. `ExtensionContext` 属性与方法

| 属性 / 方法 | 类型 / 签名 | 说明与注意事项 |
|---|---|---|
| `ui` | `ExtensionUIContext` | 交互式 UI 操作接口（对话框、通知、状态栏、Widget、自定义组件等，详见下表）。 |
| `mode` | `"tui" | "rpc" | "json" | "print"` | 当前运行模式。仅终端支持的自定义组件需用 `ctx.mode === "tui"` 守卫。 |
| `hasUI` | `boolean` | 是否支持对话框交互（在 `"tui"` 和 `"rpc"` 模式下为 `true`，`"json"` 和 `"print"` 下为 `false`）。 |
| `cwd` | `string` | 当前会话的工作目录。 |
| `sessionManager` | `ReadonlySessionManager` | 只读的会话管理器视图（可读取分支、树、条目、投影，不可直接 append，详见第五节）。 |
| `modelRegistry` | `ModelRegistry` | 模型注册表与运行时门面，可用于查询模型、解析凭证或发起嵌套调用（如 `ctx.modelRegistry.streamSimple()`、`classify()`、`generateImages()`）。 |
| `model` | `Model<any> | undefined` | 当前选中的模型（若选中虚拟模型，此处为虚拟模型的 Model 对象）。 |
| `scopedModels` | `readonly ScopedModel[]` | 当前会话限定的模型范围快照（来自 `--models` 或 `enabledModels` 设置）。 |
| `thinkingLevel` | `ThinkingLevel | undefined` | 当前选中的思考等级。 |
| `signal` | `AbortSignal | undefined` | 当前 Agent 流式运行的中止信号（空闲时为 `undefined`）。工具或事件中派生的异步任务应绑定此信号。 |
| `isIdle()` | `() => boolean` | 当前 Agent 是否处于空闲状态（未在流式输出）。 |
| `isProjectTrusted()` | `() => boolean` | 当前项目目录是否已通过项目信任检查。 |
| `abort()` | `() => void` | 立即中止当前正在进行的 Agent 操作。 |
| `hasPendingMessages()` | `() => boolean` | 是否存在排队等待投递的消息（steering 或 followUp）。 |
| `shutdown()` | `() => void` | 请求优雅关闭 Pi 并退出进程。 |
| `getContextUsage()` | `() => ContextUsage | undefined` | 获取当前模型的上下文使用量：`{ tokens: number | null, contextWindow: number, percent: number | null }`（刚完成压缩尚未收到下次回复时 `tokens` 为 `null`）。 |
| `compact(options?)` | `(options?: CompactOptions) => void` | 异步触发一次上下文压缩（不阻塞等待，可通过 `options.customInstructions`、`onComplete`、`onError` 监听结果）。 |
| `getSystemPrompt()` | `() => string` | 获取当前生效的完整系统提示词文本。 |

---

### 2. `ExtensionUIContext` (`ctx.ui`) 详细方法

- **基础交互对话框（在 `ctx.hasUI === true` 即 TUI 与 RPC 模式下可用）**：
  - `select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>`：弹出列表选择器，取消或超时返回 `undefined`。`opts` 支持 `{ signal?: AbortSignal, timeout?: number }`。
  - `confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>`：弹出确认框。
  - `input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>`：弹出单行文本输入框。
  - `editor(title: string, prefill?: string): Promise<string | undefined>`：弹出多行文本编辑器。
  - `notify(message: string, type?: "info" | "warning" | "error"): void`：显示非阻塞通知。
- **状态栏、工作指示器与窗口标题**：
  - `setStatus(key: string, text: string | undefined): void`：在底部状态栏设置或清除（传 `undefined`）扩展状态文本。
  - `setWorkingMessage(message?: string): void`：设置流式生成时的加载提示语（不传参恢复默认）。
  - `setWorkingVisible(visible: boolean): void`：显示或隐藏内置的流式加载行。
  - `setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void`：自定义流式加载动画帧（传 `frames: []` 隐藏图标，不传参恢复默认）。
  - `setHiddenThinkingLabel(label?: string): void`：设置折叠思考块的显示标签。
  - `setTitle(title: string): void`：设置终端窗口/标签页标题。
- **TUI 挂载点与自定义组件（主要针对 `ctx.mode === "tui"`）**：
  - `setWidget(key: string, content: string[] | ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void`：在输入框上方（默认）或下方挂载常驻 Widget，传 `undefined` 移除。
  - `setFooter(factory: ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void }) | undefined): void`：替换底部状态栏组件（可通过 `footerData.getGitBranch()`、`getExtensionStatuses()`、`onBranchChange()` 获取状态）。
  - `setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void`：替换聊天区顶部的启动 Header 组件。
  - `custom<T>(factory: (tui, theme, keybindings, done: (result: T) => void) => Component | Promise<Component>, options?: { overlay?: boolean; overlayOptions?: OverlayOptions | (() => OverlayOptions); onHandle?: (handle: OverlayHandle) => void }): Promise<T>`：挂载接管键盘焦点的自定义交互组件（或浮动 Overlay），调用 `done(result)` 时卸载并 resolve。
- **编辑器与主题控制**：
  - `pasteToEditor(text: string): void` / `setEditorText(text: string): void` / `getEditorText(): string`：操作底部主输入框文本。
  - `addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider): void`：在内置自动补全器之上包装叠加自定义补全逻辑。
  - `setEditorComponent(factory: EditorFactory | undefined): void` / `getEditorComponent()`：替换主编辑器组件（可继承导出类 `CustomEditor` 以保留应用快捷键）。
  - `theme: Theme` / `getAllThemes()` / `getTheme(name)` / `setTheme(theme)`：读取或切换当前 TUI 主题。
  - `getToolsExpanded(): boolean` / `setToolsExpanded(expanded: boolean): void`：获取或设置工具输出结果的全局展开/折叠状态。
  - `onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void`：监听底层原始终端输入流，可消费拦截或改写输入字节。

---

### 3. `ExtensionToolContext`（工具执行上下文）

在 `ToolDefinition.execute(..., ctx)` 中传入，继承 `ExtensionContext` 并新增：

- `readonly tools: readonly AgentTool[]`：当前可通过 `executeTool()` 调用的所有工具列表。
- `executeTool(name: string, args: unknown, options?: { signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback }): Promise<AgentToolCallOutcome>`：
  - **作用**：在工具内部嵌套调用另一个工具（如 `codemode` 沙箱执行脚本调用其他工具）。
  - **契约与不变量**：
    1. 经过与模型调用完全相同的参数校验、`tool_call` 拦截、`tool_result` 处理与 `tool_execution_*` 事件广播。
    2. 分配调用 ID 为 `<callingId>/<n>`，所有相关事件均携带 `parentToolCallId`。
    3. **不写入会话历史记录（transcript）**，僅在父工具结果消息上保留有界摘要记录 `nestedCalls`（最多 256 条，单次参数超 8KiB 或总计超 32KiB 会省略参数并标记 `complete: false`，供压缩提取文件列表和 HTML 导出使用）。
    4. 子工具产生的 `usage` 会自动累加到父工具结果中。
    5. **永不 reject**：未知工具、校验失败、被 `tool_call` 拦截或执行抛出异常，均以 `{ isError: true, ... }` 形式返回。

---

### 4. `ExtensionCommandContext`（斜杠命令上下文）

在 `pi.registerCommand` 的 `handler(args, ctx)` 中传入，继承 `ExtensionContext` 并新增仅在用户发起命令时安全调用的会话控制方法（在普通生命周期事件中调用这些方法可能导致死锁，因此被严格隔离在 CommandContext 中）：

- `getSystemPromptOptions(): BuildSystemPromptOptions`：获取当前构建系统提示词的基础配置项。
- `waitForIdle(): Promise<void>`：等待当前 Agent 流式运行完全结束。
- `newSession(options?: { parentSession?: string; setup?: (sessionManager: SessionManager) => Promise<void>; withSession?: (ctx: ReplacedSessionContext) => Promise<void> }): Promise<{ cancelled: boolean }>`：创建并切换到新会话。
- `fork(entryId: string, options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> }): Promise<{ cancelled: boolean }>`：从指定条目处分叉并创建新的会话文件（`"before"` 表示分叉点不含该条目，`"at"` 表示包含该条目）。
- `navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ cancelled: boolean }>`：在同一会话文件内移动当前分支叶子指针（可选对被放弃的分支生成摘要 `BranchSummaryEntry`）。
- `switchSession(sessionPath: string, options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> }): Promise<{ cancelled: boolean }>`：切换到另一个现有的会话文件。
- `reload(): Promise<void>`：重新加载所有扩展、技能、提示模板、主题和上下文文件。**注意**：`await ctx.reload()` 之后旧的扩展运行时已失效，后续代码严禁继续复用旧 runtime 状态。

> **会话替换注意事项**：`newSession`、`fork` 和 `switchSession` 会使旧的 `ctx` 失效。若需在新会话建立后立即执行操作（如发送首条消息），请使用 `withSession: async (newCtx) => { await newCtx.sendUserMessage(...); }`。

---

## 四、核心事件生命周期与拦截契约

Pi 的事件按生命周期阶段可分为：**启动与资源发现**、**会话生命周期**、**输入与 Agent 循环**、**上下文与模型请求**、**工具调用生命周期**。

### 生命周期全景图

```
[进程启动]
  └─> project_trust (若项目含需信任资源，仅个人/CLI扩展可处理)
  └─> 加载项目级扩展
  └─> session_start (reason: "startup" | "reload" | "new" | "resume" | "fork")
  └─> resources_discover (扩展补充 skillPaths / promptPaths / themePaths)

[用户输入 / 触发运行]
  └─> input (可 continue / transform 改写文本图片 / handled 短路拦截)
  └─> before_agent_start (可修改 systemPromptOptions、强制替换 systemPrompt、注入 CustomMessage)
  └─> agent_start
       │
       ├──> [Turn 循环 (turnIndex = 0, 1, ...)]
       │     ├─> turn_start
       │     ├─> context (修改不含 system 的会话消息，Pi 随后自动恢复 prompt/tool 状态)
       │     ├─> context_with_system (修改含 system 在内的完整消息列表，返回值直接发送)
       │     ├─> before_provider_request (可检查或替换发往 Provider 的原始 payload)
       │     ├─> before_provider_headers (原地修改请求头 headers)
       │     ├─> after_provider_response (收到响应头、消费流之前触发)
       │     ├─> message_start (user / assistant)
       │     ├─> provider_stream_event (原始流事件，只读) & message_update (流式增量)
       │     ├─> message_end (可替换最终消息，需保持 role 一致)
       │     │
       │     ├─> [若 Assistant 发起了 Tool Calls (可并发执行)]
       │     │     ├─> tool_call (可原地修改 event.input，或返回 { block: true, reason, terminate })
       │     │     ├─> tool_execution_start
       │     │     ├─> tool_execution_update (流式部分结果)
       │     │     ├─> tool_result (链式修改 content / details / structuredContent / isError)
       │     │     ├─> tool_execution_end
       │     │     └─> message_start / message_end (role: "toolResult")
       │     │
       │     └─> turn_end [Actionable Boundary: 可追加自定义条目或设置 continue: true]
       │
       └──> agent_end (本轮 Agent 循环结束；但随后可能发生自动重试、溢出压缩或队列消息继续)
  └─> [若触发自动压缩: session_before_compact -> session_compact / session_compact_failed]
  └─> agent_before_settle [最终 Actionable Boundary: 可追加条目并请求最后一次 continuation]
  └─> agent_settled (完全静止通知：不会再有任何自动重试、压缩或排队继续)

[会话切换 / 退出]
  └─> session_before_switch / session_before_fork / session_before_tree (可返回 { cancel: true })
  └─> session_shutdown (reason: "quit" | "reload" | "new" | "resume" | "fork")
```

### 各事件详细契约表

#### 1. 启动、信任与会话事件

| 事件名 (`event.type`) | 事件负载 (`Event`) | 返回值契约 (`Result`) | 作用与注意事项 |
|---|---|---|---|
| `project_trust` | `{ cwd: string }` | `{ trusted: "yes" | "no" | "undecided", remember?: boolean }` | 在加载受控项目资源前触发。仅用户全局扩展与 CLI 显式指定的扩展可监听。 |
| `session_start` | `{ reason: "startup" | "reload" | "new" | "resume" | "fork", previousSessionFile?: string }` | `void` | 会话启动、切换或重载完成时触发。适合在此通过 `ctx.sessionManager.getBranch()` 恢复分支状态并初始化会话资源。 |
| `resources_discover` | `{ cwd: string, reason: "startup" | "reload" }` | `{ skillPaths?: string[], promptPaths?: string[], themePaths?: string[] }` | 在 `session_start` 后触发，允许扩展动态贡献额外的技能、提示模板或主题路径。 |
| `mcp_servers_change` | `{ servers: RegisteredMcpServer[] }` | `void` | 扩展在绑定后调用 `registerMcpServer` / `unregisterMcpServer` 时触发。监听此事件即声明该扩展负责管理扩展注册的 MCP Server。 |
| `session_info_changed` | `{ name: string | undefined }` | `void` | 会话名称被修改或清除时触发。 |
| `session_before_switch` | `{ reason: "new" | "resume", targetSessionFile?: string }` | `{ cancel?: boolean }` | 切换或新建会话前触发，返回 `{ cancel: true }` 可中止切换。 |
| `session_before_fork` | `{ entryId: string, position: "before" | "at" }` | `{ cancel?: boolean, skipConversationRestore?: boolean }` | 分叉会话前触发，可取消分叉或跳过对话恢复。 |
| `session_before_tree` | `{ preparation: TreePreparation, signal: AbortSignal }` | `{ cancel?: boolean, summary?: { summary: string, details?: unknown, usage?: Usage }, customInstructions?: string, replaceInstructions?: boolean, label?: string }` | `/tree` 导航前触发。可取消导航、覆写分支摘要指令，或由扩展自行提供生成的 `summary`。 |
| `session_tree` | `{ newLeafId: string | null, oldLeafId: string | null, summaryEntry?: BranchSummaryEntry, fromExtension?: boolean }` | `void` | 会话树叶子节点导航完成后触发。 |
| `session_before_compact` | `{ preparation: CompactionPreparation, branchEntries: SessionEntry[], customInstructions?: string, reason: "manual" | "threshold" | "overflow", willRetry: boolean, signal: AbortSignal }` | `{ cancel?: boolean, compaction?: CompactionResult }` | 上下文压缩前触发。可返回 `{ cancel: true }` 取消压缩，或由扩展自定义生成并返回 `compaction` 结果替代默认摘要。 |
| `session_compact` | `{ compactionEntry: CompactionEntry, fromExtension: boolean, reason: "manual" | "threshold" | "overflow", willRetry: boolean }` | `void` | 上下文压缩成功后触发。 |
| `session_compact_failed` | `{ reason: "manual" | "threshold" | "overflow", errorMessage?: string, aborted: boolean, willRetry: boolean, fromExtension: boolean }` | `void` | 上下文压缩失败或被中止时触发。 |
| `session_shutdown` | `{ reason: "quit" | "reload" | "new" | "resume" | "fork", targetSessionFile?: string }` | `void` | 当前扩展运行时销毁前触发。清理逻辑必须**幂等**。 |

#### 2. 输入、Agent 运行与边界事件

| 事件名 (`event.type`) | 事件负载 (`Event`) | 返回值契约 (`Result`) | 作用与注意事项 |
|---|---|---|---|
| `input` | `{ text: string, images?: ImageContent[], source: "interactive" | "rpc" | "extension", streamingBehavior?: "steer" | "followUp" }` | `{ action: "continue" } | { action: "transform", text: string, images?: ImageContent[] } | { action: "handled" }` | 收到用户输入后、进入 Agent 处理前触发。多个 handler 的 `"transform"` 会链式传递；任一 handler 返回 `"handled"` 会立即短路并消费该输入。 |
| `user_bash` | `{ command: string, excludeFromContext: boolean, cwd: string }` | `{ operations: BashOperations } | { result: BashResult } | undefined` | 用户通过 `!cmd` 或 `!!cmd` 执行命令时触发。返回 `operations`（如远程 SSH 执行）或直接返回 `result` 会停止向后传播；若 handler 抛错则直接阻断命令执行。 |
| `before_agent_start` | `{ prompt: string, images?: ImageContent[], readonly systemPrompt: string, systemPromptOptions: NormalizedBuildSystemPromptOptions }` | `{ message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">, systemPrompt?: string }` | 用户提交 Prompt 后、Agent 循环开始前触发。推荐直接原地修改 `event.systemPromptOptions`（如 `sections`、`promptGuidelines`、`selectedTools`）以利用结构化增量更新；若返回 `systemPrompt` 字符串则会强制替换本轮完整系统提示词。 |
| `agent_start` | `{ type: "agent_start" }` | `void` | Agent 循环正式开始。 |
| `turn_start` | `{ turnIndex: number, timestamp: number }` | `void` | 单个推理回合（一次 LLM 请求 + 对应的工具执行批次）开始。 |
| `turn_end` | `{ turnIndex: number, message: AgentMessage, toolResults: ToolResultMessage[], messageEntryId: string, toolResultEntryIds: string[], entries: SessionBoundaryDraft[], continue: boolean, context: BoundaryContextPreview, outcome: "completed" | "aborted" | "error" }` | `{ entries?: SessionBoundaryDraft[], continue?: boolean }` | **可行动边界（Actionable Boundary）**：回合结束时触发。可返回 `entries`（追加 `custom`、`custom_message`、`context_edit` 或 `compaction` 草稿条目）并设 `continue: true` 驱动下一回合。 |
| `agent_end` | `{ messages: AgentMessage[] }` | `void` | 当前 Agent 循环结束，携带本轮新增的 `messages`。注意此后仍可能发生自动重试或压缩恢复。 |
| `agent_before_settle` | `{ entries: SessionBoundaryDraft[], continue: boolean, context: BoundaryContextPreview, outcome: "completed" | "aborted" | "error" }` | `{ entries?: SessionBoundaryDraft[], continue?: boolean }` | **最终可行动边界**：在所有自动重试、恢复与排队消息处理完毕、即将彻底静止前触发。可追加条目并设 `continue: true` 触发额外一轮模型请求（需严格守卫条件以防死循环）。 |
| `agent_settled` | `{ type: "agent_settled" }` | `void` | Agent 运行已完全静止，不会再有任何自动继续。适合做回合级汇总、通知或外部状态同步。 |
| `ui_prompt_start` / `ui_prompt_end` | `{ reason: "ui_prompt", kind: "select" | "confirm" | "input" | "editor" | "custom", title?: string }` | `void` | 当扩展通过 `ctx.ui` 发起阻塞式用户交互提示的开始与结束时触发。 |
| `model_select` | `{ model: Model<any>, previousModel: Model<any> | undefined, source: "set" | "cycle" | "restore" }` | `void` | 模型切换或恢复时触发。 |
| `thinking_level_select` | `{ level: ThinkingLevel, previousLevel: ThinkingLevel }` | `void` | 思考深度切换时触发。 |

#### 3. 上下文、Provider 请求与消息流事件

| 事件名 (`event.type`) | 事件负载 (`Event`) | 返回值契约 (`Result`) | 作用与注意事项 |
|---|---|---|---|
| `context` | `{ messages: AgentMessage[] }` | `{ messages?: AgentMessage[] }` | 每次 LLM 请求前触发。`messages` **不含**系统消息；Pi 会在所有 `context` 处理器执行完毕后自动恢复系统提示词和工具声明状态，因此扩展可安全过滤或裁剪对话消息而不必担心丢失系统状态。 |
| `context_with_system` | `{ messages: AgentMessage[] }` | `{ messages?: AgentMessage[] }` | 在所有 `context` 处理器完成且 Pi 恢复系统状态后触发。`messages` 包含完整的 transcript（含索引 0 的系统消息），返回值将被原样发送给模型（处理器需自行保证系统消息与工具声明的完整性）。 |
| `before_provider_request` | `{ payload: unknown }` | `unknown`（若返回非 `undefined` 则替换 payload） | 发送给底层 Provider SDK/API 之前触发，可用于审计或覆写特定 Provider 的原始请求体。 |
| `before_provider_headers` | `{ headers: ProviderHeaders }` | `void` | 组装好 HTTP 请求头后触发。**原地修改** `event.headers` 即可（将某个键设为 `null` 可删除该请求头），返回值会被忽略。 |
| `after_provider_response` | `{ status: number, headers: Record<string, string> }` | `void` | 收到 Provider HTTP 响应头、开始消费响应流之前触发。 |
| `provider_stream_event` | `{ provider: ProviderId, api: Api, model: string, data: unknown }` | `void` | 每个解析后的原始流事件在 Pi 归一化之前触发。`event.data` 必须视为只读；处理器按流顺序 `await`，耗时操作会阻塞流消费。 |
| `cache_warming_decision` | `{ warmCost: number, missCost: number, continuationProbability: number, action: "warm" | "stop" }` | `{ action?: "warm" | "stop" }` | 每次空闲 Prompt Cache 预热刷新前触发，包含 Pi 计算的经济学期望收益决策。最后一个返回 `action` 的扩展处理器生效。 |
| `message_start` | `{ message: AgentMessage }` | `void` | 消息（user / assistant / toolResult）开始。 |
| `message_update` | `{ message: AgentMessage, assistantMessageEvent: AssistantMessageEvent }` | `void` | Assistant 流式生成期间逐 Token 触发。 |
| `message_end` | `{ message: AgentMessage }` | `{ message?: AgentMessage }` | 消息完成时触发。可返回替换后的 `message`（必须保持原有的 `role` 不变）。 |

#### 4. 工具调用与执行事件

| 事件名 (`event.type`) | 事件负载 (`Event`) | 返回值契约 (`Result`) | 作用与注意事项 |
|---|---|---|---|
| `tool_call` | `ToolCallEvent`（含 `toolCallId`, `toolName`, `input`, `parentToolCallId?`） | `{ block?: boolean, reason?: string, terminate?: boolean }` | 工具执行前触发。<br>1. **修改参数**：直接原地修改 `event.input`（后续 handler 可见，修改后不再二次校验 Schema）。<br>2. **拦截调用**：返回 `{ block: true, reason: "..." }`（若 handler 抛出未捕获异常，出于安全默认也会阻断工具执行）。<br>3. **类型收窄**：使用内置守卫 `isToolCallEventType("bash", event)` 或 `isToolCallEventType<"my_tool", MyInput>("my_tool", event)`。 |
| `tool_execution_start` | `{ toolCallId: string, toolName: string, args: any, parentToolCallId?: string }` | `void` | 工具开始执行通知。 |
| `tool_execution_update` | `{ toolCallId: string, toolName: string, args: any, partialResult: any, parentToolCallId?: string }` | `void` | 工具流式输出部分结果通知。 |
| `tool_result` | `ToolResultEvent`（含 `toolCallId`, `toolName`, `input`, `content`, `structuredContent?`, `details`, `isError`, `usage?`, `parentToolCallId?`） | `{ content?: (TextContent | ImageContent)[], details?: unknown, structuredContent?: JsonValue, isError?: boolean, usage?: Usage }` | 工具执行完成后、写入结果消息前触发。多个 handler 的修改会链式叠加。<br>**重要**：若工具包含 `structuredContent`，仅替换 `content` 而不返回 `structuredContent` 会导致 `structuredContent` 被丢弃（防止脱敏后数据不一致）。内置守卫：`isBashToolResult(e)`, `isReadToolResult(e)`, `isEditToolResult(e)` 等。 |
| `tool_execution_end` | `{ toolCallId: string, toolName: string, result: any, isError: boolean, parentToolCallId?: string }` | `void` | 工具执行结束通知。 |

---

## 五、`SessionManager` 与会话持久化模型

`SessionManager` 将对话会话管理为存储在 JSONL 文件中的**只读追加树（Append-only Tree）**（当前格式版本 `CURRENT_SESSION_VERSION = 3`）。每个条目拥有 `id` 和 `parentId`，通过 `leafId` 指针追踪当前活跃分支末端。

### 1. 会话条目类型 (`SessionEntry`)

除了文件首行的 `SessionHeader`（`type: "session"`）外，树中节点包含以下 11 种 `SessionEntry`：
- `message`: 标准对话消息（系统更新、用户、助手及工具结果）。
- `custom_message`: 参与 LLM 上下文的扩展自定义消息。
- `custom`: 不参与 LLM 上下文的扩展状态持久化节点。
- `compaction`: 上下文压缩记录点。
- `branch_summary`: 分支摘要条目。
- `session_info`: 会话元数据更改条目。
- 更多详见源码类型定义。
---

## 六、SessionManager 与会话持久化模型

Pi 会话持久化为一个完全**仅追加（Append-only）的 JSONL 树结构**文件（当前协议版本 `CURRENT_SESSION_VERSION = 3`）。每个会话的第一行为 `SessionHeader`，后续每一行均继承 `SessionEntryBase`，通过 `id` 与 `parentId: string | null` 构成可任意分支、分叉的对话树。

```ts
export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}
```

### 6.1 完整 11 种 SessionEntry 类型定义与字段解析

下表汇总了 Pi 架构中所有 11 种核心会话条目类型：

| Entry `type` | TypeScript 接口名称 | 是否参与 LLM 上下文 | 核心职责说明 |
| :--- | :--- | :---: | :--- |
| `"message"` | `SessionMessageEntry` | **是** | 核心对话消息（User、Assistant、ToolResult、System 等） |
| `"custom_message"` | `CustomMessageEntry<T>` | **是** | 扩展注入的上下文消息，送模时转换为 User 消息 |
| `"custom"` | `CustomEntry<T>` | **否** | 扩展专属私有持久化条目，对模型完全不可见 |
| `"context_edit"` | `ContextEditEntry` | **投影替换** | 分支局部的非破坏性上下文修改或裁剪 |
| `"compaction"` | `CompactionEntry<T>` | **是 (截断前序)** | 上下文压缩摘要，替代指定 ID 之前的所有历史 |
| `"branch_summary"` | `BranchSummaryEntry<T>` | **是** | 分支移动/导航时对离开分支生成的背景总结 |
| `"model_change"` | `ModelChangeEntry` | 否 (元数据) | 记录模型切换事件 |
| `"thinking_level_change"` | `ThinkingLevelChangeEntry` | 否 (元数据) | 记录推理深度级别变更 |
| `"usage"` | `UsageEntry` | 否 (账单审计) | 独立于消息的 Token 开销记录（如 Cache 保活刷新） |
| `"label"` | `LabelEntry` | 否 (UI 元数据) | 条目用户/扩展书签标签 |
| `"session_info"` | `SessionInfoEntry` | 否 (UI 元数据) | 会话显示名称等全局元数据 |

---

#### 1. `SessionMessageEntry` (核心对话消息)
```ts
export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}
```
- **字段解析**：底层对话消息联合体，包括 `UserMessage`、`AssistantMessage`、`ToolResultMessage`、`BashExecutionMessage` 以及初始 `SystemMessage`。
- **上下文行为**：在 `buildSessionContext()` 构建 LLM 上下文时作为主要对话序列原样输出。

#### 2. `ThinkingLevelChangeEntry` (思考级别变更)
```ts
export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string; // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
}
```
- **字段解析**：记录用户或扩展调用 `setThinkingLevel` 的时机。构建上下文投影时，沿分支自上而下应用最新的思考深度。

#### 3. `ModelChangeEntry` (模型变更)
```ts
export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}
```
- **字段解析**：记录会话中物理模型切换的事件。在分支回溯或重放时，用于确定该历史节点对应的模型环境。

#### 4. `UsageEntry` (解耦计费记录)
```ts
export interface UsageEntry extends SessionEntryBase {
  type: "usage";
  /** 计费分类标识，例如 "cache_warm" */
  kind: string;
  provider: string;
  model: string;
  usage: Usage;
  /** 可读的人类解释备注 */
  note?: string;
}
```
- **字段解析**：用于记录不属于任何单条对话消息的独立模型调用开销。`session.getSessionStats()` 会汇总所有 `UsageEntry` 以提供精确的账单。

#### 5. `CompactionEntry<T>` (上下文压缩摘要)
```ts
export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string | null;
  tokensBefore: number;
  /** 扩展专有元数据 (例如 ArtifactIndex 结构化索引) */
  details?: T;
  /** 生成该压缩摘要消耗的 LLM Token */
  usage?: Usage;
  /** 若由扩展 hook 生成则为 true，Pi 原生生成为 undefined/false */
  fromHook?: boolean;
  /** 压缩边界时刻的完整系统提示词与工具声明快照 */
  systemMessage?: SystemMessage;
}
```
- **关键机制**：
  - `firstKeptEntryId`: 压缩截断边界。构建上下文时，从根节点到该 Entry 之前的所有早期条目均被丢弃，仅以本条目生成的 Summary 消息替代；
  - 若 `firstKeptEntryId === null`，表示完全自包含压缩，丢弃此前所有消息；
  - `systemMessage`: 固化了压缩时刻的 System Prompt，确保后续消息复现时状态一致。

#### 6. `BranchSummaryEntry<T>` (分支切换摘要)
```ts
export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: T;
  usage?: Usage;
  fromHook?: boolean;
}
```
- **字段解析**：用户在 `/tree` 导航器中离开某个正在进行的分支并切换到新分支时，系统自动在切换点记录离开分支的总结，作为背景知识带入新分支。

#### 7. `CustomEntry<T>` (扩展私有持久化条目)
```ts
export interface CustomEntry<T = unknown> extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: T;
}
```
- **关键机制**：
  - **绝对不参与 LLM 上下文构建**（`buildSessionContext` 直接跳过）；
  - 扩展持久化自身业务状态的推荐方案。在 `session_start` 或 `session_tree` 事件中，扩展应扫描 `ctx.sessionManager.getBranch()` 中所有匹配自己 `customType` 的条目来还原内存状态。

#### 8. `CustomMessageEntry<T>` (扩展上下文消息条目)
```ts
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: T;
  display: boolean;
}
```
- **关键机制**：
  - **参与 LLM 上下文构建**：在 `buildSessionContext()` 中被映射为标准的 `UserMessage` 发送给模型；
  - `details`: 仅存放在本地 JSONL 中供扩展及 `registerMessageRenderer` 使用，**不发送给 LLM**；
  - `display`: 控制终端 TUI 是否展示。若设为 `false`，则成为“静默系统指令”，仅对 LLM 可见而不干扰用户终端视野。

#### 9. `ContextEditEntry` (追加式非破坏性上下文编辑)
```ts
export type ContextEditableContent =
  | UserMessage["content"]
  | AssistantMessage["content"]
  | ToolResultMessage["content"]
  | CustomMessage["content"];

export interface ContextEditEntry extends SessionEntryBase {
  type: "context_edit";
  targetId: string;
  /** 设为 null 将目标条目从上下文省略；非 null 则仅替换其 content */
  replacement: {
    content: ContextEditableContent;
  } | null;
}
```
- **关键机制**：
  - 核心设计哲学：**会话历史绝不可变（Immutable）**。若要修改或隐藏早期冗长的工具输出，不得直接篡改 JSONL 历史行，而是追加一条 `ContextEditEntry`；
  - `buildSessionProjection()` 在投影当前分支时，会检查最新的 `ContextEditEntry`：若为 `null` 则在当前分支的 LLM 上下文中彻底隐藏该条目，若提供 `content` 则仅替换其文本内容，保留原始的执行元数据和审计依据。

#### 10. `LabelEntry` (书签标签条目)
```ts
export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}
```
- **字段解析**：为目标条目关联一个用户可见或扩展标记的书签名称（展示在 `/tree` 分支图谱中）。传 `undefined` 表示清除书签。

#### 11. `SessionInfoEntry` (会话全局信息条目)
```ts
export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}
```
- **字段解析**：记录会话的用户自定义显示名称（对应 `pi.setSessionName`）。

---

### 6.2 只读会话管理器 ReadonlySessionManager (扩展安全视图)

扩展在普通事件及命令中访问的 `ctx.sessionManager` 遵循 `ReadonlySessionManager` 契约，防止扩展越权破坏会话文件的追加一致性：

```ts
export interface ReadonlySessionManager {
  getCwd(): string;
  getSessionDir(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getSessionName(): string | undefined;
  getHeader(): SessionHeader | null;
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  getEntry(id: string): SessionEntry | undefined;
  getLabel(id: string): string | undefined;
  getBranch(fromId?: string): SessionEntry[];
  getEntries(): SessionEntry[];
  getTree(): SessionTreeNode[];
  buildContextEntries(): SessionEntry[];
  buildSessionProjection(): SessionProjection;
}
```

#### 关键查询方法最佳实践
1. **状态恢复必须使用 `getBranch()`，切勿使用 `getEntries()`**：
   - `getEntries()` 返回会话树上**所有已存在分支的所有 Entry** 浅拷贝。若用户曾多次分叉，`getEntries()` 会包含多个平行分支的无效状态；
   - `getBranch(fromId?)`（默认从当前 `leafId` 向上追溯到根节点）**按时间顺序返回当前活跃分支上的线性祖先链**。这是扩展在 `session_start` 与 `session_tree` 事件中重建业务状态的唯一正确数据来源。
2. **`buildSessionProjection()` 投影机制**：
   ```ts
   export interface ProjectedSessionEntry {
     sourceEntry: SessionEntry;
     messages: AgentMessage[];
   }
   export interface SessionProjection {
     entries: ProjectedSessionEntry[];
     messages: AgentMessage[];
     thinkingLevel: string;
     model: { provider: string; modelId: string } | null;
   }
   ```
   返回应用了 `CompactionEntry` 截断以及所有 `ContextEditEntry` 替换之后的实际送模状态，并保留了每条消息与其所属底层 JSONL 条目之间的双向映射。

---

### 6.3 宿主会话管理器 SessionManager (写入、分支与静态工厂)

在 SDK 宿主环境或通过 `ExtensionCommandContext.newSession({ setup })` 获取的完整 `SessionManager` 实例，提供以下写入与分支控制接口：

#### 写入方法
- `appendMessage(message: Message | CustomMessage | BashExecutionMessage): string`：追加对话消息并推进 `leafId`，返回生成的 Entry ID。**注意**：只有当会话包含至少一条 user 或 assistant 消息时，磁盘上才会真正创建 `.jsonl` 文件。
- `appendCustomEntry<T>(customType: string, data?: T): string`：追加扩展私有数据。
- `appendCustomMessageEntry<T>(customType: string, content: ..., display: boolean, details?: T): string`：追加扩展上下文消息。
- `appendContextEdit(targetId: string, replacement: { content: ContextEditableContent } | null): string`：追加非破坏性编辑。
- `appendCompaction<T>(summary: string, firstKeptEntryId: string | null, tokensBefore: number, details?: T, fromHook?: boolean, usage?: Usage): string`：追加上下文压缩摘要。
- `appendModelChange(provider: string, modelId: string): string` / `appendThinkingLevelChange(thinkingLevel: string): string`
- `appendUsage(kind: string, provider: string, model: string, usage: Usage, note?: string): UsageEntry`
- `appendLabelChange(targetId: string, label: string | undefined): string`
- `appendSessionInfo(name: string): string`

#### 分支与树操作
- `branch(branchFromId: string): void`：将当前活跃叶子指针 `leafId` 移动到早期的任意 Entry 节点。下一次调用 `append*` 时将从该节点分叉出新的一条对话线。
- `resetLeaf(): void`：将 `leafId` 重置为 `null`。下一次追加将创建 `parentId: null` 的全新根节点（常用于重新编辑对话历史中的第一条用户消息）。
- `branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean, usage?: Usage): string`：移动叶子指针并立即写入一条 `BranchSummaryEntry`。
- `createBranchedSession(leafId: string): string | undefined`：从根节点到指定的 `leafId` 单线提取所有历史，写入一个新的 JSONL 会话文件并返回其路径。
- `buildSessionContext(): SessionContext`：生成最终发往模型的 `{ messages, thinkingLevel, model }`。

#### 静态工厂方法
```ts
// 创建新的持久化会话
SessionManager.create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;

// 打开已存在的会话文件
SessionManager.open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;

// 恢复当前工作目录最近一次编辑的会话（若无则新建）
SessionManager.continueRecent(cwd: string, sessionDir?: string): SessionManager;

// 创建纯内存会话（不生成磁盘文件，适合轻量测试、临时执行或子 Agent）
SessionManager.inMemory(cwd?: string, options?: NewSessionOptions, entries?: FileEntry[]): SessionManager;

// 从已有会话文件克隆并分叉创建新会话
SessionManager.forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;

// 快速按 UUID 查找会话文件完整路径（不读取文件正文）
SessionManager.findById(cwd: string, id: string, sessionDir?: string): string | undefined;

// 列出当前工作目录下的所有会话概要
SessionManager.list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>;

// 列出所有项目的所有会话概要
SessionManager.listAll(sessionDir?: string, onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>;
```

---

## 七、ModelRegistry 与 SDK 宿主嵌入入口

### 7.1 ModelRegistry 模型统一调度门面

`ctx.modelRegistry` 为扩展和 SDK 宿主提供多模型注册表、认证解析与中立流式请求门面（内部封装了 `ModelRuntime`）：

```ts
export interface ModelRegistry {
  // 模型查询
  getAll(): Model<Api>[];
  getAvailable(): Model<Api>[];
  find(provider: string, modelId: string): Model<Api> | undefined;
  findOfType<TType extends "chat" | "image" | "classifier">(type: TType, provider: string, modelId: string): ModelOfType<TType> | undefined;
  getModelsOfType(type: ModelType, provider?: string): AnyModel[];
  getAvailableOfType(type: ModelType, provider?: string, options?: ModelFilterOptions): AnyModel[];

  // 认证与凭据解析
  hasConfiguredAuth(model: Model<Api>): boolean;
  getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth>;
  getProviderAuthStatus(provider: string): AuthStatus;
  isUsingOAuth(model: Model<Api>): boolean;

  // 模型请求派发 (自动注入请求凭据与 Header)
  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
  stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): AssistantMessageEventStream;
  complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>;
  classify(model: ClassifierModel, context: ClassifierContext, options?: ModelsClassifierOptions): Promise<ClassifierResult>;
  generateImages(model: ImageModel, context: ImagesContext, options?: ModelsImagesOptions): Promise<AssistantImages>;

  // 模型目录动态刷新
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
}
```

- `streamSimple`：使用跨 Provider 统一的中立配置（自动适配 Claude、GPT、DeepSeek、Gemini 等不同 API 格式）。
- `classify` 与 `generateImages`：调用非对话型模型，遵循 **永不 Reject** 契约，调用失败时在结果对象中返回错误标记。

---

### 7.2 createAgentSession 与 AgentSession 架构

在外部 Node.js 或 Bun 应用中嵌入 Pi 的标准入口为 `createAgentSession`：

```ts
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

async function runEmbedPi() {
  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
    cwd: process.cwd(),
    thinkingLevel: "medium",
    tools: ["read", "bash", "edit", "write"], // 指定激活的内置工具
    sessionManager: SessionManager.create(process.cwd()),
  });

  // 订阅统一事件流
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        process.stdout.write(event.assistantMessageEvent.type === "text_delta" ? event.assistantMessageEvent.delta : "");
        break;
      case "agent_settled":
        console.log("\n[Session Settled]");
        break;
    }
  });

  // 触发用户交互
  await session.prompt("Review the changes in the current git repository.");

  // 优雅清理
  unsubscribe();
  session.dispose();
}
```

#### `AgentSession` 核心职能与控制方法

1. **状态读取**：
   - `session.state: AgentState`：包含底层 `pi-agent-core` 的完整消息历史与执行状态；
   - `session.model: Model<any> | undefined` / `session.routedModel`：当前模型及经虚拟模型路由后的物理模型；
   - `session.thinkingLevel: ThinkingLevel`：当前思考级别；
   - `session.systemPrompt: string`：当前生效的完整系统提示词；
   - `session.isStreaming: boolean` / `session.isIdle: boolean`：流式生成与空闲判断；
   - `session.getActiveToolNames(): string[]` / `session.getCallableToolNames(): string[]`：可用工具集；
   - `session.getSessionStats(): SessionStats`：聚合全会话（含已被压缩历史）的 Token、费用与工具调用统计；
   - `session.getContextUsage(): ContextUsage | undefined`：当前上下文窗口占用与限制。
2. **交互驱动与并发队列控制**：
   - `session.prompt(text: string, options?: PromptOptions): Promise<void>`：发送 Prompt 并等待完整运行循环结束；流式输出期间需通过 `streamingBehavior: "steer" | "followUp"` 指定插队模式；
   - `session.steer(text: string, ...): Promise<"handled" | "queued">`：中断引导；
   - `session.followUp(text: string, ...): Promise<"handled" | "queued">`：追加排队；
   - `session.abort(): Promise<void>` / `session.waitForIdle(): Promise<void>`：中断与等待空闲；
   - `session.clearQueue(): { steering: string[]; followUp: string[] }`：清空排队消息。
3. **环境与会话控制**：
   - `session.setModel(model, { persist?: boolean }): Promise<void>` / `session.cycleModel()`；
   - `session.setThinkingLevel(level, { persist?: boolean }): void` / `session.cycleThinkingLevel()`；
   - `session.executeBash(command, onChunk?, options?): Promise<BashResult>` / `session.abortBash(): void`；
   - `session.navigateTree(targetId, options?)`：移动会话树指针；
   - `session.exportToHtml(outputPath?, options?): Promise<string>` / `session.exportToJsonl(outputPath?): string`；
   - `session.reload(options?): Promise<void>`：热重载。
4. **生命周期与扩展绑定**：
   - `session.subscribe(listener: (event: AgentSessionEvent) => void): () => void`：订阅全量会话事件（包括 `AgentEvent` 消息事件、`queue_update`、`compaction_start`、`compaction_end`、`entry_appended`、`auto_retry_start`、`auto_retry_end` 以及 `agent_settled`）；
   - `session.bindExtensions(bindings: ExtensionBindings): Promise<void>`：为已加载扩展绑定特定运行模式下的 `uiContext`、`mode` 及命令处理器；
   - `session.dispose(): void`：注销所有监听器、停止保活定时器并释放底层运行资源。
