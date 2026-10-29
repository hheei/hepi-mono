# 01：恢复 notice 自身展开语义

**依赖：** 无。**状态：** 实现完成（未提交、未发布，待 08 运行验收）。**来源：** 排查第 1 节。

## 发生点与交付

NotifyView.member 无条件 detail；#renderNotices 重复 summary/detail；noticeMember 把 hasDetail 当 expandable。修复完整 notice 分类路径，不按 om 字符串做特例。

已落地：`NotifyView` 拥有自己的缩进、换行和语义色内容行，分类只绘制这些行一次；`MessageView` 提供 `previewRows`/`bodyRows`，preview 直接可见，只有真实 body 才产生 `detail` 和 pin；分组仅按 `expandable` 判断可展开，并保留单选中互斥。

## 验收条件

- [x] 输入普通 notify(info) 内容“om: observer running on 2.7K tokens chunk”，展开 notice 分类后正文出现一次，左侧缩进，无子箭头；点击不生成重复正文。
- [x] warning/error 同样不生成假展开，保留状态文字及语义颜色；多行/长行按可用宽度显示。
- [x] header-only MessageView 无子展开；preview-only 直接显示 preview，不以其存在制造新展开层。
- [x] 有真实 body 的 MessageView 可展开，header/preview/body 各出现一次；可展开 notice 之间互斥，收起分类后不遗留选中项。
- [x] 不丢失原 notice 的内容与交互，不新增 summary/body 相等比较等猜测规则；普通 notice 没有虚假的 item hit。
- [x] 替换旧 preview-only 必须有箭头的测试，同时覆盖组内/组外一致性与 30/80/120 列。

## 边界与验证

正文布局归 notice，分类/互斥归分组。优先限定 pi-ext-ui 内；公共 MessageViewSpec 改动需先说明理由。

验证（2026-10-29）：

- `pnpm exec vitest run packages/pi-ext-ui/test/host-transcript-patch.test.ts`：68 passed（含新增 notice 用例）。
- `pnpm exec vitest run packages/pi-ext-ui/test packages/pi-python-eval/test packages/pi-ext-core/test`：426 passed。
- `pnpm --filter @hheei/pi-ext-ui run build`：通过。
- `pnpm run typecheck`：通过（跨包 ToolPresentationChild 字段删除）。
- `pnpm exec vitest run -c vitest.integration.config.ts packages/pi-ext-ui/test-integration`：3 passed（regular/fullscreen，真实 bundled CLI）。
- 改动文件 Biome：通过。
- 未执行：herdr 手工点击逐项验收（08 范围）；本票未新增持久化或公共 MessageViewSpec 字段。
