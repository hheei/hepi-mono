# 薄 Subagent Extension 直接拥有 Provider Selection

## 状态

已撤回。`packages/pi-subagents-herdr`、`vendor/weshipwork-pi-herdr/`、以及当时作为当前契约的 architecture/design/reliability 文档已从仓库移除。下文保留当时的 Provider Selection / Herdr vendoring 决策原文，不再描述现行实现。ext-core 的 subagent execution contract 仍以 [Subagent 执行架构](../architecture/subagents.md) 与 [ADR 0004](0004-core-subagent-execution.md) 为准。

## 决策

新增一个薄的 concrete extension，统一拥有 model-facing subagent tools、agent policy 与 Provider Selection。它是 `@hheei/pi-ext-core` subagent execution contract 的获准 direct consumer。

第一阶段只实现 task leaf delegation：

- **Local Execution Provider** 复用 ext-core 已有的 resolved child-session factory、admission、取消、terminalization 与 delivery；
- **Herdr Execution Provider** 从仓库内完整保存的 `@weshipwork/pi-herdr@0.1.0` upstream snapshot 起步，通过 Herdr CLI 启动并观察独立 Pi child；不增加该 npm dependency，也不直接加载 snapshot 的 model-facing `herdr` tool；
- Provider Selection 在执行前完成并留下可观察记录；已经接受 prompt 的 Subagent Run 不会因失败而在另一个 Execution Provider 重跑；
- `auto` 只在 Herdr 尚不可用、且 child 尚未接受 prompt 时选择 Local Execution Provider；显式选择 Herdr 时 fail closed；
- 两个 Execution Provider 接收同一份由 extension 预先解析的 immutable agent/model/prompt/tool/resource policy，不借执行位置静默改换模型或 provider；
- Herdr 成功结果完成 harvest 与 delivery 后立即关闭 managed pane；失败 pane 在有界采证后默认关闭，关闭未确认时保留 pane ID 与警告。cancel 与 parent shutdown 执行明确、幂等的清理策略；
- 插件保持低常驻上下文：不注入常驻 system prompt，不默认展开 agent catalog，不增加大型 briefing；model-facing schema 只保留后台 task delegation、状态观察和取消所需的最小字段。Provider Selection、fallback reason、Subagent Run ID、pane ID 与 resolved model 在 tool result/UI 中明确显示。

失败 pane 无限保留的旧条目已被 #3 取代。验证见 `packages/pi-subagents-herdr/test/herdr-backend.test.ts`。

### `@weshipwork/pi-herdr` vendoring 边界

`@weshipwork/pi-herdr` 与研究初期查看的 `@andrewjacop/pi-herdr` 是不同实现。本仓库在 `vendor/weshipwork-pi-herdr/` 保存前者的完整 package snapshot，包括 extension entry、client、types、actions、rendering、state、package metadata、test、README 与 MIT license。这样未来可以评估其其他能力，而不依赖 npm、deep import 或届时已变化的 upstream。

snapshot 固定为 `WeShipWork/threeonefour` commit `4aa356b78581b62a19e1ea97e64584de4d0a07e1`（npm `@weshipwork/pi-herdr@0.1.0` 对应 `gitHead`），保持原文件内容，不参与 workspace build、Pi extension discovery 或发布。本 ADR 记录 upstream URL/revision，snapshot 根目录保留 WeShipWork 的 copyright 和完整 MIT permission notice。

完整保存不等于完整集成。实现时只把当前 contract 需要的代码移入 owning extension 并按本仓库 strict TypeScript、runtime validation、错误分类与 cancellation contract 整理；未使用的 vendored tool schema、prompt guidelines、renderer、alias store 和 workspace actions 不进入运行时、模型上下文或发布包。移入后成为本仓库自有实现，不保留 upstream-shaped adapter。

后续上游更新只通过人工审查后选择性移植，不做自动同步、双实现或兼容层。含有实质上游代码的 production 文件必须记录 upstream repository、commit、原文件路径与 MIT provenance；owning package 发布时保留相应 copyright 和 permission notice。

Herdr Execution Provider 第一阶段只在 `HERDR_ENV` 与 `HERDR_PANE_ID` 都存在，并且 `herdr --version` 与 `herdr agent list` probe 成功时可用；否则 `auto` 选择 Local Execution Provider。不能仅凭 binary 存在宣称可用，因为 pane/workspace contract 以当前 Herdr pane 为锚点。

## 不采用

- 不 fork、patch 或运行时依赖 `pi-subagents`；
- 不以 `pi-subagents-lite` 作为执行核心，也不兼容其内部 `AgentRecord`/`AgentSession` 布局；
- 不直接注册或发布 vendored `@weshipwork/pi-herdr` extension；snapshot 中未被当前 contract 采用的工具、schema、prompt guidelines、renderer、alias store 和通用 workspace UI actions 保持 inert；
- 不把 Herdr CLI、agent catalog、prompt policy 或 UI ownership 放进 ext-core；
- 不把第一阶段扩张成 conversation、resume、scheduler、FleetView 或持久化 supervisor。

## 渐进引入 pi-subagents-lite 能力

`pi-subagents-lite` 只作为交互与功能设计的参考，不作为兼容目标。后续能力必须逐项满足真实需求后加入，并沿当前 ownership 边界重新实现：

1. 先验证用户可观察 contract 与 context 成本；
2. 复用 ext-core 已有 lifecycle，而不是复制 manager/coordinator；
3. 同时适用于两个 Execution Provider，或明确声明 provider capability；
4. 每项能力独立增加 focused behavioral tests；
5. 不为未来可能引入的功能预留抽象、schema 字段或兼容层。

候选能力不构成承诺或路线图；其顺序由后续真实使用需求决定。

## 后果

该选择比基于 `pi-subagents-lite` 的 fork 更小，也避免 Herdr 独立进程与其 in-process `AgentSession` 假设冲突。完整 `@weshipwork/pi-herdr` snapshot 仅作为可审计的 upstream source 留在 `vendor/`；第一阶段运行时代码仍只吸收所需的 CLI execution、JSON/error parsing、abort 与 pane primitives。未采用代码不会被编译、加载或增加模型上下文，且没有 npm/deep-import 耦合。

在实现 Herdr Execution Provider 前，必须先为 ext-core 设计最小的 external task-operation contract，明确 admission、取消、terminal result、delivery、late settlement 与 parent shutdown；不能把 pane 伪装成 `AgentSession`，也不能绕过 root shared concurrency coordinator。

相关背景见 [pi-herdr 与 pi-subagents 组合研究](../research/pi-herdr-pi-subagents.md) 和 [Subagent 执行架构](../architecture/subagents.md)。
