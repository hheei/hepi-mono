# 01: 连续工具 block 与不重置的回合时钟

**Spec:** [连续活动组 Spec](../../../docs/architecture/pi-ext-ui-tool-groups.md)；D1–D3、D6、D10；用户故事 1–6、18–19、26–28。

**What to build:** 用户在连续工具活动中看到新的 collapse views header、紧凑工具统计和只读尾行；正文或原生节点分开两段时，第二段沿用同一个 run 起点。先覆盖已有普通工具端到端路径，后续票扩充子调用、分类与结束态，不发布空壳协议或伪造指标。

**Blocked by:** None (can start immediately)

**Status:** done — 已在 pi-ext-ui 实现并通过聚焦验证。

## Acceptance criteria

- [x] 保留启用设置、至少两条顶层工具的成组门槛及未知 renderer/图片/异常的原生回退；不改变执行语义。
- [x] header 显示整个 block 的有效 calls，工具历史排除尾行；尾行仅状态 glyph＋名称，没有参数、看板、copy 或点击展开。
- [x] agent_start 开始、agent_end 冻结，h/m/s 格式符合 spec；多 turn、并行工具、原生断组均不重置或叠加时间。
- [x] 相同 run 的多个 block 共享起点但局部工具计数独立；重绘、resize、主题变化、Ctrl+O 不创建新 block 或 run。
- [x] 状态更新按工具稳定身份替换，尾行按开始顺序而非 partial 抵达顺序选择；已结束工具不冒充仍运行。
- [x] 保留既有原始内容检查、copy 与 Ctrl+O 路径；只在明确交互切换时重置折叠，不在 render 时反复收起。
- [x] 基础取消、错误、session 清理与 runtime 隔离本票即成立；缺失历史时间显示未知。
- [x] 通过真实投影渲染测试复现“block A → 原生节点 → block B”，断言时钟连续及窄宽终端行宽安全。

## Delivered

- 活动 block 现在画 `collapse views · 用时 · N calls` header、上下两条横向 rails、一条工具统计行（历史工具，排除尾行）与只读尾行（真实状态 glyph + 顶层工具名）。
- 回合时钟由 `agent_start` 开始、`agent_end` 冻结，使用 `performance.now()` 单调时钟；同一 run 的多个 block 共享起点，原生断组、resize、主题变化与 Ctrl+O 不重计时。缺少 run 的历史 block 显示 `—`。
- 点击 header 或工具统计行切换原始成员视图；原始视图沿用原组件、copy 与 Ctrl+O 路径。

## Interim gaps (后续 ticket)

- 工具统计行暂时直接切原始视图，尚无逐调用平铺列表（02）。
- Thinking 与 Notice 仍是各一行成员 summary，尚未合成分类行（03）。
- 原始视图仍是每成员一条 `▎` 轨道，尚未统一为两条横向 rails（05）。

## Verification

改动文件 Biome、受影响 UI 测试及 UI package build。若触及 host 投影驱动路径，运行对应真实 CLI/PTY 集成用例。记录实际命令、结果、未跑项；代码后更新 Graphify AST。

## Boundaries

不先新增 provider 公共契约、HTTP 计数或持久化。子调用全文与请求统计由后续端到端票完成；未覆盖来源保留既有可检查回退。
