# 05：完全展开保留 footer 与原生块间距

**依赖：** 01、02、04。**状态：** 实现完成，待 08 实机验收。**来源：** 排查第 4、6 节。

## 交付

折叠/完全展开保留一致的 header/footer 契约，正文与背景外壳随状态切换；收起态有组级上下 rail，`#renderRaw` 不画组级 rail、不丢 footer。

- 收起态：`Box` 背景块内是 header、分类、footer 三部分，header 下与 footer 上各一条 `borderMuted` 组级 rail（见 [12](12-native-background-blocks.md)）；footer 在收起和展开两种形态下都在。
- 整组展开（标题点击或 Ctrl+O）：外层透明、无组级 rail，header 仍显示；每个成员按原组件输出，工具与 thinking run 不填自身背景，notice 保留 `MessageView` 自己的 `customMessageBg`。
- 相邻非空语义块之间恰好一个空行：原始成员统一剥掉组件自带的 leading 空行，再由组显式补一个；正文/thinking 内部空行原样保留。
- 组外尾项不在展开视图中重复出现（尾项本身在组外，raw 只渲染组内成员）。

## 验收条件

- [x] 点击组标题和 Ctrl+O 两入口均保留 header、一个实时 footer；收起态有组级上下 rail，整组展开后无 rail 且外层透明，独立块/组件背景符合 12 的定稿规则。
- [x] thinking、工具、notice 按原时间顺序展示，相邻非空语义块恰好一个空行；正文内部空行原样保留。
- [x] 空 assistant/无可见行不产生空白块；不重复叠加组件自带 leading Spacer。
- [x] 工具保留导轨、原组件交互和 copy；thinking/notice 遵循 01、02 以及 00 定稿的正文策略，不因 raw 分支重新退回空展开。
- [x] 组外尾部保持组外，不在完全展开中重复出现；footer 统计与聚合模式一致。
- [x] 关闭 Ctrl+O 返回收起聚合状态，清理组级局部选择；纯重绘不清选择。宽度变化后点击仍命中同一成员。
- [x] 同时覆盖运行/完成/取消、30/80/120 列及空行 hit 不触发邻接工具。

## 验证结果

- `pnpm exec vitest run packages/pi-ext-ui/test/host-transcript-patch.test.ts`：111 passed，覆盖展开视图无 rail、header/footer 保留、相邻块恰好一个空行、尾部不重复、Ctrl+O 往返、30/80/120 列 footer 单行。
- `pnpm --filter @hheei/pi-ext-ui run build`：通过。
- `pnpm exec vitest run -c vitest.integration.config.ts packages/pi-ext-ui/test-integration/host-transcript-patch.test.ts`：3 passed（真实 host 展开帧含 `DONE BODY` 与 `second line`）。
- 未验证：herdr 实机对照（归 08）。

## 验证方式

改动文件 Biome；`pnpm exec vitest run packages/pi-ext-ui/test`；`pnpm --filter @hheei/pi-ext-ui run build`；受影响 host 集成测试。
