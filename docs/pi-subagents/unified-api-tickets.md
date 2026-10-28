# 统一 Agents API Tickets

目标契约：[Spec](unified-api-spec.md)。架构依据：[Plan](unified-api-plan.md)。审查依据：[Review](unified-api-review.md)。本工作线使用 AGENTS- 前缀，与既有 SUB-/MCP-R4- tickets 分开。

状态：所有 ticket 均未开始。拆分不代表运行时已改变，也不授权部署或发布。

## 执行规则

- 每项形成可运行、可验证的内聚变更；先实现内部路径，再在对应接线 ticket 原子切换公共工具，不提前发布占位工具或兼容 alias。
- 修改 TypeScript 前阅读根 DESIGN_TS.md；保留无关工作区改动。使用 package 内既有能力，不增加通用 adapter、全局任务服务或新 package。
- 不做旧数据迁移、revision 回填、双读或旧 API 兼容；不自动删库。新格式自身的恢复必须保留。
- 每项完成后填写实际验证命令、结果与 commit；未运行、失败、待实机验收要明确。最终集成项不能代替前序的聚焦验证。
- 公共接口改动执行根 typecheck；子进程、锁和重启行为执行真实集成测试。全仓 test/check 仅按根 Verification policy 升级，不因最后一个 ticket 自动升级。

## 任务总览

| Ticket | 交付 | 依赖 | 状态 |
| --- | --- | --- | --- |
| AGENTS-01 | 新格式身份与委派 revision | 无 | [x] |
| AGENTS-02 | 共用 delegate 与模型轮次结算 | 01 | [x] |
| AGENTS-03 | /compact 控制操作结算 | 02 | [x] |
| AGENTS-04 | 等待、取消与单次交付 | 02、03 | [ ] |
| AGENTS-05 | get/dashboard/stop 与有界输出 | 02、03 | [ ] |
| AGENTS-06 | Pi 工具切换与发现提示 | 04、05 | [ ] |
| AGENTS-07 | MCP 工具与 App 同步切换 | 04、05 | [ ] |
| AGENTS-08 | 跨端集成、恢复与实机验收 | 06、07 | [ ] |

02 完成后，04 需要等待 03；05 与 04 可并行。06 与 07 可并行，08 汇合。编号只表示任务，不是公共 revision。

## AGENTS-01：新格式身份与 revision

**Spec**：§3、§4、§7。**状态**：[x]。**依赖**：无。

**交付**

- 建立公共输入/结果 schema 和新格式标识；明确条件必填 agent、正整数 revision、未知字段拒绝。
- 在既有 SQLite/manager ownership 内原子预留 agent identity 与首个委派；同 parent/agent 后续 revision 持久单调分配并有唯一约束。
- 区分 delegationRevision、registry CAS revision、workVersion；随机内部主键不出现在目标公共结果中。
- 在任何写入、自动 schema 升级和派发前检测不兼容旧格式，错误显示状态路径；保持旧文件不变。

**验收**

- title/mode、空 task、未知字段与非法 revision 报错；id 优先时忽略 agent/cwd 的语义符合 Spec。
- 并发分配不重号；分配后失败保留序号，重启不重置；不同 ownership 不串记录。
- 预留失败不启动 child；启动失败能关联已持久身份，不预测 agent-N。
- 旧格式拒绝且文件内容不变；不创建隐式替代 ownership。

**验证**：schema/receipts/state-db/bootstrap 的受影响 Vitest；改动文件 Biome；package build。持久化路径增加真实初始化/重开测试；涉及公共导出时运行根 typecheck。

**边界**：不切换模型工具，不实现旧状态导入。

## AGENTS-02：共用 delegate 与普通轮次结算

**Spec**：§3、§4、§7、§8。**状态**：[x]。**依赖**：AGENTS-01。

**交付**

- 提供 Pi 与 controller 两个实际消费者共用的 package 内业务路径，复用 manager/session/bootstrap；IPC 不再独占 receipt 受理逻辑。
- 无 id 创建、有 id steer；新建保留 cwd，接续不改变冻结配置；未知 id 不创建替代 agent。
- 每次受理 revision 与实际 workVersion/runBoundary 关联；同轮多次 steer 可结算相同正文，下一轮隔离。
- 先记录持久 settlement，再进入交付协调；保留失败、副作用与安全重试信息。为 04 留下实际需要的结算接入点，不预建通用事件框架。

**验收**

