# 自动标题

`@hheei/pi-ext-addon` 内置的自动标题能力在首个稳定对话后生成简短、可检索的会话标题，也提供 `/auto-title` 手动重试。此功能为 opt-in，預設關閉。

当前实现由 `@hheei/pi-ext-addon` 拥有；本文记录其 lifecycle、settings 与失败边界。

## 边界

- 扩展拥有标题 prompt、模型选择、输入裁剪、标题校验、静态状态提示与重试时机。
- `@hheei/pi-ext-core` 提供 settings provider registration、生命周期资源清理与一次性 completion execution。
- 扩展不持有模型 Agent 或 child-session lifecycle。

## 迁移接口

extension 在 `registerExtensionLifecycle()` 的 `start(context)` 中：

1. 注册 ext-core-owned settings provider，使用全局唯一的 `auto-title` group；该 group 直接写入
   `ext_settings.json` 顶层。未安装 settings surface 时 provider registration 是无副作用 fallback。
2. 以相同真实 `ExtensionLifecycleContext` 配置 subagent coordinator，并把它传给 title completion adapter。
   不得手工构造 lifecycle-like object。
3. 用 core model selection field/options 从当前 `modelRegistry` 构造 provider；title 的模型、thinking 固定为
   `off`，prompt、标题校验、60 秒 deadline 和 `Generating title` 状态提示仍是 extension policy。
4. 将 settings unregistration、coordinator dispose、status cleanup 放入 lifecycle `resources`，使 reload 与
   session shutdown 幂等。

extension 不注册 Loadout `agent` resource：Auto Title 不会出现在 Loadout 的 `Agents` group 里，
设置始终经 `/ext-settings` 显示。coordinator 只由 `auto-title` 的 enabled 开关门控——关闭时取消
当前标题任务并阻止新任务，重新启用后按已保存设置恢复。

自动标题不依赖其它 concrete extension；status rail 继续按稳定 key `auto-title` 显示 extension 已发布的
status，不建立反向 package dependency。

## 触发时机

Pi 在同一次 `session_start` emit 里**先**跑普通事件 handler，**后**跑本 extension 的 lifecycle `start`，
而 coordinator 只存在于后者。所以 `session_start` 只负责记录意图（`reason` 为 `startup` 或 `new`），
由 lifecycle `start` 在 coordinator 建好之后消费一次；直接在该 handler 里触发会因为 coordinator 还不存在
而静默失效。

标题任务只在**空闲**时启动，并且 `before_agent_start` 会取消进行中的标题工作，避免与正在跑的 turn 竞争：

- 新 session：`session_start` 记下意图，此时还没有对话内容，coordinator 等到第一个 turn settle（`agent_settled`）
  才生成标题。
- 已有内容的 session（如 resume）：不记录意图，不会主动生成。
- `/auto-title`：`force` 忽略「本次 session 已尝试过」和「已有标题」两个 guard；如果当前正有一个 turn 在跑，
  请求会保留到该 turn settle 时执行，并立刻用通知告知用户（否则用户只看到「什么都没发生」）。
- 取消：`before_agent_start`、`session_info_changed`（已有名字）、模型变更与 `dispose` 都会让进行中的任务作废，
  结果写回前用 revision 快照校验，避免把过期标题写进新 session。

## 配置与故障

配置保存于全局 `ext_settings.json`；新设置只在下一次 session start 或 reload 生效。没有可用认证模型或生成失败时，扩展显示通知且不改会话标题。
