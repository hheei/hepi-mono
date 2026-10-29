# 11：collapse views 刷新路径审计

**状态：** 只读排查已记录，未实现。用户要求先查并记录。

## 用户明确口径

- 点击重绘：16ms 帧合并。
- 流式快照：100ms 节流。
- 点击不要求绕过帧调度；重点检查是否误等流式窗口、是否重复节流。

## 已核查调用链

| 路径 | 位置 | 当前行为 |
| --- | --- | --- |
| group/header/category/item 点击 | tool-group-view.ts，#toggleRaw/#hit | 改本地状态 → #redraw；返回 handled/render=true |
| 刷新注入 | host-transcript-patch.ts，readHost/attach | 无参 tui.requestRender 闭包；未使用 createRenderThrottle |
| 工具展开、copy | tool-view.ts，setFoldLevel/#triggerCopy | 清理本地缓存 → spec.invalidate；鼠标返回 render=true |
| 嵌套与 notice | nested-calls-view.ts、message-view.ts | invalidate 与鼠标 render=true 请求重绘 |
| provider invalidate | renderer.ts → host tool-execution.js | context.invalidate → updateDisplay → ui.requestRender |
| 流式快照 | pi-ext-tools/src/bash.ts、pi-python-eval/src/tool.ts | createRenderThrottle 默认 100ms 后构建 snapshot/transcript 并 onUpdate |
| 共用窗口 | pi-ext-core/src/render-throttle.ts | HOST_FRAME_INTERVAL_MS=16，STREAM_REPAINT_INTERVAL_MS=100 |

## Pi host 静态证据

本机 Pi 1.3.0 路径基准：<node_modules>/@earendil-works/pi-coding-agent。

- node_modules/@earendil-works/pi-tui/dist/tui.js：MIN_RENDER_INTERVAL_MS=16；普通 requestRender → nextTick(scheduleRender) → setTimeout(max(0,16-elapsed)) → doRender。这是最小帧间隔，不是每次点击固定额外等 16ms。
- node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js：鼠标 listener 消费输入；组件返回 render=true 后走普通 requestRender。group 自己发请求与 host 处理 render=true 会合并，不等于两次终端绘制。
- 键盘输入另走 private requestImmediateRender，不是本票点击目标。requestRender(true) 还会 resetRenderState，不能当无副作用的快速选项。
- group 本地点击静态链目前符合 16ms 调度，未发现 pi-ext-ui 自己包一层 100ms throttle。不能直接写成所有 collapse 内容都走慢速节流。

## 100ms 的准确含义

createRenderThrottle 首个事件立即构建快照，窗口内后续事件合并为 trailing；不是所有更新固定延迟 100ms。bash.finish 会 flush/dispose；python_eval 使用同样的流式窗口。

数据流：输出事件 → 100ms 快照生产窗口 → onUpdate → host 16ms 帧调度。已有快照上的本地展开应直接走 16ms，不应等待下次 onUpdate；流式新数据最终显示仍受 host 帧调度影响。

codemode 生产端的具体节流此次未完成核查，不能把 python_eval 结论直接套给 codemode。

## 另一个待测因素：渲染成本

host-transcript-patch.ts 的 chat.render wrapper 每次先 rebuild，遍历 chat.children 和 assistant.content，重组 members/projection；ToolGroupView 再算统计、分类和 hit layout。ToolView 局部缓存不能消除上层扫描。

这是待 profiling 的 CPU/历史长度成本，不等于节流；未测量前不新增历史缓存、全局 scheduler 或 timer。时间仅在 render 时采样 performance.now，没有独立时钟 tick，静默执行的刷新来源也需确认。

## 验收进展（2026-10-29）

- [x] 新增 packages/pi-ext-ui/test/refresh-path.test.ts：真实 TuiMainScreen + ToolView 点击与现有 createRenderThrottle 同帧运行，100ms trailing 快照未到达前，展开正文已在至多一个原生 16ms 帧显示；随后 trailing 更新/flush/dispose，不残留多余帧。测试不私改 Pi 调度器。
- [x] 与 packages/pi-ext-core/test/render-throttle.test.ts 一起运行：10 tests 通过。首快照立即，随后同窗口合并为 100ms trailing；完成前 flush，dispose 幂等。
- [x] 已核查本地 Pi 1.3.0 codemode/execute.js：publish() 直接调用 onUpdate，没有与 bash/python 相同的 createRenderThrottle 100ms 窗口；不可宣称所有容器快照都经过该窗口。其余 Pi host 调度 16ms 不变。
- [ ] 08 用 herdr 对真实流式输入、点击、Ctrl+O、主题切换记录帧证据；性能基准只在复现缓慢时加，不额外叠层节流。

## 后续验收（部分已执行）

- [x] 原生 TuiMainScreen + fake timers 验证点击优先于生产端 100ms trailing；bash/python 的 producer window 已由 render-throttle 聚焦单测覆盖，不要求点击绕过 host 帧调度。
- [ ] 流式窗口已开启时，点击 group/category/thinking/tool/copy 无需等待 snapshot trailing；无双层 100ms throttle。
- [ ] 完成、错误、abort/dispose 的最后状态不丢失、不被旧 trailing 覆盖，保留幂等清理。
- [ ] herdr 分别测试 regular/fullscreen、短/长 transcript、高频输出与静默执行；记录输入→状态→render→terminal write 时间线，区分帧等待和 CPU 时间。
- [x] 核查 codemode 快照生产端：本地 1.3.0 publish() 直接 onUpdate；Ctrl+O、resize、嵌套视图仍归 08 实机验收，不能用键盘路径证明鼠标路径。
- [ ] 先选既有原生机制；不改 Pi host、不加 host hooks、不调用私有 immediate 方法、不通过 force 全屏重绘掩盖问题；公共契约变更先确认。

## 本次验证

执行 Graphify query、定点源码读取与搜索。只更新计划文档；未改运行时，未运行 TypeScript、测试、herdr 或性能基准。ticket10 验证不作为本票性能证据。
