# 鼠标与局部文本选择 core 例外

`@hheei/pi-ext-core` 获准在尚未有两个真实产品 consumer 前，提供完整的 terminal mouse 与局部文本 selection contract。这是对 shared-core promotion threshold 的第六个、明确受限的例外；`pi-ext-core` focused tests 与 `tui-replay` fixture 只负责验证 transport、dispatch、capture 和 cleanup，不冒充产品 consumer。

## 考虑过的方案

- 等待两个独立 extension 产生相同需求后再提升 shared contract。
- 先把实现放进单一 extension，出现第二个真实 consumer 后再抽取。

## 后果

这项例外只批准 feature-neutral 的 terminal input、region dispatch 与 local selection contract，不批准页面内容、clipboard policy、跨组件 selection、hover/click 手势或新的 TUI layout tree。tracking lease 期间，surface 暂时拥有 terminal mouse input，native selection 可能被抑制或改变；没有 active region 时恢复 Pi 默认行为。实现依赖 Pi TUI 已完成的 input sequence boundary，不读取 `process.stdin` 或建立第二个 buffer；region registry 只在 layout snapshot 更新时改变，不得由 `render(width)` 隐式修改。未来扩大 contract 仍需新的设计决定。
