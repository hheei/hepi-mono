# pi-subagents MCP：Codex Desktop UI 与接入规格

统一工具契约见 [Pi 插件与 MCP 统一 Agents API Spec](unified-api-spec.md)：无公共 title/mode，统一 delegate 与 id + revision。实施状态见 [Tickets](unified-api-tickets.md)。本文描述当前 MCP 实现：server 名为 `pi_agents`，工具为 `delegate`、`get`、`stop`、`dashboard`，App-only 为 `list`、`transcript`、`catalog`、`receipts`。

状态（2026-10-27）：R0–R4 的卡片、刷新和 Dashboard 已有包内测试。页面是 `src/mcp/app.html`，样式来自 AgentDock `a0ffc511`（Apache-2.0，文件内有归属）。Codex Desktop 实机验收还没做。

## 1. 产品目标

Codex Desktop 配置一个 MCP server，便能创建、复用和管理 Pi subagents，并在**对话内看到可展开的子代理任务卡片**。Task Card 是首要 UI，Dashboard 负责多个 child 的总览。Codex TUI 在 Desktop UI 交付后处理。

完整交互：

1. Codex 为需要实时卡片的工作调用 `delegate({agent:"worker",task:"...",wait:false})`：立即取得 `id` 与 `revision`，关联内嵌 Task Card。
2. Task Card 呈现 agent 身份、委派状态、runtime 状态、当前工具、持续时间和累计用量；运行过程中更新内容。
3. 完成后卡片用 `get({id,revision,includeOutput:true})` 读取该次委派的结果；模型同样可显式读取。直接要求模型等待答案时使用 `wait:true`，由原始 MCP 工具调用返回结果。
4. 卡片展开后可以查看输出、诊断、Transcript 与历史 revision，并向原 agent 发送 `steer` 或停止。
5. `dashboard` 集中列出多个 agent，进入任意 agent 的详情。

**身份**：`id` 标识可多轮复用的 Pi session；`revision` 是该 agent 上单调递增的委派序号。runtime 状态（`progress.runtimeState`）描述 agent 此刻在做什么，`status` 描述所选委派的结果，两者分开呈现，历史结果不会被新一轮覆盖。

## 2. Codex Desktop UI

### 2.1 MCP Apps 的具体接入

采用 AgentDock 的原生 MCP Apps 实现：单个 HTML 文件 + 内联 CSS/JS，通过标准 JSON-RPC `window.parent.postMessage` 与宿主通信。MCP Server 用已有 `@modelcontextprotocol/server` 注册工具和静态资源：

- **工具描述**：`delegate` 的 descriptor 声明 `_meta.ui.resourceUri = "ui://hheei/subagents/task"`。
- **Dashboard**：`dashboard` 的 descriptor 声明 `_meta.ui.resourceUri = "ui://hheei/subagents/dashboard"`。
- **资源**：服务器经 `resources/read` 返回 `text/html;profile=mcp-app` HTML；HTML 模板与结果数据分离，可复用、缓存。
- **结果**：工具的 `content` 给模型提供简明文字，`structuredContent` 提供 `id`、`revision`、`status`、`hasOutput` 与 `progress`；结果正文只在 `includeOutput:true` 时返回，并受既有输出上限约束。实时卡片使用 `wait:false`，普通等待调用默认 `wait:true`。
- **交互**：内嵌视图使用 MCP Apps bridge 接收初始 tool result，并通过 `tools/call` 访问 `get`、`list`、`transcript`、`catalog`、`receipts`、`delegate`、`stop`。
- **资源交付**：发布 package 时把 HTML 模板复制到 `dist/mcp/apps/`；MCP Server 读取该文件并响应资源请求。JavaScript 直接调用 `ui/initialize`、`ui/notifications/initialized`、`tools/call` 等标准 MCP Apps bridge 方法。

Codex 真实读取路径位于 `codex-rs/core/src/mcp_tool_call.rs`：从**tool descriptor** 的 `meta.ui.resourceUri` 生成 `mcp_app_resource_uri`，再进入 App Server 的 `mcpToolCall.mcpAppUi`。首发对每个需要卡片的工具使用 descriptor-level 绑定。

```text
Codex Desktop
   │ tools/list: delegate._meta.ui.resourceUri
   ▼
delegate ──────────────► MCP Adapter ─► Controller ─► SubagentManager
   │                                             │
   │ tools/call result                           └► SQLite delegation ledger
   ▼
Task Card (ui://hheei/subagents/task)
   ├─ 初始 tool result / structuredContent
   ├─ get({id,revision?,includeOutput?})
   ├─ transcript / receipts
   └─ delegate({id,task,wait:false}) / stop({id})
```

