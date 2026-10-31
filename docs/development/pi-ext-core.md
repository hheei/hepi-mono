# pi-ext-core 开发约定

## 适用范围

本约定适用于 `@hheei/pi-ext-core` 的维护者，以及直接依赖它的 `pi-<name>` extension
作者。它说明开发时如何落实已确认的架构取舍；公开接口和运行时语义以
[pi-ext-core 架构提案](../architecture/pi-ext-core.md) 为准。

[AGENTS.md](../../AGENTS.md) 仍定义仓库级 workflow、TypeScript 基线、focused test 与
commit 规则。本文件不复制那些规则，只记录 core 及其 consumers 的附加约定。

## 目标与取舍

core 的目标是以最小协调原语支持独立 extension 组合。未安装或未调用 core API 时，它不得
创建 Pi handler、timer、listener、session state 或 render work。

发生取舍时，按以下顺序决定：

1. 数据所有权明确、资源不泄漏、取消正确、并发无 race。
2. 已证实高频路径的延迟、allocation 和无关 dispatch 成本。
3. 最小、直接、易读的代码与 API。

不得以“性能”为由跳过 cleanup、`AbortSignal`、boundary validation 或 focused test。不得
以“简单”为由把共享可变 state、隐式加载顺序或 late async result 留给 caller 猜测。

## 代码中的设计说明

设计目的、取舍和关键约束必须与实现同一 commit 写入 TypeScript 注释。注释解释 **why**，
不重复类型、变量名或直观控制流已经表达的 **what**。

- 文件头注释：模块不变量、process-global state、跨 module instance 协调原因。
- 公开 API JSDoc：ownership、caller responsibility、cancellation、错误和性能语义。
- 关键代码块前：不能从类型推断的 ordering、cleanup、revision guard、reference sharing 或
  allocation decision。

公开 API、跨包协议，以及 lifecycle、并发或性能关键路径必须有这类注释。简单局部代码只在
没有注释会导致误读时添加。实现改变设计理由、成本或 ownership 时，必须同步更新注释；过期
注释与错误实现同等对待。

## Core 边界

- 根入口是唯一 public import surface；consumer 不得 deep import `src/` 模块。
- core 不导入 concrete extension，也不承载 feature-specific business state、event bus 或 RPC。
  已批准的受限例外由 [ADR 0001](../adr/0001-core-extension-page-shell.md)、
  [ADR 0007](../adr/0007-core-json-settings-substrate.md) 明确限定：分别是 Extension page router、
  extension JSON settings transport，以及纯 `ToolPresentation` 展示契约与 optional-tools prompt 段落。
  进程内 subagent coordinator 已删除；managed tool 与 Loadout resource registration 已删除。
  它们不得扩张为 page content、Loadout policy、feature schema/state、Settings UI、agent/config/UI/delivery
  policy、clipboard policy、Pi private API facade 或 schema-driven framework。
  共享后台交付的受限协调原语见 [后台任务契约](../architecture/background-tasks.md)：只协调
  consumer 提供的交付通道、父会话忙/闲边界与单次唤醒，不拥有消息内容、队列、紧急原因、
  分支规则、交付确认或生产者执行。
- extension 将 core 作为 direct production dependency，并 externalize bundle；runtime state
  必须以 `pi.events` 为 identity，通过稳定 `Symbol.for` slot 跨重复 core module instance 共享。
- process-global state 只能保存 lazy registry；不得保留 `ExtensionContext`、component 或 session
  object。
- 新 Service 或 ExtensionPoint ID 使用稳定、namespaced string；provider 与 consumer 不互相
  import，只以相同 ID 和各自声明的 generic key 协作。

任何需要跨包共同演进的行为，先判断 Service 或 ExtensionPoint 是否足够。不能表达时，由实际
需求方暂时拥有低层兼容实现；不得预建通用 event bus、schema layer、RPC 或 execution framework。

## 公开 API 选用指南

开发具体扩展（`pi-<name>`）时，遵循以下 API 匹配规则，优先复用已有的 core 原语：

- **生命周期与清理**：必须使用 `registerExtensionLifecycle`；所有异步任务、timer、订阅必须使用 `context.resources.add` 注册逆序清理，所有支持取消的操作必须透传 `context.signal`。
- **跨扩展能力共享**：单一独占能力使用 `provideService` / `getService`（或异步 `waitForService`）；多对一挂载与观察使用 `registerExtensionHook` / `openExtensionPoint`。
- **后台执行状态**：由具体 extension 的执行模块拥有 ID、状态、取消、容量与恢复；BashJobs 管命令，SubagentManager 管 child conversation，不建立通用 TaskRegistry 或相互镜像。
- **异步结果向主会话投递**：使用 `createBackgroundDelivery` / `getBackgroundDelivery`，禁止扩展内部直接启动定时器轮询主会话忙闲。
- **工具注册与装配**：工具一律使用 Pi 原生 `pi.registerTool`；需要按需发现的工具声明 `exposure: "deferred"` 与 `defaultActive: false`，激活与 inventory 策略由 `pi-loadout` 拥有。deferred 工具族的介绍文字用 `setOptionalToolBullet` 写入结构化 prompt 的 `optional_tools` 段落。
- **工具展示**：内容语义用 `createToolPresentationRenderers` 提供 `ToolPresentation`；加载 `@hheei/pi-ext-ui` 时由 ToolView 负责折叠与交互，未加载时同一函数给出 Pi 原生 Text 渲染。
- **全屏或弹出式 UI**：使用 `openTuiSurface` 或 `openExtensionPageRouter`，不得在扩展内自行监听原始键盘事件打断 Pi 渲染循环。
- **编辑器附着组件**：使用 `registerWidget` 挂载编辑器上下组件；需要临时隐藏全部挂件时调用 `suspendWidgets`。
- **持久化配置**：必须使用 `readJsonSettingsSection` / `readMergedJsonSettingsSection` / `updateJsonSettingsRoot`，配置统一落盘至 `ext_settings.json`，严禁写入 Pi 原生 `settings.json`。
- **错误提取与取消**：跨不可信或未知边界提取异常字符串必须使用 `errorMessage`；取消一律使用 `abortError` 或 `throwIfAborted`。