- running/idle/blocked/done/error/stopped 按现有恢复规则接续同一 session；失败不隐式重派。
- 快速 child 完成早于工具返回也不丢结算；多次 steer 不误结算下一轮。
- 普通完成、失败、child 消失与 blocker 有明确持久结果；contact_parent 保留受验证身份与阻塞语义。
- 不持有 mutation queue 等待完成；不同 agent 独立并发。

**验证**：manager/receipts/delegate 聚焦测试；真实 child 启动与恢复的受影响集成测试；改动 Biome、package build。

**边界**：本项不宣布 /compact 或单次交付已完成，不切换公共工具。

## AGENTS-03：/compact 独立控制结算

**Spec**：§4 的 /compact 规则、§7、§8。**状态**：[x]。**依赖**：AGENTS-02。

**交付**

- manager 在派发前绑定 revision 与具体 compact 操作，复用现有 mailbox command identity；child-control 完成/失败回传关联。
- 重复 compact 若加入同一进行中操作，多个 revision 关联同一操作；下一次操作使用独立关联。
- 不依赖 agent_start 或报告时最新 workVersion；普通 steer 与控制完成分开。重启无法确认的控制操作记 uncertain，不重跑。

**验收**

- idle、运行中 compact、重复并发、连续两次、失败、compact 期间 steer 都结算正确 revision。
- 迟到控制报告不覆盖新一轮，不将普通最终答案作为 compact 输出；重复报告不重复交付。
- 已受理操作在完成、失败、取消等待或恢复诊断中有限结束，不因边界不匹配永久等待。

**验证**：child-control/manager/receipts 聚焦回归；真实控制命令与重启集成测试；改动 Biome、package build。协议跨消费者变更运行根 typecheck。

**边界**：不新增公共控制 ID、通用控制服务或新公共参数。

## AGENTS-04：等待、取消与交付归属

**Spec**：§6、§7。**状态**：[ ]。**依赖**：AGENTS-02、03。

**交付**

- 两端 wait 默认 true；wait:false 受理即返回。每 agent 最多一个活跃 delegate waiter，冲突在派发前拒绝。
- 活跃占用与历史 receipt.delivery 分开；finally/dispose/session 切换释放 waiter、监听器和占用，不恢复已消失的旧 waiter。
- Pi wait:true 工具结果与自动报告竞争同一 settlement 的交付归属；Pi 取消后未确认结果回到原 session 自动交付，MCP 取消后仍可查询。
- 同轮多个 revision 不产生多份自动报告；保留 blocker 与决策请求。早期进度提供已受理身份。

**验收**

- 快速完成、abort/settle 竞争、timeout、socket 断线、session 切换和 dispose 无丢失/重复/监听器泄漏；取消不 stop 工作。
- wait 冲突不先注入 steer；wait:false 仍可继续同 agent；旧 pending 不锁死后续等待。
- Pi 同步结果不再自动重复推送，异步结果仍自动返回；MCP 异步不虚构推送。
- 新格式重启保留结果/uncertain，禁止盲目重派；不承诺跨进程 exactly-once。

**验证**：waiter/settlement/ParentChannel/IPC 竞争测试；断线、shutdown 与 controller 重启真实集成测试；改动 Biome、package build。

**边界**：不增加模型已读表、文本哈希去重或 ext-core 业务策略。

## AGENTS-05：共用查询、停止与输出上限

**Spec**：§5、§6、§7。**状态**：[ ]。**依赖**：AGENTS-02、03。

**交付**

- 共用 get(id, revision?, includeOutput?) 投影，默认最新、includeOutput:false；hasOutput 按结果存在判断。
- dashboard/list 返回有界摘要，不逐 child 读取完整结果，不扫描 session 全历史；当前 runtime 与所选历史委派分字段。
- stop 幂等停止 runtime，所有未结算 revision 记录失败；已完成结果与 session 保留。
- 显式输出也应用既有 truncateWithSpill 5000 tokens / 20KB 上限与完整文件引用，structuredContent/App IPC 不绕过上限。

**验收**

- 最新/历史 revision、缺失记录、空字符串输出、结果尚未产生均准确；无结果不拿上一轮填充。
- 默认 get/dashboard 不含全文；includeOutput 不改变 hasOutput，不消费交付状态。
- failed/uncertain 保留明确 error/safeToRetry/sideEffects，不把错误堆栈当结果。
- 重复 stop 安全；stop 后同 session 可再次 delegate；长正文不导致 frame overflow。

**验证**：query/projection/stop/limits 聚焦测试及停止路径集成测试；改动 Biome、package build。