### 2.2 Task Card：默认 Compact，按需展开

设计贴近 Codex Desktop 的原生卡片：小面积、轻分割、短状态文本、自然展开。执行中和执行完毕使用相同布局，状态与正文自然变化。

```text
╭──────────────────────────────────────────────╮
│  Worker                  Running      00:42  │
│  Implement authentication middleware         │
│                                              │
│  ● Running tests · vitest                    │
│  6 turns · 18.4k tokens                       │
│                                              │
│  Details ▾                              Stop  │
╰──────────────────────────────────────────────╯

Details ▾ 展开：
│  Activity                                    │
│  · Read src/auth.ts                          │
│  · Edit middleware.ts                        │
│  · Run vitest                                │
│                                              │
│  Output · Diagnostics · Transcript           │
│  Latest output / result ...                  │
│                                              │
│  Continue this agent...                Send   │
```

| 状态 | Compact 内容 | 展开内容 |
| --- | --- | --- |
| Starting / Running | Agent、任务标题、状态、耗时、当前工具、用量 | 最近活动、执行信息、输出 |
| Done | 完成状态、最终摘要、耗时 | 完整答案、usage、可分页 Transcript |
| Blocked | 等待用户决策与问题摘要 | 回答表单与继续任务操作 |
| Error | 简短错误说明、恢复入口 | 诊断、最后确认的操作、继续 steer / stop |
| Disconnected / Interrupted | 最后已知状态及时间 | controller 状态、旧结果、恢复入口 |

组件契约：

- 数据统一来自 `get`（含 `progress.runtimeState`）和现有 manager 状态投影。`onChange` 提供状态失效信号，Settlement 负责最终结算内容。
- 卡片可见时定期获取最新状态；带推送的 host 使用通知触发刷新。隐藏时停止刷新。
- 当前活动来自 `activeTool`、`summary` 和 `usage`；使用文字阶段，任务拥有确定总量时再展示进度比例。
- 展开保持原地状态，窄屏单列，宽屏可显示详情；支持明暗模式、键盘和辅助技术。
- Task Card 和 Dashboard 共用视觉 token、状态组件与读取逻辑。

### 2.3 AgentDock 的实际 UI 实现与最小移植范围

