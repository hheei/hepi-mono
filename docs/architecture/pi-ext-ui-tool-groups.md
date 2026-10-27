# pi-ext-ui 连续活动组

## 已确认的目标

用户批准集中、受限的运行时 monkey-patch，并要求扩大 patch 面前先确认。功能由 ext-core settings 的 `toolGroups.enabled` 控制，默认开启；设为 false 后当前 session 即停用。最低支持的 host 版本为 1.0.1；1.0.0 缺少 registerToolRenderer，明确不支持。仅作用于 TUI，不修改工具执行、session、模型上下文、磁盘上的 host 或滚动行为。

```text
▸ codemode ×2 · grep ×3
▎ ✓ read file.ts
▎ thinking…
▎ notify · indexed
▎ ◐ grep pattern
```

收起态不是纯计数，也不只保留最新一行：每个顶层工具各占一行 summary，每条有 thinking 的 assistant 轮次一行，每次通知一行。参数流式、运行中、partial、完成和错误更新原行，不增加计数。工具名按首次出现顺序计数，不计算通知或巢状工具。所有摘要 ANSI/单元格宽度安全，单行截断；全文保留在原元件中。thinking 摘要只显示标签，尊重原生思考内容的可见性。

## 控制流与 ownership

只使用两个已获批准的 prototype seam，集中在 src/host-transcript-patch.ts：

1. InteractiveMode.getRegisteredToolDefinition：始终调用原方法，发现实际 host，挂接其 transcript 展示投影。
2. InteractiveMode.showExtensionNotify：仅为已启用的所属 runtime 创建独立通知元件。原生连续 info status 会覆写旧内容，因此必须在入口保存每次通知；其他 runtime 或无法挂接时调用原方法。

现有 AssistantMessageComponent.lastMessage 读取同时用于 thinking 和工具身份，无新增 host 私有字段、事件处理器或 thinking patch。chatContainer.children 始终由 host 拥有；投影保留原元件引用，历史重播沿用同一路径。原生通知本来不持久化，本功能也不新增持久化。

```text
host transcript children
  ↓ 展示投影（保留原始节点）
纯工具/thinking assistant + 工具 + 独立通知 → 连续活动组
正文 / user / 未知元件 / 图片或未知工具 renderer → 原行、断组
  ↓
收起：计数 + 每项 summary；展开：原生布局 + 外层导轨
```

至少两次顶层工具调用才组成组。允许跨纯工具/thinking assistant 轮次延续；每次 thinking 轮次在原 transcript 位置出现。正文及异常 assistant 终态保持原展示，不隐藏错误提示。只接纳由 ToolView 提供语义摘要、且无直接图片输出的工具；允许 codemode、运行中、partial、告警与错误。未知 renderer 保持原行。参数或结果更新不改变组身份，追加成员保留局部展开状态。新 user、历史重建、分叉和 compaction 按原节点边界重建组，不持久化局部 UI 状态。

## 展开与交互

展开后使用原生工具、assistant 与通知元件布局及鼠标交互，外加一条组导轨。ToolView 在同步嵌入绘制作用域中省略自己的导轨，避免多重导轨；该模式参与绘制缓存和鼠标偏移，离开作用域立即恢复。工具的折叠、copy、巢状内容和原始状态继续由原元件拥有。组标题点击切换列表，Ctrl+O 强制显示原成员，关闭后恢复组的局部选择。fullscreen 支持鼠标；regular 使用 Ctrl+O。

## 生命周期与回退

按 ExtensionContext.ui 与 runner.getUIContext() 的对象身份隔离 runtime。共享的两处 prototype hook 保留原 descriptor，挂接只由当前模块代际的 owner 执行；reload 通过已知实例弱引用重新挂接。安装先检查两个 seam，避免半安装。session_shutdown/reload 幂等清理并恢复仍由本功能持有的方法；其他 extension 覆盖时不反向覆盖，停用 wrapper 并提示重启。

版本必须至少为 1.0.1，运行时仍检查 descriptor、参数数量与实例结构。未知结构停用该实例的分组并保留原行，诊断通知不能递归。原 host lookup 与实际 renderer 的异常继续传播。HTML export、RPC、print 不安装投影。

## 低版本 SDK 边界

pi-ext-ui 的既有 ToolRenderContext 别名明确声明可缺省的 durationMs/outputPad；老 host 缺失时沿用已有的无时长/零 padding 行为，不补造数据。read 行范围由本地摘要格式化处理，避免依赖 Pi 1.3 才导出的 formatReadLineRange；数值、数值字符串、null 与非法范围保持既有语义。无新 host hook、依赖或版本适配器。ext-core 实现无需修改，仅放宽经过最低版本编译验证的 peer 范围。

## 验证

聚焦测试覆盖：每项 summary、流式参数、partial、并行工具、codemode、错误状态、跨轮次 thinking、连续通知不丢失、正文/user/未知节点边界、原生展开与子项鼠标/copy、窄宽布局、主题失效、历史重建、reload、多 runtime、冲突回退与两处 descriptor 恢复。使用官方 bundled CLI 的 PTY 测试验证发布文件的虚拟模块身份与 regular/fullscreen；逐版核对并执行可支持的 1.0.1–1.4.0 发佈产物。

实际执行命令与结果记录在本次最终报告。因 peer 范围和 ToolView 可见行为涉及公共边界，执行全仓 typecheck、受影响 package 测试/build，以及受影响的真实 CLI 集成测试；不默认执行全仓 test/check。图谱仅做 AST update。
