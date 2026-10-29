# 02：thinking 预览有内容，展开遵循隐藏设置

**依赖：** 无；子项粒度跟随 00 最终决策。**状态：** 实现完成（未提交、未发布；子项仍按 assistant message 粒度，待 00 定稿）。
**来源：** 排查第 2 节。

## 发生点与交付

rebuild 在 hidden=true 丢正文；#renderThinking 仍提供空展开；preview 取整首行。保留内容与展示偏好，完成两种设置的端到端行为。

已落地：投影始终保留 thinking 原文（多段以空行连接），只额外记录 `thinkingHidden`；隐藏时条目为标签 + 最多 20 grapheme 的内容预览（超出加省略号，再按剩余单元格 truncate），点预览或标签打开换行全文；可见时分类直接平铺全文、无子项箭头。预览与正文统一 `thinkingText` + `italic`。

## 验收条件

- [x] hide-thinking-block=true：分类展开后子项显示真实内容预览，目标上限 20 个 grapheme，再按剩余单元格宽度 truncate；非空后续内容用省略号表达，不以 token 标签代替内容。
- [x] 点击预览显示完整正文并换行；展开第二项收起第一项；再次点击当前项收起。
- [x] hide-thinking-block=false：分类展开直接平铺全文，无子项箭头或单独展开动作。
- [x] 正文和预览统一 thinkingText + italic；段落分隔保留；空 thinking 不生成可点击空行。
- [x] 切换设置和重绘不会遗失正文；不修改持久化 message 来存 UI 展开状态。
- [x] 中文、emoji、多段 thinking 与 30/80/120 列行为正确；点击命中与文本换行后的行高一致。
- [x] 替换“hidden=true 点击后仍无正文”的旧断言；新增两个不同内容的子项互斥断言，不只检查箭头。

## 验证

验证（2026-10-29）：

- `pnpm exec vitest run packages/pi-ext-ui/test/host-transcript-patch.test.ts`：68 passed（新增隐藏预览/互斥/平铺/emoji/CJK/设置切换用例）。
- `pnpm exec vitest run packages/pi-ext-ui/test packages/pi-python-eval/test packages/pi-ext-core/test`：426 passed。
- `pnpm --filter @hheei/pi-ext-ui run build`：通过。
- `pnpm run typecheck`：通过。
- `pnpm exec vitest run -c vitest.integration.config.ts packages/pi-ext-ui/test-integration`：3 passed（真实 host 投影与 Ctrl+O 路径）。
- 改动文件 Biome：通过。
- 未执行：herdr 手工验收（08 范围）。
- 已知限制：子项粒度仍是 assistant message（多段以空行分隔），不是 00 建议的 thinking run；未修改 Pi host、未新增 hook。