已核对上游源文件 [`uvwt/agentdock-protocol/mcpapps/app.html`](https://github.com/uvwt/agentdock-protocol/blob/main/mcpapps/app.html)（blob SHA `a0ffc5114507a498013dc8a5bbd572114e23bf5d`，约 88 KB / 1252 行）。其 UI 使用**单个 HTML 模板、内联 CSS、原生 DOM API 和 MCP Apps JSON-RPC `postMessage`**。Go 代码仅在 `apps.go` 中嵌入并替换 `{{VIEW}}` / `{{TITLE}}`，之后由 `internal/mcp/apps.go` 直接注册静态 `ui://` resource。运行无需 React、Vue、前端 bundler 或独立 HTTP UI 服务。

**直接采用的源代码单元**：

| 上游 `app.html` | 功能 | 适配动作 |
| --- | --- | --- |
| 顶部 `:root` / `data-theme` CSS + media query | 跟随宿主颜色、明暗模式与系统字体 | 保留颜色 token、字号、compact/detail 样式；以 `--color-text-primary` 等 host token 为首选 |
| `el()` + `compactShell()` | 以 `createElement` / `textContent` 生成节点；compact 行与详情折叠；`aria-expanded` | 保留 DOM 结构；把 AgentDock 品牌文案换为子代理名称 |
| `reportSize()` + `ResizeObserver` | 高度变化后发送 `ui/notifications/size-changed` | 原样沿用折叠、正文更新后的尺寸报告 |
| `rpcRequest()` / `rpcNotify()` + `initializeBridge()` | 使用 JSON-RPC `window.parent.postMessage`；处理 `ui/initialize` / `ui/notifications/initialized` | 将 appInfo 改为 `pi-subagents-task`，`protocolVersion` 使用 `2026-01-26` |
| `ui/notifications/tool-input` / `ui/notifications/tool-result` | 保存调用输入和 `structuredContent`，驱动首屏 `render()` | 读取 `childId` / `delegationId`，绑定正在展示的任务 |
| `taskRefreshSchedule()` / `taskRefreshOnce()` / `taskRefreshStop()` | 可见时刷新、终态停刷、断线退避、generation 防旧响应覆盖 | `task_manage({action:"get"})` 替换为 `get({id,revision?})` |
| `visibilitychange` / `ui/resource-teardown` | 隐藏时暂停、重新显示时恢复、视图销毁时释放 | 原样沿用 |
| `task_live.test.mjs` | 针对 task 状态、刷新、结束/退避测试 | 同样对提取的 helper 编写独立 Node/Vitest 纯函数测试 |

**实施入口**：R4 已有 `packages/pi-subagents/src/mcp/views.ts`、Task Card / Dashboard 的 MCP resource 注册和基础测试。按 [MCP R4 tickets](tickets.md) 从此处继续：将上游 `app.html` 的 compact、theme、bridge、task refresh 部分提取为一个支持 `task` / `dashboard` view 的 `packages/pi-subagents/src/mcp/apps/app.html` 模板，替换现有 `views.ts` 的长内联页面。打包时将模板复制到 `dist/mcp/apps/`；adapter 通过 `readFileSync(new URL(..., import.meta.url))` 加载并注册 `resources/read`。这沿用 AgentDock 的单 HTML 模板模式，前端由宿主 webview 执行。

**数据适配**：

```text
AgentDock                         pi-subagents
task_manage({action:"create"}) → delegate({agent,task,wait:false})
task_manage({action:"get",      → get({id:childId})
             task_id})
task.status                   → child.state + receipt.status
task.title                    → receipt.task / child.title
task.current_step.title       → child.activeTool / child.summary
task.step_count               → child.usage / turns（统计指标）
task.summary                  → receipt.resultText / child.summary
                                get({id,revision,includeOutput:true}) → 最终报告
```

当前 Pi child 的进度以**状态、活动工具、累计 token/turns** 表达。AgentDock 的 `taskProgress(steps)` 是真实步骤序列的视觉化；当 Pi 提供可核实的步骤列表时接入该节点轨迹，初版显示紧凑文字状态。

AgentDock 的刷新值可直接采用：运行中 2000 ms，阻塞 10000 ms，失败重试 5000 ms，单次 RPC 8000 ms；隐藏时取消定时器，终态停止刷新，`generation` 防止旧请求覆盖新 child。卡片 UI 的状态更新与 Pi 子代理计算运行相互独立。

**版权来源**：被直接移植的 HTML/CSS/JS 片段源于 `uvwt/agentdock-protocol`（Apache-2.0）。保留上游 attribution、许可证文本/NOTICE（如适用），在新文件注明原文件及 commit，并记录本地修改。最终发布包同时包含对应许可文件。

### 2.4 Dashboard

Dashboard 在会话中展示当前 workspace 的 child 总数、运行/阻塞/完成统计、搜索与状态过滤、child 列表、选中 child 的详情，并可直接新建、steer、stop 和查看 transcript。Task Card 与 Dashboard 操作同一套 MCP tools。

### 2.5 参考 AgentDock 的可复用模式

[uvwt/agentdock](https://github.com/uvwt/agentdock) 已经通过 MCP Apps 渲染多种卡片，包括 Task Progress、File Change、Image、Artifact、Workspace Context。相关实现：

| 源码 | 具体实现 | 本项目对应 |
| --- | --- | --- |
| [internal/mcp/server.go](https://github.com/uvwt/agentdock/blob/main/internal/mcp/server.go) | 在 tool descriptor / result 挂载 `_meta.ui.resourceUri`，同时返回文本与结构化结果 | `delegate` 固定 descriptor → Task Card |
| [internal/mcp/apps.go](https://github.com/uvwt/agentdock/blob/main/internal/mcp/apps.go) | 统一登记 `ui://` HTML resource、MIME type、CSP、HTML 内容 | 两个资源：Task Card 与 Dashboard |
| [internal/app/mcp_apps.go](https://github.com/uvwt/agentdock/blob/main/internal/app/mcp_apps.go) | 工具级、action 级绑定，`full / compact / off` 密度选项 | 首发 Compact + 展开详情，后续增加视图密度设置 |
| [docs/image-model-context.md](https://github.com/uvwt/agentdock/blob/main/docs/image-model-context.md) | 保留标准 MCP 内容及结构化结果，另外提供交互 UI | 用同一原则展示子代理的状态与最终结果 |

AgentDock 还把 HTML 组件放在 [agentdock-protocol](https://github.com/uvwt/agentdock-protocol) 复用。`pi-subagents` 使用 MCP Apps 标准接口并实现自己的两种小型视图。

### 2.6 人工输入与 Progress

**Elicitation**：child 遇到阻塞时，以 `elicitation/create` 向用户提出选项或确认问题。响应关联 `childId`、`delegationId`；接受后调用 `manager.send(id, answer, "steer")`。Task Card 也呈现同一 blocked 状态和继续输入入口。

**Progress**：标准 MCP `notifications/progress` 支持工具请求进度；Task Card 主要使用 manager 实时状态与当前工具。Codex 的 `logging_client_handler.rs` 当前会记录标准 progress 通知；TUI 视觉优化放入后续。

## 3. 运行架构与 Ownership

```text
Codex Desktop ── MCP stdio ── Adapter
  MCP Apps HTML ── App bridge ────────┤
                                      ▼
                           Standalone Controller
                           Pi headless AgentSession
                                      ▼
                                SubagentManager
                               ┌──────┴──────┐
                         Pi child bridge   Settlement
                         SQLite / lease        │
                               │           Durable Receipt
                            Child Pi            │
                                          MCP result + UI
```

- **Standalone Controller**：按显式 workspace 独占一个长期运行的 Pi headless parent；持有唯一 manager、model/skills、registry。stdio Adapter 为短生命周期入口，经 Unix socket 连接或按 owner lock 自动启动。
- **Child 执行**：继续使用原有 `spawn()`、`send(id,task,"steer")`、Pi child bridge、session lease、SQLite mailbox、runtime recovery。
- **Receipt**：在已有 `state.sqlite` 新增窄表，记录 `parentSessionId`、`delegationId`、`childId`、输入边界、结算状态、文本、用量与时间。
- **结算路由**：现有 manager 的 `#performAutoReport` 核实回合结束后写 receipt，并通知 MCP waiter；未来人工 Pi attach 继续使用原有 `ParentChannel`。
- **恢复**：持久 parent Pi session ID 与 workspace 绑定；controller 重启执行 reconcile，MCP 客户端凭 receipt 读取最新状态。
- **权限**：worker 使用 Pi 的 model credential、cwd 与工具策略；内嵌 UI 经 MCP bridge 调用工具，controller socket 和内部数据库保存在私有目录。

已通过 `startStandaloneController()` 与真实 headless Pi extension 的 SDK 运行测试。stdio、receipt 和两张 MCP Apps 卡片已有包内测试。Codex Desktop 手动验收仍是后续。

## 4. MCP API

模型入口是 `delegate` / `get` / `stop` / `dashboard`；App-only 工具只供内嵌视图调用。

| 工具 | 可见性 | 参数 | 返回 | UI |
| --- | --- | --- | --- | --- |
| **`delegate`** | model + app | `task` 必填，`agent?,id?,cwd?,wait?` | 受理即返回 `id`、`revision`、`status`、`hasOutput`；`wait:true`（默认）返回终态结果 | **Task Card** |
| `get` | model + app | `id`，`revision?`，`includeOutput?` | 所选委派的 status/任务/输出，以及 `progress.runtimeState` | 卡片刷新与结果 |
| `stop` | model + app | `id` | 停止 runtime；未结算 revision 记为 failed，已完成结果与会话保留 | 卡片详情 |
| **`dashboard`** | model + app | — | 统计与每个 agent 的最新委派摘要 | **Dashboard** |
| `list` | app | — | 同 dashboard | Dashboard 刷新 |
| `transcript` | app | `id,cursor?,limit?` | 有界历史页 | 展开 Transcript |
| `receipts` | app | `cursor?,limit?` | 近期委派（id + revision，无正文） | 历史 revision |
| `catalog` | app | — | agent 目录 | 新建任务 |

**升级后重连**：工具名从 `subagents_*` 改为 `delegate`/`get`/`stop`/`dashboard`，MCP server 自报名称改为 `pi_agents`。客户端缓存的 `tools/list` 不会自动刷新，升级后需重启该 MCP server 条目（Codex Desktop 中重启应用或重新加载 MCP 配置）并确认工具列表已更新；旧名字的调用会得到 unknown tool 错误。

`SubagentManager.submitDelegation()` 已处理三种入口：

- `{agent, task}` → `spawn()`。
- `{id, task}` → `send(id, task, "steer")`，复用原 session。
- `{id, agent, task}` → 由 `id` 选择 child，忽略创建参数。

正在执行的 Pi child 将 steer 注入现有 run；结束的 runtime 在复用 session 时通过原生 `prompt` 开始新 run。对外将操作类型描述为 `spawn / reuse`。

## 5. 结算、并发与恢复

1. **受理**：提交前为 agent 预留 `revision`，记录工作归属及消息边界。child 的 `accepted/path` ack 登记受理。
2. **最终结果**：由 `agent_settled`、Pi session 和 manager 工作版本确认回合结算。结果包括成功、失败、阻塞、空输出、`/compact` 控制结果，以及终态文本。
3. **并发**：每个 agent 同时只有一个 awaited delegate waiter；`wait:false` steer 只确认注入。多个不同 agent 可并行工作。
4. **共享运行**：Pi parent 运行中的 child 接收 MCP steer 时，两方消费同一 run 的结果。
5. **断线恢复**：客户端超时只结束本次等待；controller/child 继续工作。重新连接按 `id` + `revision` 读取结果，或用 `receipts` 列出近期委派。
6. **不确定的副作用**：保留原生 `OperationError` 的 `childId`、`sideEffects`、`safeToRetry`；`uncertain` 状态引导用户核对 child 与 session。
7. **显式停止**：`stop` 停止整个 agent runtime，未结算 revision 记为 failed，已完成结果与会话保留用于下次 steer。

## 6. 分阶段交付

**协议栈**：当前 package 增加 MCP CLI/bin，使用官方 TypeScript SDK v2 的 `@modelcontextprotocol/server`、`serveStdio`、`fromJsonSchema` 对接现有 TypeBox contract。适配 Codex MCP stdio 握手；CLI 使用显式 workspace/cwd、owner lock、ready 检查、私有 Unix socket。

**UI 栈**：沿用 AgentDock 的原生 HTML + CSS variables + JSON-RPC `postMessage` 模式，两个 `ui://` resources 由现有 MCP Server SDK 注册。没有新增前端框架依赖。完整链路为 `tools/list → tools/call → resources/read → ui/initialize → ui/notifications/initialized → UI 内 tools/call`。

| 阶段 | 交付 |
| --- | --- |
| R0（完成） | `submitDelegation` 的 spawn/reuse 选择与 schema |
| R1（实现并测试） | Standalone controller、headless Pi session、workspace ownership、model/skills |
| R2（实现并测试） | Durable receipt：完成、blocked、空结果、compaction、crash window |
| R3（bin 已接，Codex CLI 未实测） | Unix socket IPC、`pi-subagents-mcp`、legacy initialize、delegate 等待 receipt |
| R4（卡片已接，Desktop 未实测） | Compact card、稳定 DOM 刷新、steer/stop/transcript、Dashboard。见 `docs/pi-subagents/tickets.md` MCP-R4-01～04 |
| R5 | Codex Desktop Elicitation、视觉细节、交互验收 |
| R6（后续） | Codex TUI、MCP Tasks、认证 Streamable HTTP |

### UI 验收

- Codex Desktop 使用 `delegate(wait:false)` 即时返回 `id` + `revision` 并在会话内出现 MCP Task Card；对应 `ui://` 资源成功读取和初始化。`wait:true` 独立验证结果直接返回模型。
- 运行过程中卡片更新 `activeTool`、状态和用量；完成后与 MCP 返回结果相同。
- 展开/收起不会丢失选中的 child；卡片内可以 steer、stop、查看 transcript。
- 多 child Dashboard、不同 Codex Client 共享 controller、控制进程重启后恢复结果均可正常使用。
- 大小窗口、明暗主题、键盘操作、长输出、blocked、error 和断线状态经过 Codex Desktop 手动验收。
- 真实 Pi child + MCP stdio + HTML resource 的集成测试通过；package clean install 含 CLI 与 HTML bundle。

## 7. 上游参考

- AgentDock 原生 HTML 模板：<https://github.com/uvwt/agentdock-protocol/blob/main/mcpapps/app.html>
- AgentDock Task Progress 测试：<https://github.com/uvwt/agentdock-protocol/blob/main/mcpapps/task_live.test.mjs>
- AgentDock 工具/结果 UI metadata：<https://github.com/uvwt/agentdock/blob/main/internal/mcp/server.go>
- AgentDock HTML resources：<https://github.com/uvwt/agentdock/blob/main/internal/mcp/apps.go>
- AgentDock UI bindings：<https://github.com/uvwt/agentdock/blob/main/internal/app/mcp_apps.go>
- MCP Apps 规范：<https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx>
- Codex Tool Descriptor → App UI：<https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs>
- Codex App Server UI：<https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- MCP SDK v2：<https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28>
- Pi SDK Headless 测试：<../../packages/pi-subagents/test/mcp-headless-sdk.test.ts>