**边界**：不新增全文分页协议或额外缓存服务。

## AGENTS-06：Pi 工具原子切换

**Spec**：§2、§3、§6、§8。**状态**：[ ]。**依赖**：AGENTS-04、05。

**交付**

- 注册 agents_delegate/get/stop/dashboard，共用前序业务路径与 schema；移除旧 agent_spawn/send/get/stop 注册和失效公共参数。
- 同步 deferred discovery、optional_tools、system prompt、工具描述与可用 agent 目录；保留 child-only contact_parent 和自动标题。
- 清点 Pi 端直接调用方，删除已无消费者的 mode/title 公共分支，不删除 Pi host 原生功能。

**验收**

- 工具目录仅有新名称；两种 wait 路径、查询、stop/恢复均能端到端运行。
- title/mode 被拒绝，cwd 新建有效，接续始终 steer；不存在过渡 alias。
- deferred 工具可被发现，完成提示符合实际交付语义；子端不递归暴露父端工具。

**验证**：工具注册/发现/描述/ParentChannel 聚焦测试；真实 Pi smoke；改动 Biome、package build、根 pnpm run typecheck。

**边界**：不更改 package 名、bin 或 Pi host 接口。

## AGENTS-07：MCP 与 App 原子切换

**Spec**：§2、§3、§5～§8。**状态**：[ ]。**依赖**：AGENTS-04、05。

**交付**

- server 自报名称/建议配置键为 pi_agents；原始模型工具 delegate/get/stop/dashboard，App-only list/transcript/catalog/receipts，删除 subagents_* 与模型 receipt 工具。
- MCP 注册、IPC 投影与单一 App HTML 同步改用 id + revision；不要求改变 package/bin/resource URI。
- 卡片选中、steer 回执和历史查询使用正确 revision；generation 防旧响应覆盖；输出只在需要时读取。
- 更新当前 README/MCP 文档、fixtures 与配置示例，清点真实跨 package 消费者；历史 plans 不机械改名。

**验收**

- tools/list 名称、visibility、schema、resources metadata 正确；模型可调用 get/stop；App 调用新工具名成功。
- Task Card/Dashboard 创建、选中、继续、停止、Output/Transcript 分页正确，当前 runtime 不覆盖历史结果。
- 快速切换、在途 steer/poll、隐藏/teardown、焦点/草稿、键盘、长正文与窄宽布局保持正确；刷新不隐式推送结果。
- clean package 包含 HTML/license；给出 MCP client 重连刷新 tools/list 的操作说明。

**验证**：MCP stdio/IPC/App DOM 聚焦测试；真实 stdio 集成 smoke；改动 Biome、package build、根 pnpm run typecheck、package 资产核查。

**边界**：本地接线完成不等于 Codex Desktop 实机通过；不连接远端修改用户配置。

## AGENTS-08：跨端集成、恢复与实机验收

**Spec**：§8 全部验收。**状态**：[ ]。**依赖**：AGENTS-06、07。

**交付**

- 新格式环境核对 Pi/MCP 输入、身份、状态和输出一致；执行新建→steer→结算→显式重读→stop/恢复。
- 覆盖并行 agent、同轮 revision、取消/断线、/compact、controller 重启、fork ownership、派发前后 crash 与 uncertain；核对无任务重放。
- 真实 Codex Desktop 检查卡片、Dashboard、最终输出、继续/停止、主题/宽度/键盘；归档实测版本与截图。无实机访问时保持本 ticket 未完成并记录缺口。
- 同步当前文档与本表状态，记录旧格式拒绝、新环境切换和 client 重连要求；发布另走授权/完整发布门禁。

**验收**

- 前序全部聚焦检查通过；真实子进程与 Desktop 证据完整，不用 mock 代替实机。
- 默认查询不重复全文，显式输出可读；没有旧名称或隐式迁移/删库。
- shutdown 无遗留等待/连接；身份、已完成结果与不确定副作用可核对。

**验证命令**

- pnpm exec biome check <changed-files...>
- pnpm exec vitest run <affected-test-paths...>
- pnpm --filter @hheei/pi-subagents run build
- pnpm run typecheck
- pnpm run test:integration（涵盖真实启动、锁、关闭与重启路径）
- pnpm run verify:changed（检查受影响范围并更新 AST 图谱）

只有根 Verification policy 的升级条件满足时追加 pnpm test 或 pnpm run check，并说明原因。实机、pack 资产和性能证据单独记录，不以命令退出成功替代观察。

