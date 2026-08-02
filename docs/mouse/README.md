# Pi TUI 鼠标与局部文本选择

## 状态

这是已达成设计共识、尚未实现的 `@hheei/pi-ext-core` contract。它是 core promotion threshold 之外的受限例外，边界记录在 [ADR 0008](../adr/0008-mouse-selection-core-exception.md)。

## 目标

让独立 Pi extension 的 TUI surface 可以 opt in terminal mouse input 与单组件文本拖选，同时保持 upstream `Component` 接口不变。没有 extension 显式安装 support 时，core 不创建 listener、tracking mode、session state 或 render work。

## 所有权边界

- `pi-ext-core` 拥有 SGR mouse tracking 的启停、raw input listener、协议解码、规范化事件、region dispatch、capture 和 cleanup。
- surface owner 提供当前的 `TUI`、生命周期 `AbortSignal` 和 owner-scoped install handle；页面负责注册和移除自己的 region。
- 页面负责布局、滚动偏移、边框排除、cell 到内容位置的映射、selection 状态和 selected text。
- core 不修改 upstream `Component`，不递归遍历 component tree，不拥有页面内容、业务 selection policy 或 clipboard。

## Public Contract

实现只从 `@hheei/pi-ext-core` 根入口导出以下类型与函数；consumer 不得 deep-import 内部模块：

```ts
interface TerminalMouseEvent {
  kind: "down" | "drag" | "up";
  x: number;
  y: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

interface MouseRegion {
  hitTest(x: number, y: number): boolean;
  onMouseEvent?(event: TerminalMouseEvent): "handled" | "ignored" | void;
}

interface SelectableRegion extends MouseRegion {
  hitTestText(x: number, y: number): TextPosition | null;
  setSelection(selection: TextRange | null): void;
  getSelectedText(selection: TextRange): string;
}

interface MouseSupport {
  registerRegion(region: MouseRegion): () => void;
  registerSelectableRegion(region: SelectableRegion): () => void;
  dispose(): void;
}

function installMouseSupport(
  tui: TUI,
  options: { readonly signal: AbortSignal },
): MouseSupport;
```

`TextPosition` 是单一 selection content model 内的零基 `{ line, grapheme }`；`TextRange` 是半开 `[start, end)` 区间。terminal event 的 `x/y` 是当前 viewport 的零基 terminal cell 坐标，不是内容位置。

## 输入与 dispatch 语义

- 同一个 `TUI` 共用一个内部 dispatcher；每个 install handle 只拥有自己注册的 region，dispose 幂等。
- 第一个 region 注册时启用 SGR button-motion tracking；最后一个 region 移除时关闭。没有 active region 时不保留 tracking。
- tracking active 期间，所有已识别的 mouse sequence 都由 dispatcher 消费；未命中的事件不会进入 focused component 的 keyboard `handleInput()`。未识别的普通输入保持原样。
- 区域重叠时，后注册者优先。region 不要求来自可遍历的 component tree。
- `registerSelectableRegion()` 使用 region 的 `hitTest()` 选择目标，并用 `hitTestText()` 把
  terminal cell 转成内容位置；普通左键 gesture 驱动 `setSelection()`。其他按钮和 modifier
  仍只交给 region 的可选 `onMouseEvent()`。
- `down` 命中的 region 捕获同一次手势的 `drag/up`。指针离开该 region 后不改派给其他 region；页面保留最后一个有效的 text position，`up` 只结束 capture。
- 第一版只定义 `down`、`drag`、`up`，不定义 hover `move` 或派生 `click`。默认 selectable gesture 只响应无修饰左键；其他按钮与 modifier 仍交给自定义 region。
- SGR parser 是内部实现，不成为 public API。它必须处理 input chunk 分片和 mixed keyboard/mouse input，但不向 consumer 承诺 raw parser 语义。

## Selection 与 clipboard

core 只驱动 `setSelection()` 并允许页面通过 `getSelectedText()` 读取逻辑文本。`up` 不自动读 selection、不写 OSC 52、不访问系统 clipboard。页面或显式命令拥有复制动作及其安全和兼容性 policy。

## 缺席、取消与验证

未安装 support 时沿用 Pi 原生 input 行为；没有 region 时不启用 tracking。`AbortSignal`、owner disposer、surface close、Pi session shutdown 和 reload 都必须到达同一幂等 cleanup 路径。

focused tests 放在 `packages/pi-ext-core/test/`，覆盖 fragmented/mixed input、tracking reference count、owner isolation、overlap order、capture、abort、shutdown 和 stale disposer。可见 TUI 行为另用 `tui-replay` 在窄和宽 terminal 验证；现有 debug replay 只作测试 fixture，不是产品 consumer。
