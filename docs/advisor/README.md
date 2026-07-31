# Advisor

`@hheei/pi-advisor` 在主 agent 的稳定节点审查近期证据，并按严重度反馈可操作问题。

## 边界

- 扩展拥有 evidence、节流、重确认、反馈去重和通知 policy。
- `@hheei/pi-ext-core` 提供生命周期资源清理、persistent conversation execution、child compact request 与 usage snapshot。
- Advisor 不持有 child-session lifecycle；它只按自己的 context budget policy 请求 core compact，并读取 usage snapshot。
- 当前源码仍在 `hepi-tools` package；独立 package migration 另行处理。

## 配置与故障

配置保存于全局 settings；运行时只在 session start 或 reload 应用。没有认证模型、review 超时或 child 失败时，Advisor 保持主 session 可用并报告自身错误状态。
