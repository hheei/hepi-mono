# pi-ext-ui 渲染修正 Tickets

来源：[只读排查](../pi-ext-ui-rendering-audit.md)。本批取代旧 collapse-views tickets 的冲突行为，不修改旧票的历史完成记录。
状态：00 已定稿；01–07、09、10、12 已实现并随 0.7.0 发布（08 仍未验收）；本轮 0.7.1 补上尾项顶部对齐、原生 footer 字段、spinner 前导槽与原生 surface padding；08 是剩余验收票。

| 票 | 交付 | 依赖 | 状态 |
| --- | --- | --- | --- |
| [00](00-contract.md) | 尾部、统计和成组契约定稿 | 无 | 已定稿 |
| [01](01-notices.md) | 普通 notice 无假展开、无重复 | 无 | 实现完成，待 08 验收 |
| [02](02-thinking.md) | thinking 真实预览、全文及互斥 | 无 | 实现完成，待 08 验收 |
| [03](03-tool-ownership.md) | 原工具 Level 0、导轨和缩进 | 无 | 实现完成，待 08 验收 |
| [04](04-tail-footer.md) | 组外尾部、实时 footer、稳定迁移 | 00、03 | 实现完成，待 08 验收 |
| [05](05-raw-layout.md) | 完全展开间距与 footer | 01、02、04 | 实现完成，待 08 验收 |
| [06](06-semantic-colors.md) | 对齐原生 Pi 语义着色 | 01、02、03 | 实现完成，待 08 验收 |
| [07](07-full-command.md) | bash 完整命令与来源保真 | 03；持久化扩展需另确认 | 实现完成，待 08 验收 |
| [08](08-runtime-acceptance.md) | herdr、恢复、并行与防抖验收 | 01–07 | 阻塞 |
| [09](09-valid-tool-counts.md) | 未知工具排除统计、保留报错 | 03、解析事实确认 | 实现完成，待 08 验收 |
| [10](10-stable-live-metrics.md) | CH 保持、run 时间、完成后工具计数 | 01–03 | 实现完成（09 阻塞子项除外），待 08 验收 |
| [11](11-refresh-path-audit.md) | 点击 16ms、流式快照 100ms 路径审计 | 无；本次只记录 | 已记录，未实现 |
| [12](12-native-background-blocks.md) | 收起组整体背景与组级上下 rail、展开组透明 | 00、04、05 | 组外壳、组级 rail 与透明工具/thinking 实现完成，待 08 herdr 验收 |

## 共用完成条件

- [12 背景外壳](12-native-background-blocks.md)：收起态是背景块并由两条组级 rail 框住，整组展开后透明且无 rail；工具与 thinking 不填背景，notice 保留自身背景。05/08 按此验收。
- 每票交付完整可运行路径及聚焦回归测试，不以 helper、接口或截图替代行为完成。
- 仅改任务相关文件。实现前读 DESIGN_TS.md；UI 契约先同步 DESIGN.md 和 docs/architecture/pi-ext-ui-tool-groups.md。建议不等于已批准决策。
- 保留现有必要 transcript monkey patch，不修改 Pi host、不增加 host hooks；不引入延迟定时器、全局缓存或兼容 wrapper 掩盖布局问题。
- ANSI、Unicode 单元格宽度安全；新布局至少覆盖 30、80、120 列。正文换行，紧凑摘要可截断；copy 与完整内容入口保留。
- 每票记录实际验证命令及结果、未执行项。最低验证：改动文件 Biome、受影响测试、受影响 package build；公共契约/跨包 import/类型变化升级全仓 typecheck，范围不能可靠界定再升级全量 check。
- host 投影/生命周期路径变化追加真实集成测试；代码修改后运行 verify:changed 或 graphify update . 更新 AST。纯文档不跑 TypeScript/test。
- 验收未完成或关键决策未确认的票不能标 done；不顺手升版、commit、push 或发布。

## 推荐执行顺序

00 与 01–03 的检查可独立推进；先完成 notice/thinking/原工具展示，再做 04→05；06、07 收敛后做 08。共同修改 ToolGroupView 的票应顺序落地，避免并行编辑覆盖。
