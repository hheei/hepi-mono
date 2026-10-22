# 渲染刷新节流（Render Repaint Throttling）

## 1. 目标

统一扩展层的 UI 刷新节奏，避免流式输出把每一段字节都变成一次整帧重建。目标是
**两层时间窗口**，而不是每个包各自发明私有节流：

| 层 | 窗口 | 归属 | 适用 |
|---|---|---|---|
| Host 帧合并 | 16ms（`TuiBase.MIN_RENDER_INTERVAL_MS`） | Pi host（`@earendil-works/pi-tui`） | 键盘输入、导航、离散状态变更 |
| 流式重绘 | 100ms（`STREAM_REPAINT_INTERVAL_MS`） | ext-core `createRenderThrottle` | 子进程/内核输出、进度事件、高频状态源 |

16ms 层不由扩展实现：扩展只调用 `requestRender()` / `setStatus()`，由 host 合帧。扩展
**禁止**在快路径上自建定时器窗口——那只会把 16ms 抖动成更长的延迟。

100ms 层的理由与帧率无关：流式输出到达速率远高于人眼可读速率，而每次重绘的代价
不是终端绘制，而是**重建整份快照**（`Buffer.concat` 全部尾部字节、重拼 transcript、
重建 widget 行数组）。不节流时这些重建按 chunk 数量线性增长。

## 2. 契约

`@hheei/pi-ext-core` 导出唯一实现：

```ts
export const HOST_FRAME_INTERVAL_MS = 16;
export const STREAM_REPAINT_INTERVAL_MS = 100;

export interface RenderThrottle {
  request(): void;
  dispose(): void;
}
export function createRenderThrottle(render: () => void, intervalMs?: number): RenderThrottle;
```

语义：

- **leading**：窗口关闭时 `request()` 立即执行一次 `render()`，第一段输出马上可见，不引入
  固定延迟。
- **coalescing**：窗口打开期间的 `request()` 只置 pending 标记，不重建快照。
- **trailing**：窗口到期时若存在 pending，再执行一次 `render()`，因此**最后一帧不会被丢弃**。
- `dispose()` 幂等：清除定时器、丢弃 pending、之后的 `request()` 为 no-op。
  定时器调用 `unref()`，不阻止进程退出。
- `intervalMs` 必须是正安全整数，否则抛错（这是编程错误，不是运行时数据）。

`render` 闭包负责读取**当前**状态并重建快照，因此节流器不持有任何状态副本；它只决定
「什么时候重建」，不决定「重建什么」。

## 3. 消费者与归属

| 位置 | 高频源 | 现状 |
|---|---|---|
| `pi-ext-tools` `bash` `outputStreamer` | 每个 stdout chunk | 100ms 节流；`sink.finish()` 后 `dispose()` |
| `pi-python-eval` `python_eval` `publish` | 每个 row / printed 片段 | 100ms 节流；execute 的 `finally` 中 `dispose()` |
| `pi-apply-patch` `apply_patch` `onProgress` | 每个 operation 与阶段切换 | 100ms 节流；execute 的 `finally` 中 `dispose()` |
| `pi-web-access` activity widget | `activityMonitor.onUpdate` | 100ms 节流；session shutdown 时 `dispose()` |
| `pi-subagents` footer status | `manager.onChange` | 100ms 节流；resource cleanup 中 `dispose()` |
| `pi-bg-bash` footer status | `jobs.onTerminal` + `tool_result` | 100ms 节流；resource cleanup 中 `dispose()` |

快路径（**不**节流，直接交给 host）：`pi-settings` / `pi-loadout` / `pi-ext-core` 的
page router 键盘导航、`pi-status` footer、`pi-todo` footer status、`WidgetHandle.requestRender`。

## 4. 生命周期与清理

- 节流器属于**发起重绘的那次执行或 session**，不属于模块全局。工具执行在 `finally` 中
  `dispose()`，session 级在 `context.resources` 的 cleanup 中 `dispose()`。
- 不 `dispose()` 的后果不是内存泄漏，而是**完成后仍会有一次迟到的 `render()`**：它会读到
  已完成的快照并再次调用 `onUpdate` / `setStatus`，污染终态。因此清理是正确性要求。
- 工具返回的 result 是终态的唯一来源；节流器不负责投递最终帧，`dispose()` 丢弃 pending
  不会丢失信息。

## 5. 验证

- `packages/pi-ext-core/test/render-throttle.test.ts` 覆盖 leading / coalescing / trailing /
  dispose / 非法间隔。
- 各消费者的既有渲染与状态测试保持通过；流式路径新增「一次突发只产生少量 update」的断言。