## Lifecycle 与异步所有权

- 每个 feature 以 extension package name 注册 lifecycle，并把它创建的资源放入
  `context.resources`。
- cleanup 必须幂等，且能安全重复执行；failed start 和 `session_shutdown` 都必须释放资源。
- 所有可取消 async work 传入 `context.signal`。session replacement 后可能返回的结果，以 signal
  或 revision guard 拒绝；不能更新旧 runtime。
- `start()` 不得直接 `await waitForService()`。Pi 串行处理 `session_start`；consumer 使用
  `void waitForService(...).then(...).catch(...)` continuation，且自行处理失败路径。
- Service provider 不自行中途移除 value；由 lifecycle cleanup 管理。重复 provider 接受
  first-provider-wins 的 `false`，不替换现有 provider。
- ExtensionPoint owner 必须使用 lifecycle signal。hook owner callback 可能异步失败；caller 必须
  await/catch `ready`，即使 core 已抑制 host-level unhandled rejection。

## 高频路径

core 不拥有业务执行 hot path。需要高吞吐 dispatch 的 extension owner 负责其 context、topic
index、mount state 和 output buffer，并遵循架构提案的零拷贝与固定 shape 约定。

改动已知高频路径时，在设计文档或紧邻代码的注释中明确记录：

- 每次操作新增的 allocation、clone/spread 或 I/O；
- 触发的 hook dispatch 数量及其筛选方式；
- reference 的 owner、允许写入者和生命周期；
- 为什么该实现比直接标准库方案更必要。

只有已有可重复基线，或变更有明确性能回归风险时，才增加 benchmark。benchmark 不替代行为、
ownership 或 cancellation test；没有上述条件时，以 focused behavior test 加成本说明为准。

## 简洁与提升门槛

优先复用现有 core API、标准库和平台能力。选择直接代码而非为未来预留的 helper、adapter、
factory、dependency 或 generic framework。

要向 core 提升新 primitive、shared abstraction 或 shared dependency，必须同时满足：

1. 它提供明确的跨 extension 价值，且 API 保持 feature-neutral；不得把某个 concrete
   extension 的 policy、业务 state、schema 或 UI 下沉到 core；
2. 说明现有 API 为什么不足，以及新接口的生命周期、ownership、并发和性能成本；
3. 在实现前与用户达成明确共识，并更新架构提案，记录它为中间层提供的使用范围。

consumer 数量不是硬门槛：一个有实际中间层价值、可由其他 extension 直接消费的中性 API 可以
先于第二个 consumer 提升。单一 feature 的专属优化、预测复用、业务 policy 或 content model 仍保留在
该 feature package；不以“未来可能共享”为理由扩大 core。

已批准 ADR 的范围外仍适用上述价值与中性边界。Extension page router、JSON settings transport 与
`ToolPresentation` 契约不能借此继续抽取 generic policy、content model、worker framework 或 shared dependency。
不要把已删除的 subagent coordinator、managed tool registration 或 Loadout resource registration 加回来。

## Tool Contributor

所有 Pi-owned non-native executable tool 在 extension composition root 直接调用 `pi.registerTool`。需要按需发现的
工具声明 `exposure: "deferred"` 与 `defaultActive: false`，用 `setOptionalToolBullet` 把自己的条目写进结构化 prompt
的 `optional_tools` 段落。active 集合由 Pi host 的 `getActiveTools` / `setActiveTools` 决定，extension 不自行维护
第二份 activation policy。展示语义用 `createToolPresentationRenderers` 提供 `ToolPresentation`；加载 `pi-ext-ui` 时
由 ToolView 渲染，未加载时同一函数给出 Pi 原生 Text 渲染。

所有 page registration 的 ID 必须稳定且 runtime 内唯一；重复 ID 是 programmer error。每个 page 的 ownership、
cancellation、cleanup 与 lazy cost 必须在紧邻 TypeScript 注释中说明。完整 Loadout contract 见
[Loadout 架构](../architecture/loadout.md)。

## 子代理

ext-core 不再提供进程内 subagent coordinator。一次性模型补全留在调用方，直接使用 `completeSimple`。可重连 child session 只属于 `pi-subagents`，不要在 core 重建 completion、task 或 conversation handle。后台命令归 pi-ext-tools 的 BashJobs 所有，结果送回主会话仍用 `BackgroundDelivery`。见 [Subagent 执行架构](../architecture/subagents.md)。

## 变更清单

每次 core 或 consumer 变更前，确认：

1. 架构提案是否仍覆盖该行为；若否，先更新提案并达成共识。
2. ownership、cleanup、cancellation 和 late async result 是否在类型、注释与 focused test 中明确。
3. 高频路径是否记录成本模型；需要 benchmark 时是否具有可重复基线。
4. 新 abstraction 或 dependency 是否有明确中间层价值、保持 feature-neutral，并已取得用户共识。
5. 公开行为或安装方式改变时，是否更新 package README；本约定只在开发规则改变时更新。
