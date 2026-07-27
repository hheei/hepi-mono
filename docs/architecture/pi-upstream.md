# Pi 上游模块化与扩展架构研究

本文研究 `earendil-works/pi`（原 `badlogic/pi-mono`）在 `v0.80.10` 的模块边界与扩展机制，并据此给出 `hepi-mono` 的整理方向。

> 版本基线：`v0.80.10`，commit [`8dc7883`](https://github.com/earendil-works/pi/tree/8dc78834cde4e329284cf505f9e3f99763df5529)。本仓库依赖同版本。上游实际包名是 `pi-agent-core`，不是 `pi-core`；下文统一写 `pi-agent-core`。

## 1. 核心结论

Pi 的高扩展性不是来自“模块可以任意互调”，而是来自相反的约束：

1. 依赖严格单向流动。
2. 下层只提供机制和稳定数据协议，不包含产品策略。
3. 上层通过 composition root 组装下层能力。
4. 扩展只接触 `ExtensionAPI` 门面，不接触宿主内部对象。
5. 模块协作经过宿主事件、注册表或显式共享契约，不直接互相 import。
6. session、reload、资源和 UI 都有明确 owner，旧 runtime 会失效。
7. 重依赖通过子路径和 lazy import 隔离，默认入口保持轻量。

因此，Pi 的“相互支持”本质是 **由宿主中介的能力组合**，不是模块间形成网状依赖。

## 2. 上游分层

```text
extensions
    │
    ▼
pi-coding-agent (CLI / SDK / RPC)
    ├──> pi-agent-core ──> pi-ai
    └──> pi-tui
```

箭头表示源码依赖方向：

```text
pi-coding-agent -> pi-agent-core -> pi-ai
pi-coding-agent -> pi-tui
```

`pi-ai` 和 `pi-tui` 不知道 coding agent；`pi-agent-core` 不知道 CLI、TUI、文件工具、extension discovery 或 session 文件；`pi-coding-agent` 是产品组合层。

来源：上游 [`packages/agent/package.json`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/agent/package.json)、[`packages/coding-agent/package.json`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/package.json)。

### 2.1 `pi-ai`：协议和 provider 运行时

`pi-ai` 处理供应商差异，但不处理 agent 工作流。其关键拆分是：

```text
Model     = 调用哪个模型，以及模型能力
Provider  = 谁拥有模型目录、认证和请求分发
Api       = 如何讲 Anthropic/OpenAI/Google 等 wire protocol
Models    = provider 集合、认证应用、模型查询和统一调用入口
```

`Model.api` 与 `Model.provider` 是两个独立维度。同一个 OpenAI-compatible API 实现可以被多个 provider 复用；一个 provider 也可以按不同 model 的 `api` 分派到多个实现。

`Provider` 是运行时插件单元，公开 identity、endpoint metadata、认证、模型目录、刷新、可用模型过滤和 stream 契约。`createProvider()` 是组装边界：内建 provider 和自定义 provider 都从相同零件构造。`Models` 负责选择 provider、解析认证、合并 headers，再委托 provider stream。

来源：[`models.ts` 的 `Provider` 和 `Models`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/ai/src/models.ts#L75-L170)、[`createProvider()` 和 mixed-API dispatch](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/ai/src/models.ts#L533-L623)。

所有供应商输出被归一化为统一的 `AssistantMessageEvent`：text、thinking、tool call、done 和 error。上层 agent loop 不需要理解 SSE、WebSocket 或各 SDK chunk 格式。

来源：[`types.ts` 的 stream 和 event contract](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/ai/src/types.ts#L309-L476)。

根入口刻意保持 side-effect free。provider factories、具体 API 实现、OAuth 和旧 compat API 使用独立子路径；SDK 在第一次请求时 lazy import。这样消费者只为实际使用的 provider 付启动和 bundle 成本。

来源：[`pi-ai/src/index.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/ai/src/index.ts)、[`api/lazy.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/ai/src/api/lazy.ts)。

### 2.2 `pi-agent-core`：最小 agent 状态机

`pi-agent-core` 的核心循环只做五件事：

1. 将 prompt 加入 transcript。
2. 通过可注入 `StreamFn` 请求模型。
3. 把统一 stream event 归约成 assistant message。
4. 校验并执行 tool calls，把结果加入 transcript。
5. 根据 tool calls、steering、follow-up 和 stop hook 决定是否继续。

循环没有 planner、memory、RAG、provider selection、TUI、权限弹窗或 coding-specific 工具。策略留给上层。

来源：[`agent-loop.ts` 的 `runLoop()`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/agent/src/agent-loop.ts#L152-L260)。

主要扩展点不是基类和继承，而是小 callback：

- `streamFn`：替换模型传输。
- `convertToLlm`：把应用消息映射为 provider 可接受消息。
- `transformContext`：裁剪或注入 context。
- `beforeToolCall` / `afterToolCall`：权限、改写和结果治理。
- `prepareNextTurn` / `shouldStopAfterTurn`：轮次策略。
- `getSteeringMessages` / `getFollowUpMessages`：消息队列策略。

来源：[`AgentLoopConfig`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/agent/src/types.ts#L140-L281)。

`AgentMessage` 允许应用增加 custom messages，但只在 LLM 调用边界执行 `convertToLlm`。UI-only 状态可以留在应用 transcript，不会意外进入 provider payload。这是数据模型扩展与外部协议之间的明确防火墙。

工具同样只有窄契约：schema、`execute()`、可选 argument compatibility、更新 callback 和 execution mode。参数验证、错误归一化、abort 和事件顺序由 loop 统一处理。

来源：[`AgentMessage`、`AgentTool` 和 `AgentEvent`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/agent/src/types.ts#L291-L408)。

### 2.3 `pi-tui`：无业务语义的渲染底座

`pi-tui` 提供 terminal、differential rendering、keyboard、editor 和 component primitives。它不依赖 `pi-ai` 或 `pi-agent-core`，也不知道 model、tool 或 session 的语义。

这让同一 TUI primitives 可以服务不同产品，也阻止 UI 组件反向控制 agent runtime。

来源：[`pi-tui/package.json`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/tui/package.json)、[`pi-tui/src/index.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/tui/src/index.ts)。

### 2.4 `pi-coding-agent`：composition root 和产品策略

`pi-coding-agent` 同时消费 `pi-ai`、`pi-agent-core` 和 `pi-tui`，负责：

- coding tools；
- model/auth runtime；
- settings 和 resource discovery；
- session persistence、compaction 和 replacement；
- extension system；
- interactive、print、JSON 和 RPC modes；
- CLI 与 SDK 公共入口。

它是耦合最多的包，因为它的职责就是组装产品。关键是这些耦合没有反向泄漏到下层。

`createAgentSessionServices()` 先创建 cwd-bound 的 model/settings/resource services，`createAgentSessionFromServices()` 再创建 session。session 替换则由 `AgentSessionRuntime` 拥有：先 shutdown 旧 runtime，再重建目标 cwd 的 services 和 session。

来源：[`agent-session-services.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/agent-session-services.ts#L111-L216)、[`agent-session-runtime.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/agent-session-runtime.ts#L33-L180)。

## 3. Extension 系统为什么能扩展

### 3.1 门面，不暴露宿主内部对象

extension factory 只收到 `ExtensionAPI`。它可以注册：

- event handler；
- tool；
- command、shortcut、flag；
- message/entry renderer；
- provider；
- shared event bus handler。

事件 handler 和工具执行通过 `ctx.ui` 使用宿主注入的 UI 能力。注册声明写入 extension 自己的 registry；发送消息、切换 model、激活 tools 等动作转发到 session-scoped runtime。扩展不持有 `AgentSessionRuntime`、interactive mode 或内部 registry 实现。

来源：[`ExtensionAPI`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/extensions/types.ts#L1166-L1478)、[`createExtensionAPI()`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/extensions/loader.ts#L222-L390)。

### 3.2 声明阶段与运行阶段分开

加载 extension 时，runtime action 尚未绑定。此时允许注册声明；需要宿主运行态的动作先使用 throwing stub，provider registration 则排队，等 model runtime 创建后统一 flush。

这解决两个问题：

- extension 可以在 session 创建前声明能力；
- extension 不能在初始化顺序尚未完成时偷用运行态对象。

来源：[`createExtensionRuntime()`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/extensions/loader.ts#L169-L220)。

### 3.3 事件是显式 middleware，不是隐式调用链

`ExtensionRunner` 按 extension 加载顺序和 handler 注册顺序执行事件。不同事件拥有明确的组合语义：

- 通知事件：顺序执行，错误隔离并继续。
- `session_before_*`：允许 cancel，命中后短路。
- `message_end`：后一个 handler 看见前一个 handler 的修改结果。
- `tool_call`：可以 block 或修改 input。
- `tool_result`：按字段 patch，后一个 handler 接收最新结果。

因此，多扩展组合的顺序和冲突可被定义、测试和记录，而不是藏在任意函数调用中。

来源：[`ExtensionRunner.emit()` 和 `tool_result` 链](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/extensions/runner.ts#L759-L882)、[`emitToolCall()`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/extensions/runner.ts#L885-L905)、[`ToolCallEvent` mutation contract](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/extensions/types.ts#L1050-L1066)。

### 3.4 ResourceLoader 统一发现，不让功能包自己扫描环境

`DefaultResourceLoader` 统一加载 extensions、skills、prompts、themes 和 context files，并处理 global/project scope、settings filters、去重、project trust 和 reload。

功能模块只声明资源。它不应自己递归扫描目录、解释 package source 或决定 trust。

### 3.5 lifecycle 与 stale runtime 是一等约束

session switch、fork 和 new 属于 session replacement：

1. 发 `session_shutdown`；
2. 清理宿主 UI；
3. dispose 旧 session；
4. 按目标 cwd 重建 services、extensions 和 session；
5. 使旧 session 的 `pi` / `ctx` 失效。

旧 context 的 getter 和 action 都经过 `assertActive()`。这阻止 extension 在 replacement 后继续操作错误 session。

`/reload` 是另一条路径：它保留当前 `AgentSession` 和 cwd-bound services，在原 session 内重新加载 settings/resources 并替换 extension runner。reload 前仍会发 `session_shutdown`；旧 command call frame 可能继续执行，所以 reload 后不得再依赖旧 extension 的内存状态，command 应把 `await ctx.reload()` 当作终点。

来源：[`AgentSessionRuntime.teardownCurrent()`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/agent-session-runtime.ts#L158-L180)、[`AgentSession.reload()`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/agent-session.ts#L2577-L2599)。

但 extension 仍是拥有完整系统权限的代码，不是 sandbox。project trust 决定是否加载项目扩展；扩展自行创建的 timer、socket、process 和 listener 仍必须在 `session_shutdown` 幂等清理。

## 4. HEPI 应如何实现模块“相互支持”

上游提供 `pi.on()`、各类 registration API、`pi.events` 和 package resources 等协作机制，但不规定 HEPI feature 之间的依赖政策。结合本仓库已有的 `feature -> pi-basics` 约束，HEPI 应按协作语义选择通道：

| 需求 | 应使用的通道 | 原因 |
| --- | --- | --- |
| 观察或拦截宿主生命周期 | `pi.on(...)` | 宿主定义顺序、返回值和错误语义 |
| 向模型增加动作 | `registerTool()` | schema、执行和渲染契约统一 |
| 向用户增加动作 | `registerCommand()` / shortcut | 命令归宿主发现和冲突管理 |
| 增加模型供应商 | `registerProvider()` | 复用 model/auth/stream runtime |
| 发布无 owner 的通知 | `pi.events`，事件名带 namespace | 发送方不需要知道接收方 |
| 协调共享可变状态 | foundation-owned 窄接口 | owner、cleanup 和冲突规则明确 |
| 分发 skills/prompts/themes | Pi package manifest | 资源发现不进入业务代码 |

判断标准：

- **事件**适合“一件事发生了”，不适合共享状态。
- **注册表**适合“我提供一个能力”，必须定义 ID、重复注册和注销语义。
- **共享服务**适合“多个模块必须协调同一状态”，必须有唯一 owner。
- **直接 import**只适合同一包内部；feature 包之间不使用。

这套规则避免了两种常见混乱：用 event bus 做同步 RPC，或为每一对 feature 新增一个专用 bridge。

## 5. 对 HEPI 当前结构的判断

当前 `hepi-mono` 已经具备正确的主依赖方向：

```text
Pi host / upstream libraries
             ▲
             │
       @hheei/hepi-basics
             ▲
             │
   aggregate feature modules
```

已有边界：

- `hepi-basics` owns the foundation under `src/core`; product modules remain separate inside their owning aggregate.
- Each aggregate has one `pi.extensions` entry; internal feature modules do not publish separate entries.
- Feature modules use the shared `core` contracts and do not import another feature's private implementation.
- Cross-feature coordination goes through `core` contracts.
- [`package-boundaries.test.ts`](../../packages/hepi-basics/test/package-boundaries.test.ts) checks the aggregate workspace and entry contracts.

这些规则与上游方向一致。当前“乱”的主要来源不是包依赖图，而是四类责任还没有集中写清：

1. package entry 到底只负责组装什么；
2. session state 和外部资源由谁创建、谁清理；
3. cross-feature contract 应选 event、registry 还是 shared service；
4. `pi-basics` 哪些 export 是公共稳定契约，哪些只是内部实现。

### 5.1 已实施的第一步优化

Pi 为每个 extension 创建不同的 `ExtensionAPI` facade，但同一 runtime 的 facade 共享 `pi.events`。因此，跨 feature 状态不能用 `ExtensionAPI` 对象作为 identity。

Pi Basics 现在用共享 event bus 标识 runtime：

- `ToolActivationCoordinator` 在 Basics、Loadout、Ask 等 facade 之间共享；
- reload 时 coordinator 重新绑定当前 host actions，避免保留旧 API facade；
- Loadout skill/tool bridge 在不同 feature facade 之间共享；
- duplicate tool disable handler 明确抛错；
- 不同 event bus 的 Pi runtime 仍隔离；
- package boundary test 同时检查静态和动态 HEPI imports。

第一步修复保留了现有 API，没有新增通用 registry。第二轮 review 随后通过上游真实 `loadExtensions()` 复现了 module/settings process-level registry 的 `/reload` collision，以及 package removal 后的 stale contribution。Module/settings registration 因此返回 identity-checked disposer，feature 在 `session_start` 注册，并通过现有 lifecycle registry 在 `session_shutdown` 清理。Duplicate ID 仍是同一 active generation 内的错误。

后续 review 确认公开 `createAgentSession()` SDK 允许同一进程持有多个独立 runtime。这个 decision gate 已触发：live module/settings registry 现在按 `pi.events` identity 分片。全局对象只持有 runtime identity 到 registry 的 `WeakMap`，用于重复 package copy 互操作；实际 contribution 不再跨 runtime 共享。该修复没有引入通用 owner-token framework。

## 6. HEPI 目标规则

### 6.1 每个 extension entry 都是包级 composition root

`pi.extensions` 指向的默认 export 只做组装：

1. 创建本包 feature objects。
2. 在 factory 阶段注册 tools、commands 和 runner-owned events。
3. 在 `session_start` 注册 module/settings contributions，并创建 session-scoped state/resources。
4. 在 `session_shutdown` 幂等清理 contributions 和 resources。

entry 不放 reducer、persistence parser、rendering algorithm 或 provider payload logic。这些留在本包内部文件。

### 6.2 保持单向依赖

允许：

```text
aggregate feature -> hepi-basics/src/core
aggregate feature -> upstream Pi package（确实需要原始能力时）
hepi-basics/src/core -> upstream Pi package
```

禁止：

```text
feature A -> feature B
pi-basics -> feature
shared core -> concrete feature
```

第二个真实消费者出现后，再把稳定、无 feature 语义的部分下沉到 `hepi-basics/src/core`。

### 6.3 给 cross-feature contract 指定 owner

每个共享 contract 应记录：

- contract owner；
- producer 和 consumer；
- 注册时机；
- duplicate ID 行为；
- collaborator 未加载时行为；
- session replacement/reload 后是否仍有效；
- cleanup owner；
- sync、async、错误和 cancellation 语义。

当前 `ToolActivationCoordinator` 和 Loadout bridge 应按此格式集中登记。不要立刻重写；先让隐含规则可见。

### 6.4 区分 host lifecycle 与 feature lifecycle

使用边界：

- 单次、无状态通知：可直接 `pi.on()`。
- 创建 session state、UI、timer、watcher、process 或异步 operation：使用 `HepiLifecycleController`，并向 runtime registry 注册 cleanup。
- cleanup 必须幂等；start 失败也必须清理已创建资源。
- 不把 `ExtensionContext`、AbortController、component 或 session object 保存到 process-global state。

### 6.5 把 `hepi-basics/src/core` export 当作稳定 API

aggregate feature 继续只从 core 的公开入口导入。新增 export 前检查：

1. 是否至少有一个明确 consumer；
2. 是否不包含具体 feature 语义；
3. owner 和 lifecycle 是否明确；
4. 能否用上游 `ExtensionAPI` / `pi.events` / TUI primitive 直接完成；
5. 是否需要 boundary test。

内部目录结构仍不是外部 API。aggregate feature 通过 `core/index.ts` 的公开入口导入，不使用 core 的深路径。

## 7. 推荐整理顺序

### P0：先补可见边界，不改架构

- 用本文作为总架构入口。
- 在 `docs/development/pi-basics.md` 维护 cross-feature contract inventory。
- 为每个 contract 写 owner、consumer、lifecycle 和缺席行为。
- 给新增 package 评审使用第 8 节 checklist。

### P1：统一 entry 和 lifecycle 形状

逐包整理，不做全仓同时重写：

- entry 只注册和组装；
- session resource 进入 lifecycle；
- cleanup 幂等；
- late async result 使用 session/revision guard；
- reload 后不使用旧 context。

只在修改某个 feature 时顺手收敛该包。

### P2：只提取已经重复的稳定机制

当至少两个 feature 出现相同需求时，优先顺序是：

1. 复用上游 API；
2. 复用已有 `pi-basics` primitive；
3. 增加一个窄 contract；
4. 最后才增加新 registry 或 shared service。

不要建立“通用 module framework”覆盖所有 feature。上游的成功点正是不同扩展轴使用不同小契约，而不是一个万能抽象。

### P3：让约束可执行

保留现有 package boundary test，再按真实风险补窄测试：

- duplicate registration；
- collaborator 未加载；
- repeated shutdown；
- reload/session replacement 后 stale operation；
- registration cleanup；
- event middleware 顺序，仅在顺序属于公共契约时测试。

## 8. 新模块设计 checklist

新增或整理模块前回答：

- 这是独立 feature，还是 foundation mechanism？
- 能否直接使用上游 `ExtensionAPI`？
- package entry 是否只是 composition root？
- 是否出现 feature-to-feature import？
- 协作语义是 event、capability registration 还是 shared state？
- shared state 的唯一 owner 是谁？
- state 属于 process、session 还是单次 operation？
- session switch/reload 时谁 abort 和 cleanup？
- collaborator 不存在时是 no-op、降级还是报错？
- public contract 是否比实现更窄？
- 是否只导出了真实 consumer 需要的 symbol？
- 最小 boundary test 是什么？

若这些问题不能明确回答，先不要增加共享抽象。

## 9. 不应照搬的部分

上游架构适合借鉴原则，不适合复制规模：

- HEPI 不需要再造一套 `ExtensionAPI`；Pi 已经提供。
- HEPI 不需要自己的 resource/package loader；Pi 已经提供。
- HEPI 不需要复制 `Models`、provider registry 或 agent loop。
- HEPI 不需要把所有 feature 塞回 `pi-basics` 以获得“统一”。
- HEPI 不需要为未来可能出现的协作预建 event、registry 或 bridge。

最小正确方向是保留现有 `feature -> pi-basics -> Pi` 单向结构，把 composition、lifecycle 和 cross-feature contract 规则补全，并在实际修改 feature 时逐步收敛。

## 10. 参考源码

- [`pi-ai/src/models.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/ai/src/models.ts)
- [`pi-ai/src/types.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/ai/src/types.ts)
- [`pi-agent-core/src/agent.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/agent/src/agent.ts)
- [`pi-agent-core/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/agent/src/agent-loop.ts)
- [`pi-agent-core/src/types.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/agent/src/types.ts)
- [`pi-tui/src/index.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/tui/src/index.ts)
- [`pi-coding-agent extensions`](https://github.com/earendil-works/pi/tree/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/extensions)
- [`agent-session-services.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/agent-session-services.ts)
- [`agent-session-runtime.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/agent-session-runtime.ts)
- [`resource-loader.ts`](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/resource-loader.ts)