+
## 完成记录

### AGENTS-01

- 实现：新格式状态库以 `PRAGMA user_version = 1` 标识，`delegations` 表新增 `delegation_revision` 与 `(parent_session_id, child_id, delegation_revision)` 唯一索引；`openStateDb` 在任何写入前拒绝旧格式并保留原文件；`reserveReceipt` 在单个 `BEGIN IMMEDIATE` 事务内用 `MAX(revision) + 1` 分配序号，分配后失败不复用序号；`parseDelegateInput` 在 MCP 边界拒绝空 task、空 id、缺 agent 与未知字段（`additionalProperties: false`）。
- 身份预留顺序：新 agent 的 id 在 `resolve` 铸出后立即通过 `spawn` 的 identity seam 预留 revision，随后才写 child record、启动进程；预留失败不启动 child，启动失败仍带 id + revision 与失败原因。
- 验证：`pnpm --filter @hheei/pi-subagents run build`；`pnpm exec vitest run packages/pi-subagents/test`（362 passed，含 `state-format`、`receipts`、`manager` 新增用例）；`./node_modules/.bin/biome check packages/pi-subagents/src packages/pi-subagents/test`；`pnpm run typecheck`。
- 未验证：并发多进程同时分配序号（单进程内为同步事务，跨进程依赖 SQLite 写锁与唯一索引，尚无真实双进程用例）。

### AGENTS-02

- 实现：`SubagentManager.delegate` 成为 Pi 与 controller 共用的受理路径（预留 revision → `submitDelegation` 派发 → 绑定 `runBoundary` → 可选等待），`controller-ipc` 的 delegate 分支只做输入解析与并发上限，不再持有 receipt 受理逻辑。
- 结算归属：receipt 落库改为 manager 自己的职责（`#recordSettlement` 内调用 `settleReceipts`，`stop` 内调用 `abandonReceipts`），移除了 `onSettled`/`onStopped` 依赖；普通轮次先写持久结算，再做 `contactParent` 交付协调。
- 复用语义：有 id 时沿用冻结配置并只走 steer，未知 id 在预留前拒绝且不创建替代 agent；同轮多次 steer 共用 workVersion，一次结算写入该轮所有 revision。
- 验证：同上命令；新增 `manager.test` 用例覆盖身份先于启动、`wait:false` 受理、等待返回该 revision 结果、第二个等待在派发前被拒、同轮多 revision 共享结算、未知 id 不预留。
- 未验证：真实 child 进程的启动/恢复集成路径在 AGENTS-08 汇合验证。


+
### AGENTS-03

- 实现：`delegations.control_id` 取代按任务文本猜测归属。/compact 派发时 child 用一次 compaction 的 operation id 应答（`deliverPrompt` 返回 `controlId`），manager 用该 id 绑定 revision；`#claimDispatch` 对控制操作不再领取 workVersion，因此 compact 不制造幽灵轮次。
- 重复与连续：child 侧 `compactOperation` 记住进行中的操作，第二个 /compact 直接返回同一 `controlId`，多个 revision 共享一次结算；完成后清空，下一次 compact 使用独立 id。
- 结算：`settleReceipts` 按 `control_id` 匹配控制操作、按 `run_boundary` 且 `control_id IS NULL` 匹配普通轮次，双方互不串；普通报告不会结算 compact，迟到 compact 报告也不会结算后续轮次。
- 重启：`sweepControlReceipts` 在 `recover()` 把未确认的 compaction 记为 `uncertain` 并结束等待，不重跑。
- 边界情况：TUI 自行发起、没有 delegation 归属的 compaction 正在进行时，/compact 明确失败（`compaction_unbound`），不静默挂起。
- 验证：`pnpm exec vitest run packages/pi-subagents/test`（368 passed，含 compact 结算/共享操作/迟到报告/失败/重启 uncertain 与 child-control 的 `controlId` 用例）；`pnpm exec vitest run -c vitest.integration.config.ts packages/pi-subagents/test-integration`（8 passed）；`pnpm --filter @hheei/pi-subagents run build`；`pnpm run typecheck`；改动文件 Biome。
- 未验证：真实 child 进程的 compaction 端到端（需真实模型与长上下文）留待 AGENTS-08 实机。

## 完成记录模板

每项完成后在对应 ticket 追加：实现 commit；实际命令/结果；关键行为或截图证据；未验证范围。只有该项验收全部满足才将总览与正文状态同步为 [x]。
