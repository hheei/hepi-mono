# 软件包清单

本页按用途区分独立扩展与共享基础包。包名、扩展入口和发布限制以各包 `package.json` 为准；
公开包仍可能处于开发中，此清单不代表 npm 上已有对应版本。

## 独立扩展

这些包使用 `@hheei` 作用域，各自声明一个 `pi.extensions` 入口。
它们依赖 Pi host 和 `@hheei/pi-ext-core`；额外兼容性要求见对应 README。

| 软件包 | 用途 |
| --- | --- |
| [`pi-ext-tools`](../../packages/pi-ext-tools/README.md) | Pi 编码工具替换、Todo 与 FFF 搜索增强 |
| [`pi-settings`](../../packages/pi-settings/README.md) | `/ext-settings` 界面与 Loadout 工具、技能和资源启用策略 |
| [`pi-ext-addon`](../../packages/pi-ext-addon/README.md) | Pi host 扩展集合（`$skill-name` 自动补全、Auto Title 自动会话标题等 opt-in 功能） |
| [`pi-optimizer`](../../packages/pi-optimizer/README.md) | 繁转简、Caveman/Ponytail 提示词、可选 RTK 与 `/optimizer` 设置 |
| [`pi-status`](../../packages/pi-status/README.md) | 会话响应遥测展示 |
| [`pi-debug`](../../packages/pi-debug/README.md) | 开发诊断与确定性 TUI 回放 |
| [`pi-mctx`](../../packages/pi-mctx/README.md) | Magic Context：context window、historian、compaction 与 session history |
| [`pi-hindsight`](../../packages/pi-hindsight/README.md) | Hindsight-backed 长期记忆与 memory lifecycle，仍在开发中 |
| [`pi-subagents`](../../packages/pi-subagents/README.md) | 独立后台 Pi 子代理会话，仍在开发中 |

## 共享基础包

`@hheei/pi-ext-core` 提供生命周期、协调与共享 UI 原语，是扩展的生产依赖，
不声明 Pi 扩展入口，不应作为独立功能通过 `pi install` 加载。
维护约定见 [ext-core 开发指南](../development/pi-ext-core.md)。


## 文档分工

- 软件包 README：安装与兼容性。
- `docs/`：跨包使用、架构与贡献规则。
- 源码旁的注释和类型：详细 TypeScript API 与实现契约。
