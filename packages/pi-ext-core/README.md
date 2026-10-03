# @hheei/pi-ext-core

`@hheei/pi-ext-core` 为独立 `pi-<name>` extension 提供 session lifecycle、Service Registry、
ExtensionPoint、TaskRegistry、BackgroundDelivery 和 cleanup primitives。它不是 Pi extension，不声明
`pi.extensions`；导入本包没有 Pi runtime 副作用。

## 子路径与优化

需要在 worker 或子进程里用 error shaping helper 时，导入 `@hheei/pi-ext-core/errors` 子路径：它只带 error helper，不会把整套 ext-core 模块图载入新线程（每次新线程载入桶入口实测约 220ms）。

## 核心机制

- **Service Registry (`provideService` / `getService`)**: 提供轻量、强类型的跨扩展服务注册中心。服务按 `ExtensionAPI` 隔离，生命周期随 session 自动绑定，支持安全的服务发现与能力解耦（例如 `pi-ext-addon` 的 `session-recovery-guard` 消费 `pi-ext-memory` 的压缩服务）。
- **TaskRegistry**: 统一的任务注册与生命周期管理中心。为后台 Bash 任务和 Subagent 任务提供统一的 ID 分配、状态机追踪与结算机制，支撑上层统一的 `wait_tasks` 命令。
- **BackgroundDelivery**: 提供 session-runtime 内的完成门控与单次唤醒协调。具体 extension 注册活动计数源和交付通道，保留各自的结果队列、消息、紧急原因（如 blocker 立即唤醒）、分支规则与交付确认。
- **Loadout & Settings Router**: 为 `@hheei/pi-settings` 提供多页面设置注册与状态同步基础设施。

完整架构与组合语义见仓库的
[`docs/architecture/pi-ext-core.md`](../../docs/architecture/pi-ext-core.md)；维护与 consumer
开发约定见 [`docs/development/pi-ext-core.md`](../../docs/development/pi-ext-core.md)。
