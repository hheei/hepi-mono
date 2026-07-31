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
  [ADR 0001](../adr/0001-core-extension-page-shell.md) 与
  [ADR 0002](../adr/0002-core-loadout-contract.md) 与
  [ADR 0004](../adr/0004-core-subagent-execution.md) 是唯一已批准例外：Extension page router、
  Loadout tool registration contract 和 root-session-scoped subagent execution contract；它们不得
  扩张为 page content、Loadout policy、Settings persistence、agent/config/UI/delivery policy 或
  schema-driven framework。
- extension 将 core 作为 direct production dependency，并 externalize bundle；runtime state
  必须以 `pi.events` 为 identity，通过稳定 `Symbol.for` slot 跨重复 core module instance 共享。
- process-global state 只能保存 lazy registry；不得保留 `ExtensionContext`、component 或 session
  object。
- 新 Service 或 ExtensionPoint ID 使用稳定、namespaced string；provider 与 consumer 不互相
  import，只以相同 ID 和各自声明的 generic key 协作。

任何需要跨包共同演进的行为，先判断 Service 或 ExtensionPoint 是否足够。不能表达时，由实际
需求方暂时拥有低层兼容实现；不得预建通用 event bus、schema layer、RPC 或 execution framework。

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

1. 至少两个独立真实 consumers 已有相同需求；
2. 说明现有 API 为什么不足，以及新接口的生命周期、ownership、并发和性能成本；
3. 在实现前与用户达成明确共识，并更新架构提案。

单一 consumer 的专属优化保留在它自己的 package。出现真实重复后再提案；不以预测复用为理由
扩大 core。

已批准 ADR 的范围外仍适用该门槛。Loadout contract、Extension page router 与 Subagent execution
contract 是记录在 ADR 中的单 consumer 例外；第二个 consumer 出现前，不得在它们上继续抽取
generic policy、content model、worker framework 或 shared dependency。

## Loadout Contributor

所有 HEPI-owned non-native executable tool 必须在 extension composition root 使用 core 的 managed
Loadout registration，禁止直接调用 Pi tool registration API。`pi-loadout` 是强烈推荐 companion；
缺席时 core fallback 仅保留 Pi 默认 activation，不提供 inventory、conflict 或 persisted policy。

所有 tool registration 与 page registration 的 ID 必须稳定且 runtime 内唯一；重复 ID 是 programmer
error。每个 tool/page 的 priority、conflict、ownership、cancellation、cleanup 与 lazy cost 必须在
紧邻 TypeScript 注释中说明。完整 Loadout contract 见 [Loadout 架构](../architecture/loadout.md)。

## Subagent Consumer

subagent execution 只经 core public contract 启动。consumer 负责在调用前解析 agent/model/prompt/tool
policy，为每个 task 提供 finite soft `maxTurns` 与幂等 terminal delivery sink；不得把 `pi.events` 当作 core
RPC 或直接管理 child `AgentSession`。core 在 cap 发一次 wrap-up steer，固定五个 grace turns 后才 hard
abort；consumer 不得另加隐式 timeout/grace。sink 必须接受 abort 后不写旧 parent state；conversation
subscriber 必须声明 event kinds、接受 fixed-cap snapshot coalescing，且在其 lifecycle signal abort 后不得
保留 handle reference。

`pi-subagents` 也必须在每次 parent session start 配置 root active-turn cap。core 只接受一项 live
lifecycle configuration，且 runtime 校验值为 positive integer；另一 owner 是 collision error。不得把 cap
放进单 task spec、凭 load order 覆盖，或在 core 内加入 hidden default。

core 不提供 main-agent wait 或 result-polling surface。`pi-subagents` 保留 parent delivery adapter：
default queue、human/host explicit steer 与 all-terminal Task delivery group 都是该 package 的 policy，不能
下沉到 core execution contract。model-facing `agent` tool 只提供 conversation queue input，不能暴露 steer。
所有 delivery 必须以 operation ID、任务目的、terminal/partial state 和「先评估相关性再报告」包裹 child output；
不能直接注入 raw delayed result。

conversation consumer 必须在 create 时指定 finite soft `maxTurnsPerReply`，并在 send 时明确区分
parent-to-child `inputMode` 与 child-to-parent reply consumption。wait 只能观察本次 message sequence；
wait signal abort 后，adapter 必须 queue-deliver eventual reply，不得静默丢弃或取消 conversation。
create 同时提供 initial message 与同一 reply contract，不能启动没有 owner 的 initial prompt。

需要长会话 context control 的 consumer 只能调用 conversation handle 的 `compact()` 与 `usage()`；不得保留或
读取 raw `AgentSession`。`compact()` 仅在 handle idle 时可调用，consumer 负责决定 threshold；`usage()` 是
core-normalized readonly snapshot，不能作为 provider billing source。为这些能力新增测试时必须覆盖 running/
queued/terminal rejection、abort、usage 缺失字段归零和 parent shutdown 后不再发布 snapshot。

host/human steer 只打断 active child，随后优先于 queue；queue 和 steer 各自 FIFO，steer 不得隐式删除已接受
queue。sink 的同步 throw 与 rejected Promise 都必须由 core 捕捉、记录 `deliveryFailed` 并消化，不能成为
host-level unhandled rejection。subscriber implementation 必须固定 memory cap：terminal event 挤掉最旧的
coalescible snapshot，慢 callback 不得阻塞 child。

所有 execution adapter 的注释必须说明 parent session ownership、mode、shared-cap admission、
cancellation、delivery/retry policy、event backpressure 与 retention cost。完整 contract 见
[Subagent 执行架构](../architecture/subagents.md)。

## 变更清单

每次 core 或 consumer 变更前，确认：

1. 架构提案是否仍覆盖该行为；若否，先更新提案并达成共识。
2. ownership、cleanup、cancellation 和 late async result 是否在类型、注释与 focused test 中明确。
3. 高频路径是否记录成本模型；需要 benchmark 时是否具有可重复基线。
4. 新 abstraction 或 dependency 是否达到两个真实 consumers 与用户共识门槛。
5. 公开行为或安装方式改变时，是否更新 package README；本约定只在开发规则改变时更新。
