# 02｜设计原则落地

## 目标

把 terminal-native 设计原则转成可检查的代码约束，而不是只留在视觉描述里。

## 必须遵守

- 使用单线圆角 Unicode 边框：`╭ ╮ ╰ ╯ ─ │`；列表本身不加外框。
- 不使用阴影、渐层、大面积背景或 GUI 式 widget 堆叠。
- Active/selected/edit 状态同时由结构、indicator、文字或按键提示表达，不能只靠颜色。
- 所有布局按 terminal cell 宽度计算；禁止使用 `string.length` 做对齐或截断判断。
- UI component 只返回 Pi TUI 所需的 `string[]`，不得直接写 stdout。
- domain state、UI state、storage state 分离；异步保存不得把 storage promise 当作 UI state。
- module 之间只使用公开 contract，不读取其他 module 的 mutable state。

## 任务步骤

1. 阅读 `docs/tui_design_language.md` 和 `docs/pi-tui-rendering-and-extension-customization.md`，确认 Pi Component、`render(width)`、`handleInput()`、`invalidate()` 约束。
2. 在 `src/ui/text.ts` 集中实现/复用 `visibleWidth`、`truncateToWidth`、`wrap`、水平 viewport；所有 renderer 通过这些 helper。
3. 在 renderer 测试中加入 ANSI、宽字符、组合字符和窄终端案例。
4. 检查 component 没有 `process.stdout`、`console.log` 等终端直写。
5. 让无色彩输出仍能区分 active、selected、edit、error。

## 验收

- 任意 `render(width)` 行的可见宽度不超过 `width`。
- 宽字符图示 `⚙`、`⏣`、`→`、`↑`、`↓` 的宽度由实际 width helper 验证，不按 JS 字符数猜测。
- 低宽度下 UI 仍有可读 key、value、footer；提示按优先级移除而不是溢出。
- 测试失败时能定位到 width、wrap、viewport 或状态语义，而不是只比较 ANSI snapshot。

## 非目标

本任务不实现 Settings domain、storage 或 Pi command；只建立所有 UI 任务必须遵守的规则和 helper 边界。
