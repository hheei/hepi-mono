# 05: 全功能 block 的原始视图、互斥与强制展开

**Spec:** [连续活动组 Spec](../../../docs/architecture/pi-ext-ui-tool-groups.md)；D3–D6、D9–D10；用户故事 13–17、20、26–28。

**What to build:** 用户可在工具、思考、通知以及已结束请求摘要之间一致地检查完整内容。聚合保持单分类/单详情，原始视图和 Ctrl+O 保留 Pi host 检查路径，退出后没有隐藏旧展开状态复现。

**Blocked by:** 02：容器子调用计数、平铺全文与父执行证据；03：Thinking 与明确类型 Notice 的分类详情；04：完成或被打断 block 的原生口径请求统计

**Status:** done — 已实现并通过聚焦验证。

## Delivered

- 三类聚合同时最多一个分类、一个单项详情；打开另一类或项会关闭旧选择。
- header 切换原始成员视图：上下两条 rails、原组件、原 copy 与鼠标命中；进入时收起内部工具与巢状视图。
- Ctrl+O 强制原始视图，并清除聚合的本地选择；关闭后回到全部收起的聚合视图。
- 完成态保持 header/body，footer 承载请求统计；尾行始终只读；流式重绘不重置仍有效的详情。


## Acceptance criteria

- [x] 三类聚合同时至多一个分类、一个单项详情；打开另一类或项时先关闭旧选择。
- [x] header 切原始成员视图时保留顺序和原组件；进入与退出都先显式收起内部工具、MessageView 和巢状视图。
- [x] Ctrl+O 优先强制原成员展开；退出返回全收起聚合，不恢复旧详情；原始视图不强加聚合的单项互斥。
- [x] 完成态可经 header 切原始视图查证保存内容，原始父源码/输出/异常始终可达；切换不丢 usage 或结果。
- [x] 当前/最后 codemode、python_eval 尾行始终只读，不因父组件或 Ctrl+O 的局部缓存意外展开尾行本身。
- [x] copy、子组件鼠标命中、折叠热区不被父级劫持；fullscreen 鼠标与 regular Ctrl+O 均可用，不 patch 滚动。
- [x] 原项被替换、移到尾行或消失时清理选择；stream repaint 不重置仍有效的详情、时间或归账。
- [x] 所有组合在窄宽布局、主题变化、ANSI/Unicode 和多行摘要输入下不超宽、不泄漏换行；每个返回元素恰好一终端行。

## Verification

改动 Biome、受影响 ToolView/MessageView/nested/host 投影测试、UI package build；执行 regular/fullscreen 的对应真实 CLI/PTY 测试。若确有公共契约变更运行根 typecheck；代码后更新 Graphify AST。

## Boundaries

不是为前序票补安全性的集中修复：01–04 必须各自保留既有检查/清理能力。本票交付完整功能组合下的新模式契约，不重写执行或滚动。
