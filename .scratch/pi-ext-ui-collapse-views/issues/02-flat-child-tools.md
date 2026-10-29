# 02: 容器子调用计数、平铺全文与父执行证据

**Spec:** [连续活动组 Spec](../../../docs/architecture/pi-ext-ui-tool-groups.md)；D3、D5、D9；用户故事 4–8、14–16。

**What to build:** codemode、python_eval 在历史工具分类中按有效子调用计数并平铺；用户点击子项直接查看 Level 2，父容器独立输出和异常仍能检查。变更贯穿 ext-core 契约、实际提供者、UI 消费者和测试，不把 schema 或适配层单独作为交付。

**Blocked by:** 01：连续工具 block 与不重置的回合时钟

**Status:** done — 已实现并通过聚焦验证。

## Delivered

- ext-core 增加 `ToolPresentation.children`（id、title、summary、status、durationMs、detail），codemode 与 python_eval 各自填充自己的事实，UI 不解析私有 details。
- 有子调用时只计有效子调用、无子调用计父调用；header 总数含尾行，工具分类列表排除尾行及其子调用。
- 工具分类平铺一行一调用，点单项直接展开详情；父容器自身输出、异常与源码仍可从原始成员视图检查。


## Acceptance criteria

- [x] ToolPresentation 只增加实际需要的可选结构化子调用事实，旧提供者继续正常显示；公共字段附近记录事实缺失、状态与结果的语义。
- [x] Python 提供者复用自身 details 验证，codemode 复用既有 capture/details；通用 UI 不复制私有解析、不依赖具体 extension。
- [x] 无子调用计父、有子调用只计有效后代；从父 1 到子 2 原子替换，不保留第三个父项。
- [x] live/persisted/details 同一执行择一；相同参数真实调用分别保留，partial、失败、取消不重复创建项。
- [x] 尾行容器及全部子调用排除在历史列表之外，header 总数仍包含其有效调用集合；不进入 subagent 私有 session。
- [x] 工具分类打开后逐调用一行；单项直接 Level 2，至多一个工具详情打开；copy 与原 renderer 全文入口有效。
- [x] 父源码、打印值、namespace 和脚本异常仍能经不计 calls 的执行记录/原始视图检查，不能因只平铺子工具而丢失。
- [x] 旧记录只有摘要时显示详情不可用并保留原父结果，不重跑脚本、不伪造空结果，不把有界 tracker 当唯一历史来源。
- [x] 用实际 Python trace/codemode capture 经投影验证计数、列表、全文与错误；契约增加后，至少两个真实生产/消费路径闭环。

## Verification

改动 Biome、受影响 ext-core/UI/Python 提供者测试及对应 package build；公共契约与跨包消费者触发根 pnpm run typecheck。代码后更新 Graphify AST，记录命令及结果。

## Boundaries

不新增 registry、事件总线、临时文本适配器或重复持久化。契约、提供者、UI 接线必须在同一内聚变更中可运行。
