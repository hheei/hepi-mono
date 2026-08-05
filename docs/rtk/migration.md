# RTK 迁移

## 目标

将冻结的 `@hheei/hepi-basics` 中 RTK rewrite 与输出压缩迁移为独立的 `@hheei/pi-rtk` Pi extension。用户继续通过 `/rtk` 与 settings 配置 RTK；Pi host 的 `bash` tool call 在 rewrite mode 下由 RTK 重写，tool result 可按配置压缩。

## 边界

- Pi host：拥有 tool event、command、session 与 UI。
- `pi-rtk`：拥有 RTK 配置、可执行文件探测、命令 rewrite、输出压缩、metrics 与 session 状态。
- ext-core：拥有 `registerExtensionLifecycle()`、settings registry 与 session cleanup；不拥有 RTK 配置或 rewrite policy。

## 生命周期

`pi-rtk` 在 Pi host `session_start` 加载配置并注册 session-scoped RTK 状态。一个 session 只允许一个 refresh owner；shutdown 或 reload abort refresh、清空 metrics、销毁 session state。RTK 缺失时按用户配置 block 或跳过，不影响其他 extension。

## 接口

包入口只导出 extension default、`RtkIntegrationConfig`、`RuntimeStatus` 与 RTK feature factory。settings 使用 ext-core JSON section storage；不依赖 `hepi-basics` 私有 registry。

## 迁移决策

先机械复制 `src/rtk/rtk/` 的领域实现和 focused tests，再把旧 `HepiLifecycleController`、旧 settings storage、旧 core import 替换为 ext-core 公共接口。旧 `hepi-basics` 保持冻结，不做兼容 adapter。
