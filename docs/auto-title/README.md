# 自动标题

`@hheei/pi-auto-title` 在首个稳定对话后生成简短、可检索的会话标题，也提供 `/auto-title` 手动重试。

当前实现仍暂驻 `@hheei/hepi-basics`。迁移完成后，该 package 将成为独立 Pi extension；本文描述迁移目标，
不把尚未发布的 package 当成当前安装方式。

## 边界

- 扩展拥有标题 prompt、模型选择、输入裁剪、标题校验、状态栏 shimmer 与重试时机。
- `@hheei/pi-ext-core` 提供 settings provider registration、生命周期资源清理与一次性 completion execution。
- 扩展不持有模型 Agent 或 child-session lifecycle。

## 迁移接口

extension 在 `registerExtensionLifecycle()` 的 `start(context)` 中：

1. 注册 core-owned settings provider，使用独立 `pi-auto-title` section 和 `auto-title` group；未安装 settings
   surface 时 provider registration 是无副作用 fallback。
2. 以相同真实 `ExtensionLifecycleContext` 配置 subagent coordinator，并把它传给 title completion adapter。
   不得手工构造 lifecycle-like object。
3. 用 core model selection field/options 从当前 `modelRegistry` 构造 provider；title 的模型、thinking 固定为
   `off`，prompt、标题校验、60 秒 deadline 和 shimmer 仍是 extension policy。
4. 将 settings unregistration、coordinator dispose、status cleanup 放入 lifecycle `resources`，使 reload 与
   session shutdown 幂等。

`hepi-basics` 迁移后不再 import、注册或持有 auto-title。它的 status rail 继续按稳定 key `auto-title` 显示
extension 已发布的 status，不建立反向 package dependency。

## 配置与故障

配置保存于全局 settings；新设置只在下一次 session start 或 reload 生效。没有可用认证模型或生成失败时，扩展显示通知且不改会话标题。
