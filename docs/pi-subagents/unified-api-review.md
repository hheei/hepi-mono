# 统一 Agents API：设计与代码可行性 Review

文档拆分说明：原 unified-api.md 的契约内容现为 [Spec](unified-api-spec.md)，可执行任务见 [Tickets](unified-api-tickets.md)。下文保留本次审查时的文件名称与结论；拆分未改变已审查契约。

范围：当前工作区的 unified-api.md、unified-api-plan.md；当前源码仅用于核实可实现性与架构风险。用户明确本轮只做设计，不评定尚未编写的实现已通过运行验收。

Spec 来源：本轮及此前用户明确要求（delegate 统一、Pi agents_*、MCP pi_agents 与无前缀工具、id + revision、按需输出、去掉 title/mode、steer-only、无旧数据迁移）。Standards 来源：仓库 AGENTS.md，以及 codebase-design 的 Interface/ownership/locality 原则。设计文件尚未提交，直接读取了 untracked 内容，不只依赖 git diff。

## Spec

独立 reviewer 结论：当前版本没有可操作的 Spec 缺漏。需求均有对应契约；不迁移、不回填、不兼容旧格式，不自动删除旧状态；实施与部署不在本轮。

本轮 review 期间修正：

- 删除旧 receipt 迁移与 revision 回填计划。
- 删除旧 agent 无 revision 的兼容结果。
- 新建时明确要求 agent，移除源码中不存在的默认选择规则。
- hasOutput 与 includeOutput 解耦：不返回正文仍可正确报告结果存在。
- 补齐 stop/dashboard 与受理前后错误的输出语义。

## Standards 与 code smell

以下是基于当前代码的判断性风险，不是对未实现设计的测试失败：

| 位置 | 判断 | 计划中的处理 |
| --- | --- | --- |
| controller-ipc.ts 的 runDelegation/dispatchDelegation | Divergent Change：传输同时决定 receipt、派发和等待；复制给 Pi 会造成 Duplicated Code | 共享真实业务 seam，IPC/Pi 各自只负责传输或工具注册 |
| mcp-server.ts 的 project/cleanChild/cleanReceipt，与 tools.ts 的 childAgentDetails | 两端结果分别筛选，字段和状态语义易漂移 | 共用已验证业务投影，各端只生成展示文本和协议 envelope |
| state-db.ts 的 children.revision | Mysterious Name 风险：既有 registry CAS 版本与新委派序号同名但含义不同 | 内部明确区分 delegationRevision、registry revision 和 workVersion |
| controller-ipc.ts 的 list 查询 | 列表逐 agent 查 receipt 并携带完整结果，产生不必要查询和上下文重复 | 默认列表只取有界摘要，选中后显式读取输出 |

不增加单实现 provider、通用 adapter 框架、独立任务服务或模型已读状态。保留 manager 的 child/runtime ownership；不因减少文件数把共用业务塞回传输层。

## 架构

本轮检查确认的实施前置条件：

1. manager.ts 当前先 contactParent 再发布 settlement；wait:true 的重复抑制必须在报告路径生效，工具注册处改名不足以解决。计划改为先持久结算，再协调 waiter/自动交付；blocked 请求和普通完成须分开处理。
2. 新建 agent identity 当前在 spawn/bootstrap 内分配。公共 revision 的预留必须进入该现有 ownership 路径，不能由 IPC 猜测 agent-N，也不能启动后才补 receipt。
3. 多次 steer 可共享一个 workVersion；revision 必须独立持久分配，再关联实际结算。不能按 revision 自动重复推送同一答案。
4. receipts.ts 当前持久 pending 与请求等待相关联；取消时只删监听器不足以满足新契约。计划明确活跃等待占用必须 finally/dispose 释放，旧 receipt 不能成为永久占用。
5. 完整结果仍需保留 truncateWithSpill 与 IPC 大小限制，不能在 structuredContent 或 App 刷新中绕过。取消、崩溃恢复与外部结果确认无法承诺跨进程 exactly-once。

独立架构 reviewer 补充一个 P2：/compact 不产生 agent_start，但当前 idle 派发会预订下一 workVersion，控制报告却使用当前 workVersion，直接沿用会导致 receipt 永不结算。依据为 manager.ts 的 claimRunBoundary/handleChildRequest、child-control.ts 的 compact 报告和 receipts.ts 的精确 run_boundary 匹配。

该项已修订 design §4 与 plan B：由 manager 事前绑定 revision 与具体 compact 操作，复用 mailbox command identity 经 child bridge 回传；重复操作加入同一结算，普通 steer 与控制结果分开。补充 idle/running、重复并发、连续 compact、失败与期间 steer 的验收。新格式重启无法确认的操作为 uncertain，不自动重跑。

以上已写入 design/plan，属于实施验收项，不代表代码已修复。独立 Standards review 没有其他可操作的 smell；共享业务 seam 有 Pi 和 MCP 两个真实消费者，不属于推测性抽象。

轴向结论：Spec 未解决项 0；Standards/架构发现 P2 1 项，已在设计处理，运行时验证留待实现。当前代码观察到的职责/命名/重复风险均已列入计划，不作为本轮已完成的代码修正。

## 验证

本轮只修改 Markdown。git diff --check -- docs/pi-subagents 通过；新建文件另行直接检查内容。未运行 TypeScript、单元测试、集成测试、全量检查或远端部署；这些留给计划中的实际实现阶段。
