# 03：工具分类保留原工具 Level 0、导轨与缩进

**依赖：** 无。**状态：** 实现完成（未提交、未发布，待 08 运行验收）。**来源：** 排查第 3 节。

## 发生点与交付

#renderTools 把 children 当顶层展示；renderWithoutToolRails/outerRailDepth 隐式抑制导轨。删除重复渲染分支，把内容与交互归还原工具组件。

已落地：工具分类只绘制 `member.component` 自己的行并转发点击/copy；容器（`codemode`、`python_eval`）保留自己的 Level 0 看板；`children`/`childCount` 只参与有效调用与分类名称统计。删除 `renderWithoutToolRails`、模块级 `outerRailDepth`、child item 选择状态，以及只为手工子行存在的 `ToolViewChild.detail`/`ToolPresentationChild.detail` 数据路径。

## 验收条件

- [x] 一个容器含 3 个子调用：有效调用数按 3 而非 4；工具分类展开仍出现一个原容器，不由 group 拆为 3 个工具组件。
- [x] 无子调用工具计 1；childCount 大于有界 children 列表长度时，header 总数不缩水。分类名称统计与展示列表分离。
- [x] 首次打开分类显示各工具原有 Level 0，包括 codemode/python_eval 自己的容器内容；后续点击、copy、错误全文和局部折叠由原工具处理。
- [x] 每个工具箭头及左导轨前恰好一个空格；相邻工具一空行；窄屏不溢出，copy 与点击坐标不偏移。
- [x] 纯重绘/状态更新不强制重置工具折叠；group 不解析具体工具名称、不自行拼工具子行、不探测渲染文本猜布局。
- [x] 移除分组调用 renderWithoutToolRails；检查全部调用方后删除无用 outerRailDepth 机制与 child item 状态，不保留另一层恢复导轨 wrapper。
- [x] 覆盖普通工具、codemode、python_eval、运行中、失败、部分结果；测试断言原组件渲染/交互被保留，而不只断言输出包含工具名。

## 验证

验证（2026-10-29）：

- `pnpm exec vitest run packages/pi-ext-ui/test`：166 passed（含新增容器 Level 0/内边距/空行/copy/折叠保持/失败/部分结果用例）；
- `pnpm exec vitest run packages/pi-ext-ui/test packages/pi-python-eval/test packages/pi-ext-core/test`：426 passed。
- `pnpm --filter @hheei/pi-ext-ui run build`：通过。
- `pnpm run typecheck`：通过（删除跨包 `ToolPresentationChild.detail`，已核对消费者：renderer、python-eval presentation、相关测试）。
- `pnpm exec vitest run -c vitest.integration.config.ts packages/pi-ext-ui/test-integration`：3 passed（真实 bundled CLI 的聚合、统计与 Ctrl+O）。
- 改动文件 Biome：通过。
- 未执行：herdr 手工验收（08 范围）。
- 备注：`ToolViewChild.detail` 与 `ToolPresentationChild.detail` 的唯一消费者是本票删除的手工子行渲染；公共契约文档已同步。04 未实现。
