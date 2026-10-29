# 03: Thinking 与明确类型 Notice 的分类详情

**Spec:** [连续活动组 Spec](../../../docs/architecture/pi-ext-ui-tool-groups.md)；D4–D5；用户故事 9–14、26。

**What to build:** 用户在同一 block 的 Thinking/Notice 行查看独立 token 或类型统计，打开分类后逐项检查正文。分类来源明确，无正文启发式；与工具分类互斥，空分类不创建详情。

**Blocked by:** 01：连续工具 block 与不重置的回合时钟

**Status:** done — 已实现并通过聚焦验证。

## Delivered

- Thinking 行显示所有非空 thinking block 的 `ceil(字符和 / 4)` 估算；逐项一行，点开查看文本。
- 宿主隐藏思考（`hideThinkingBlock`）时只显示 token 统计，不暴露文本，也不修改全局偏好。
- Notice 按 MessageView 的 `header.kind` 精确聚合，未知 kind 原样保留；notify 按 info/warning/error 分类，两者键域不混用。
- 空分类保留一行零统计且不可展开；同时只打开一个分类、一个详情。


## Acceptance criteria

- [x] 固定 Tools、Thinking、Notice 三行分类与两条 rails，分类间恰好一个空行；空类零统计、不可展开。
- [x] Thinking 只汇总原始非空 thinking 文本长度，求和后除以 4 向上取整；不计 signature、正文、JSON 或 provider OUT。
- [x] 流式快照替换原项而非累加；assistant/block 身份稳定；隐藏思考策略不能经详情绕过，不修改全局 thinking 偏好。
- [x] MessageView 按 header.kind 精确聚合，未知 kind 原样保留；notify 仅 info/warning/error，来源键分域不碰撞。
- [x] 每条真实通知一项，更新不重复计数；不读正文/颜色猜类型，不读取 stateHolder 私有数据，不维护具体 extension 名单。
- [x] 展开分类逐项一行，再点查看对应思考或 Notice 原文；不新增分类子树、过滤器或 MessageViewSpec 公共字段。
- [x] 打开任一分类关闭其他分类，单项至多一个详情；不因流式重绘自动关闭有效选择。
- [x] 全文、warning/error 文字与状态语义保留；ANSI/Unicode、换行清洗、窄屏截断和主题变化均测试。

## Verification

改动 Biome、受影响 MessageView/host 投影测试及 UI package build；只在实际改到公共导出时升级根 typecheck。代码后更新 Graphify AST，记录命令及结果。

## Boundaries

本票可在 01 后与 02/04 并行；共同文件的合并冲突不是语义阻塞边，不为此虚构依赖。不得通过读取具体 extension 私有 data 来补子类型。
