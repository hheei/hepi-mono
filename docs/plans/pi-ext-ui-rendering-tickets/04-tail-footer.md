# 04：组外尾部与实时统计 footer

**依赖：** 00、03。**状态：** 实现完成，待 08 实机验收。**来源：** 排查第 6 节。

## 交付

在既有投影 seam 里区分组内成员与唯一组外尾项，footer 始终统计。不新增 host hook、不叠加第二套预览 renderer。

已确定并实现的内部契约（`ToolGroupView` / `Member` / `RequestFact`）：

- `Member.kind` 是 `"thinking" | "tool" | "notice"`；thinking 成员代表一个非空连续 run，`parts` 保存该 run 的原始 assistant 组件（渲染与身份都用第一个 `component`）。
- 请求事实不再挂在成员上，而是按 transcript 顺序进入 block 的 `requests: RequestFact[]`；`RequestFact = { usage?: Usage }`。因此正文/异常/仅 toolCall 的 assistant 请求也能归属到它结束的那个 block，而不需要一个可展示的成员。
- `update(members, tail, requests, run)`：`members` 只含组内项，`tail` 是组外尾项（也可为空），`requests` 含尾项事实。header calls、footer 统计与组底色按 `members + tail` 聚合，分类只遍历 `members`。
- 尾项由投影层决定：只有 transcript 结尾那段连续成员的最后一个可见单元留组外；非成员子节点（正文、user、图片、未知 renderer）本身就在组外，出现时旧尾项归组。空 assistant/toolCall 占位不是成员，也不成为尾项。
- 尾项直接使用原组件（thinking run 的多个原始 assistant 组件按顺序），由一个只做行归一化与鼠标转发的 `TailUnit` 包住，保证组与尾项之间恰好一个空行；不复制、不截首行、不改折叠层级。

## 验收条件

统计补充依据：[委派、用量与状态排查](../pi-ext-ui-delegation-usage-status-audit.md)。用户已明确 IN/OUT 必须是显示 requests 所对应全部请求的 Pi 原生字段累加；不是最后请求或均值。

- [x] 给定 8 个确定请求，requests=8、IN=sum(input)、OUT=sum(output)，先断言未格式化整数，再断言紧凑显示；不把 cacheRead/cacheWrite 混入 IN。
- [x] 请求计数和用量来自同一事实集合，不受 eligible assistant 展示过滤影响；partial→final 不重复，正文/失败/缺 usage/工具附带 usage/恢复等来源有明确归属。
- [ ] 与 Pi 对照相同请求集合的字段加法（测试用 Pi 原生 usage 对象直接累加，未另跑 Pi 侧对照脚本；用户原 8 请求差额仍缺逐请求证据），不拿局部组与全会话比较；用户原 8 请求差额需逐请求证据，未取得则明确记录缺口。

- [x] 运行、完成、取消、断组时 footer 始终为 requests ×N · IN … · OUT … · CH …，只有一行，绝不切回“状态+工具名”。
- [x] 无 usage 时显示未知占位；新 usage 到达刷新真实值；同一请求的 partial/final 不重复计数；不根据字符数伪造 IN/OUT。
- [x] requests/IN/OUT/CH 与 header/classification counts 精确符合 00 的范围表，尾部迁移前后相同事实不增不减；不从下一 block 借用 usage。
- [x] 组外尾部按 00 确认模式显示；原组件模式下不复制、不截首行，不丢摘要、耗时、copy、错误正文或自身折叠。
- [x] footer 与尾部之间恰好一个空行；空占位不引入多余空行；无组时无孤立 footer。
- [x] 新可见单元到来旧尾部仅迁移一次；纯状态/时钟/usage 刷新不改变归属；并行完成顺序不重排尾部；agent_end 单独发生时不吞入尾项。
- [x] 保留 group/组件身份、分类选择与命中；迁移和统计在同一帧提交，不能经历先消失后重现。没有新防抖 timer 或永久空白占位。
- [x] 0/1/2/3 工具、通知插入、thinking→工具→正文、回合结束、断组和新回合符合 00 的确定示例；30/80/120 列 footer 不换行。

## 验证结果

- `node node_modules/@biomejs/biome/bin/biome check`（本单改动文件）：通过。
- `pnpm exec vitest run packages/pi-ext-ui/test/host-transcript-patch.test.ts`：111 passed。
- `pnpm exec vitest run packages/pi-ext-ui/test/message-view.test.ts`：6 passed（`MessageView` 现在自带 `customMessageBg` 块，断言改为 trimEnd 后比较内容）。
- `pnpm --filter @hheei/pi-ext-ui run build`：通过。
- `pnpm exec vitest run -c vitest.integration.config.ts packages/pi-ext-ui/test-integration/host-transcript-patch.test.ts`：3 passed。真实 host 帧显示：恢复历史 `read ×3` + 尾部 `▸ ✓ read`、运行中 `⋯ read`/`◐ read` 作为尾部、结束后尾部变为最后一条 notice、`agent_end` 后 `read ×6`。
- 未跑全仓 `pnpm test`/`typecheck`：同批另有 agent 正在改 `tool-view.ts`/`renderer.ts`，全仓门禁会被其未完成改动污染。

## 验证方式

改动文件 Biome；`pnpm exec vitest run packages/pi-ext-ui/test/host-transcript-patch.test.ts`；`pnpm --filter @hheei/pi-ext-ui run build`；`pnpm exec vitest run -c vitest.integration.config.ts packages/pi-ext-ui/test-integration/host-transcript-patch.test.ts`。

用渲染帧序列测试身份、成员归属与行数；真实内容增长允许变高，禁止把“最终截图一致”当成防抖通过。
