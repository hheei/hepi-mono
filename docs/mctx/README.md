# pi-mctx

## 状态

已确认 package 骨架，尚未实现 Magic Context 行为。首版只建立独立、可安装的
`@hheei/pi-mctx` Pi extension；它不压缩上下文、不注册 tool、不写入持久化数据，也不改变
Pi session。

## 目的

`@hheei/pi-mctx` 将成为 HEPI 对父 Pi 会话进行上下文管理的唯一 owner。未来它可以维护摘要、
compartment 和父会话长期上下文，并为子代理提供经过父会话压缩的继承内容。

它不是现有 `@hheei/hepi-mctx` 的 adapter 或重命名。后者是对外部
`@hheei/pi-magic-context` 的 transitional wrapper；两个 package 在迁移期间独立安装和演进。

## 边界

### pi-mctx

- 未来拥有父会话的 MCTX state、压缩决策、compartment、持久化和取消。
- 未来在 `inherit_context` 请求中提供父会话已压缩的历史内容。
- 不拥有 child agent、model、tool、worktree 或 delivery policy。

### pi-subagents

- 拥有 child session 的创建、agent/model/tool/worktree policy 和 prompt 组装。
- child 默认使用 Pi 原生自动 compaction。
- child 不运行 MCTX historian、memory、note、持久化、状态或 MCTX tools。
- 未来只在 parent `pi-mctx` 可用时消费其继承内容；未安装或 provider 明确过期时，保留
  Pi 原生 branch inheritance。

### pi-ext-core

- 只提供 runtime-scoped lifecycle、cleanup 和 first-provider-wins `Service` 协调。
- 不认识 MCTX state、摘要格式、Pi branch shape 或 child prompt。
- 不为当前单一 consumer 预建 MCTX 专属 contract、opaque boundary 或 projection helper。

跨 package 的 future inheritance provider 使用 `@hheei/pi-ext-core` 既有 Service 发现机制。
provider 和 consumer 分别声明相同的 namespaced service ID，不互相 import。provider 负责从
当前 parent branch 取得自身所需的压缩前缀与 tail；`pi-subagents` 只把结果放入自己的 child prompt。

## Package 约定

`packages/pi-mctx` 的首版只包含一个 Pi extension entry。它直接依赖
`@hheei/pi-ext-core`，并以 Pi packages 为 peer dependency。它不得依赖：

- `@hheei/hepi-mctx`；
- `@hheei/pi-magic-context`；
- 任何 concrete HEPI extension。

没有 session resource 时，extension entry 不注册空 lifecycle。真正创建 resource 的功能必须通过
`registerExtensionLifecycle()` 取得 session-scoped owner，并将取消和 cleanup 注册到该 owner。

## 延后决策

- MCTX 摘要、memory、note、historian、检索、状态和持久化的具体行为；
- parent-to-child inheritance 的 service payload；
- child `mctx-lean` historian profile。只有 Pi 原生 compaction 在长任务中被证实不足时，才单独
  提出该 profile；它不应成为 child 默认行为；
- 现有 `@hheei/hepi-mctx` wrapper 的弃用或移除计划。

任何上述功能开始前，先更新本文档并完成 focused design discussion、测试设计和用户确认。
