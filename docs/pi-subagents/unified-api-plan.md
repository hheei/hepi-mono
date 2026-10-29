# 统一 Agents API 实施计划

状态：AGENTS-01～07 已落地，AGENTS-08（跨端集成、恢复与实机验收）未完成；逐项状态以 [unified-api-tickets.md](unified-api-tickets.md) 为准。本文保留架构依据与实施分阶段说明，不作为第二份任务状态表。旧数据迁移、回填和兼容层明确不做。

## 1. 现状与需要改变的 seam

- tools.ts 的 Pi 父端工具直接调用 manager.spawn/send/get/stop；get 仅投影运行状态，完成由 ParentChannel 自动交付。
- controller-ipc.ts 同时承担 socket 传输、MCP 派发/receipt 等待、查询拼接与 transcript 投影。直接复制它到 Pi 会产生两套业务实现。
- manager.ts 负责 child ownership、串行 mutation、workVersion、恢复与 settlement；当前自动报告先调用 contactParent，再发布 settlement。仅在工具注册处改名无法避免 wait:true 的重复结果。
- receipts.ts 已有持久结算和等待；state-db.ts 的 children.revision 是 registry 乐观并发版本，不能拿来当公共委派 revision。
- MCP App 现在绑定 childId/delegationId，模型工具与 App-only 工具分别注册；必须一次同步工具名、参数和卡片身份。

共享 seam 置于 pi-subagents package 内实际业务调用处：delegate/get/stop/dashboard。Pi 工具与 controller IPC 是两个消费者；共享模块拥有 receipt 预留、等待和结果投影，manager 保留进程/session ownership。传输层不再决定业务状态。不新增全局服务、泛型 provider 或跨 package API。

## 2. 分步实现

### A. 固定契约与新格式持久记录

交付：公共输入 schema、结果类型、id + revision 查询、唯一约束与新格式标识。revision 由每个 parent/agent 的委派记录持久分配，与 registry CAS revision、workVersion 分开命名。内部可用 delegationRevision 表达公共 revision，防止同名混淆。

新 agent 必须在启动前获得持久身份；检查现有 spawn 身份分配点，将必要的 receipt 预留放在该 ownership 路径，而不是让外层预测 agent-N 或启动后再补身份。不要新增可由模型调用的 prepare/commit 两阶段接口。

不读旧 receipts、不回填序号、不自动删除状态。不兼容格式在受理前报错；停止旧 controller、选择新状态环境属于后续显式部署动作。

验收：未知字段/title/mode 拒绝、revision 并发唯一和重启单调、旧格式拒绝且文件未改、预留失败不启动进程。新 child 创建失败时已知身份仍可诊断。

### B. 共用 delegate 与 settlement 交付

交付：Pi/MCP 使用相同业务函数和默认值。输入 id 走 steer，无 id 走新建；保留底层 session 恢复、/compact 控制和 child blocker 路径。删除已无调用方的公共 spawn/send 参数及提示，不删除 Pi host 自身能力。

将最终事实记录与交付分开：先确认并持久结算，再由同一 package 内交付协调选择 waiter 或 Pi BackgroundDelivery。不能把 contact_parent 的阻塞请求、人机决策和普通完成报告不加区分地全局关闭。

wait:true 派发前取得 agent 的等待占用；wait:false 仍可 steer。不要持有 mutation queue 等待 child。Pi 取消等待后回到自动交付；MCP 取消后保持可查询。交付身份使用现有工作轮次关联，不增文本去重缓存或模型已读数据库。

验收：快速结束、同轮多次 steer、blocker、失败、stop、/compact、abort/settle 竞争；wait:true 无自动重复，wait:false 仍可正常推送。多 agent 并发不互相串行化。新格式 controller 重启后不重派任务。

等待占用独立于历史 receipt.delivery：请求 finally 和 extension/session dispose 释放占用与监听器；旧 pending 记录不能锁死下一次等待，重启后不恢复不存在的 waiter。

