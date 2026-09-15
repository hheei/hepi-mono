# 软件包清单

本页按用途区分独立扩展、共享基础包与仅供本地开发的包。
包名、扩展入口和发布限制以各包 `package.json` 为准；此清单不代表 npm 发布状态。

## 独立扩展

这些包使用 `@hheei` 作用域，各自声明一个 `pi.extensions` 入口。
它们依赖 Pi host 和 `@hheei/pi-ext-core`；额外兼容性要求见对应 README。

| 软件包 | 用途 |
| --- | --- |
| [`pi-ext-tools`](../../packages/pi-ext-tools/README.md) | Pi 编码工具替换、Todo 与 FFF 搜索增强；本地构建需要原生桥 |
| [`pi-settings`](../../packages/pi-settings/README.md) | `/ext-settings` 界面与 Loadout 工具、技能和资源启用策略 |
| [`pi-ext-addon`](../../packages/pi-ext-addon/README.md) | Pi host 兼容补充，目前提供 assistant/thinking 局部选择 |
| [`pi-dollar-skill`](../../packages/pi-dollar-skill/README.md) | `$skill-name` 自动补全与技能路径引用 |
| [`pi-t2s`](../../packages/pi-t2s/README.md) | 输入中的繁体中文转简体 |
| [`pi-auto-title`](../../packages/pi-auto-title/README.md) | 自动生成 Pi 会话标题 |
| [`pi-btw`](../../packages/pi-btw/README.md) | 围绕当前会话提出旁路问题 |
| [`pi-status`](../../packages/pi-status/README.md) | 会话响应遥测展示 |
| [`pi-debug`](../../packages/pi-debug/README.md) | 开发诊断与确定性 TUI 回放 |

## 共享基础包

`@hheei/pi-ext-core` 提供生命周期、协调与共享 UI 原语，是扩展的生产依赖，
不声明 Pi 扩展入口，不应作为独立功能通过 `pi install` 加载。
维护约定见 [ext-core 开发指南](../development/pi-ext-core.md)。

## 本地开发包

`@hheei/pi-mctx` 的 manifest 标记为 `private: true`，没有 `pi.extensions` 声明。
仓库启动器直接加载其 `src/index.ts`，不要将它当作已发布的独立扩展安装。
目标行为与迁移状态见 [pi-mctx 规格](../mctx/spec.md)和[实施 tickets](../mctx/tickets.md)。

## 文档分工

- 软件包 README：安装与兼容性。
- `docs/`：跨包使用、架构与贡献规则。
- 源码旁的注释和类型：详细 TypeScript API 与实现契约。