/compact 单独修正现有轮次绑定：manager 在派发前将 revision 关联到具体控制操作，复用 mailbox command identity；child-control 的完成/失败报告携带该关联。重复 compact 加入同一进行中操作时保留归属，新 compact 不复用旧关联。不用最新 workVersion 推断控制完成，不让普通 steer 的结算污染控制结果。补充 idle/running compact、重复并发、连续 compact、失败及期间 steer 的测试；重启无法确认的控制操作记 uncertain，不自动重跑。

### C. get/dashboard/stop 共用投影与精简输出

交付：get(id, revision?, includeOutput?)；dashboard 有界状态/活动摘要；stop 幂等并结算所有未完成委派。去掉 controller list 逐 child 拉取完整 resultText 的逻辑，App 按所选 revision 单独读取。

查询不消费交付状态；includeOutput 默认 false，但 hasOutput 仍如实表示结果存在。历史 revision 与当前 runtime 活动分开。保留错误的 safeToRetry/sideEffects 信息，不把 failed/uncertain 的错误文本伪装成功输出。

验收：两端同样数据投影、历史/最新选择、空结果、缺失 revision、失败诊断、长结果不进入默认列表、显式输出可完整读取。不扫描 session 全历史来实现普通状态查询。

显式正文仍应用现有 truncateWithSpill 上限；模型文本、structuredContent 与 App IPC 都不得透传未经限制的超长结果。保留完整文本文件和路径，不增加新分块协议。

### D. 切换 Pi、MCP 与 App 消费者

交付：Pi agents_delegate/get/stop/dashboard；MCP server pi_agents 与无前缀工具名；App-only list/transcript/catalog/receipts。删除旧模型工具和别名，delegate 说明列出可用 agent 定义。

App 全面绑定 id + revision。刷新、选中切换和 steer 返回均使用 generation 防旧响应覆盖；先取得新 revision，再切换卡片观察对象。完整输出只在 UI 需要时读取。工具改名不要求同时改 package 名、bin、资源 URI 或 child identity 环境变量。

同步 README、当前 MCP 文档、system prompt/tool discovery 描述、测试 fixtures 与建议 client 配置。只修改确有行为变化的引用，历史 plans 不全仓机械替换。清点所有跨 package 消费者，若真实存在则同步更新，不留过渡 alias。

验收：tools/list 的名称和 visibility、Task Card/Dashboard 初始化与动作、Pi 工具发现、标题自动生成、contact_parent、长文本/键盘/窄宽布局。旧工具从工具目录消失。

### E. 集成验证与交付

按变更范围运行：

1. 改动 TS/HTML 的 Biome、受影响 Vitest 文件和 pi-subagents build。
2. 因修改公共模型工具契约并清点跨 package 消费者，运行根 pnpm run typecheck；只有真实行为跨全仓传播时再加全仓测试。
3. 涉及 child 启动/controller/重启/锁路径，运行相关真实子进程集成测试；运行 pnpm run verify:changed 更新 AST 图谱。
4. 新状态环境测试 Pi 与 MCP 端到端：异步交办、同步等待、steer、取消、stop/恢复、结果显式重读、App 视觉验收。
5. 报告实际命令与结果、工具改名和新状态要求；远端部署、push、tag、publish 独立遵循已有授权与发布门禁。

各步形成内聚变更，不包含当前工作区其他无关修改。当前不执行任何实现或部署步骤。

## 3. Review 范围

以当前工作区设计文件为 review 对象，用户本轮和此前已同意的五项要求为 spec；当前源码只用来核实可实现性和定位 code smell。review 结果记录于 unified-api-review.md。

分开检查：spec 是否完整且无擅自扩展；仓库规范与 code smell；架构的 ownership、清理、取消、恢复、并发与消费者。发现问题先修改文档，仍无法确定的设计明确标为待定，不把计划写成已通过实现验收。
