# pi-subagents V1 Tickets

下一版 Pi/MCP 统一 API 工作线已独立拆分：[Spec](../../pi-subagents/unified-api-spec.md) / [AGENTS-01～08 Tickets](../../pi-subagents/unified-api-tickets.md)。旧数据迁移明确不做；该工作线状态以独立 tickets 为准，本文件保留既有 V1/MCP R4 任务与验收历史。

本 backlog 实现 [`spec.md`](../../pi-subagents/spec.md)。[`PLAN.md`](PLAN.md) 是核心生命周期设计依据；投递话术、interactive 策略与 widget 投影以 [`PLAN-delivery-presentation.md`](PLAN-delivery-presentation.md) 为准。**当前 Codex MCP 工作线见文末 [MCP R4](#mcp-r4codex-desktop-内嵌-ui当前工作线)**，规格为 [`mcp.md`](../../pi-subagents/mcp.md)。每个 ticket 应形成一个可运行、可验证的 cohesive commit；完成后更新本文件状态。禁止把后续 ticket 的抽象、兼容层或占位实现提前加入。

状态：`[ ]` 未开始，`[~]` 进行中，`[x]` 完成，`[-]` 明确不做。

## 执行规则

1. 修改 TypeScript 前先重读仓库根 `DESIGN_TS.md`，复用当前 package 与 ext-core 模式。
2. 每个 ticket 先写/更新该 ticket 的 focused behavioral tests，再完成最小实现。
3. 每个 model-facing tool、后台 transition 和 recovery failure 都必须可观察；未知状态返回错误，不无限等待。
4. 不引入第二套 runner/provider，也不把 ext-core `startSubagent` 当作 durable runner。
5. 每个 ticket 只运行列出的 focused checks；跨 package public export 或最后集成 ticket 再运行根 typecheck/full test。

---

## SUB-01：建立 package、公共合同与 agent resolver

**目标**：建立可加载的 concrete extension 和一条严格、可观察的 agent policy 解析链，但暂不启动 child。

**范围**

- 新建 `packages/pi-subagents/` workspace package，包含唯一 `pi.extensions` entry、strict tsconfig、README 和 focused test setup。
- parent/child branch 使用同一 extension entry；只有经过受验证的 child identity 环境才进入 child branch。
- 定义最小 domain types：child identity、public state/mode、effective launch config、tool input/result 和 protocol version。
- 按 `<cwd>/.pi/agents`、`<cwd>/.agents/agents`、`~/.pi/agent/agents` 实现确定性的 agent discovery/precedence。
- 复用 Pi `parseFrontmatter`，再对 `unknown` 做 runtime schema validation；不自写 YAML parser。
- 使用 `ctx.modelRegistry.find(provider, id)` 精确解析 model；parent model/thinking 只作为显式默认值。
- 解析 tools/extensions/skills，并保证 child bridge必需的 `contact_parent` 不会被 allow/deny policy意外移除。
- 形成 immutable、非 secret effective policy snapshot；未知/未兑现字段在启动前失败。

**不在本 ticket**

- 不创建 runner、session、registry、IPC 或 model-facing tools。
- 不支持 `exclude_extensions`、`preload_skills`、`max_turns`、`max_tokens`。
- 不提取没有第二个实际调用方的 ext-core helper。

**验收**

- extension 在 parent context 中加载，child identity 缺失/损坏时不会误进 child branch。
- 同名 agent 的 precedence 确定；无效 frontmatter、未知模型和 resource 冲突返回可读错误。
- 默认 model/thinking 与 agent override 的来源出现在 resolved result，不发生 fuzzy/silent routing。
- `extensions: false` 仍保留本 extension 的绝对 `-e` child bridge，同时关闭 discovery。
- tests证明未兑现字段不会被静默忽略。

**验证**：resolver/schema/precedence/model/resource focused Vitest；package Biome；package typecheck。

**依赖**：无。

状态：`[x]`

---

## SUB-02：实现 registry、launch spec 与 session bootstrap

**目标**：在启动进程前可靠保存 child identity、初始任务和可复现启动配置。

**范围**

- 使用独立、按 `parentSessionId` 隔离的 JSON registry；不写 `settings.json`。
- 复用 ext-core `readJsonSettingsRoot` / `updateJsonSettingsRoot` 的跨进程锁与原子替换。
- 为 registry root、child record、runtime metadata、first-flush state 和 launch config 增加 runtime validation/version。
- 实现 ownership/revision/runtimeIdentity 条件更新，防止旧 callback 删除或覆盖新 runtime。
- 定义唯一 launch-spec builder：解析 Pi invocation、argv、cwd、session、model/thinking、resources、prompt和bridge env。
- 只有出现第二个 Pi invocation resolution 调用方时，才把该已证实 helper 提取到 ext-core public export；否则保留 package-local。
- spawn bootstrap 在进程启动前生成 child/session ID，保存 initial task、target session path和effective config。
- 区分never-flushed与flushed session；never-flushed recovery显式复用原session ID，flushed recovery核对path/header/session ID。

**不在本 ticket**

- 不启动 runner或Pi RPC。
- 不把registry当作liveness证明，不保存API key或可变connection对象。
- 不建立SQLite、event ledger或handoff history。

**验收**

- 并发更新不同children不会丢字段；同一child的stale revision更新被拒绝。
- 损坏、未知版本、parent mismatch或session ID mismatch均fail closed。
- 初始task在任何process启动前已可恢复；registry写失败时不会启动child。
- RPC/TUI/replacement从同一config构造的launch spec只在mode/stdio/presentation字段不同。
- 带空格的binary、extension和session路径保持一个argv元素；secret不进入registry snapshot。
- never-flushed session不会因为open不存在文件而换成随机ID。

**验证**：registry concurrency/corruption/ownership tests；launch argv snapshot tests；first-flush/session identity tests；changed package和ext-core paths Biome/typecheck。

**依赖**：SUB-01。

**後續修正** `[x]`：child session 改寫到 `agents/` 子目錄（Pi 非遞迴列舉會話，避免 delegated session 出現在人的 session 列表），child branch 首次 bind 時寫入 session title `🤖 <title>`（`spawn_agent` 新增可選 `title`，未提供時由 agent 名與 child id 推導，該 title 隨 launch config 凍結進 registry 並在重啟時重新套用）；registry 仍記錄顯式 sessionDir/sessionPath，recovery 路徑不變。

状态：`[x]`

---

## SUB-03：实现独立 runner、可重连 IPC 与 Pi RPC adapter

**目标**：启动一个不依赖 parent stdio 存活的 runner，由它拥有 child Pi RPC并提供受身份保护的重连endpoint。

**范围**

- 增加runner process entry；使用SUB-02预解析的Pi invocation和launch spec，不在runner内重新猜CLI路径。
- runner自行持有child stdin/stdout/stderr，并启动真实`pi --mode rpc`和持久session。
- 实现长度受限的local JSON-line IPC：versioned handshake、parent/subagent/runtime identity、request IDs、events/responses分流。
- controller同一时刻只允许一个；新认证controller撤销旧连接权限，旧请求有明确失败。
- 实现本规格需要的薄Pi RPC命令转发，不复制完整RpcClient，不增加Pi不存在的resume命令。
- 限制frame bytes、pending requests和event buffering；malformed input、duplicate request ID和overflow关闭对应请求/连接并报告。
- timeout、AbortSignal、disconnect、child exit和shutdown释放pending promises、listeners、socket和process资源。
- 只有真实Pi RPC response与child bridge handshake完成后才宣布ready；固定sleep不得作为readiness。

**不在本 ticket**

- 不注册model-facing tools或`contact_parent`。
- 不实现跨parent restart recovery、replacement claim、TUI或HostAdapter。
- 不增加global daemon/scheduler。

**验收**

- parent connector断开后runner和child继续存活；同identity的新connector可重连。
- second controller不能与first同时控制；旧controller的late frames不能修改新连接状态。
- child stdout保持纯RPC JSONL，runner diagnostics走stderr。
- frame/pending上限、malformed response、timeout、cancel和unexpected child exit均有限结束且无unhandled rejection。
- runner shutdown不遗留socket文件或child process；parent connector cleanup本身不终止runner。

**验证**：IPC protocol/identity/limits tests；真实Pi RPC smoke（spawn、ready、一个prompt、shutdown）；process cleanup tests；package Biome/typecheck。

**依赖**：SUB-02。

状态：`[x]`

---

## SUB-04：打通 ParentChannel、child branch 与核心 tools

**目标**：形成第一个可运行的端到端RPC闭环：spawn、双向通信、查询和并行children。

**范围**

- 实现SubagentManager，拥有per-child rejection-safe transition chain和parent-session lifecycle binding。
- parent branch注册`spawn_subagent`、`send_subagent`、`get_subagent`、`list_subagents`；`stop_subagent`先接入接口，完整停止语义由SUB-05完成。
- `spawn_subagent`使用SUB-01 policy、SUB-02 registry/launch和SUB-03 runner；不暴露runtime policy参数。
- child branch只注册`contact_parent`、status和后续pause所需的bridge hooks；不注册manager或spawn tools。
- ParentChannel复用runner IPC：parent输入映射到Pi prompt/steer/follow-up，child report映射到parent delivery/notification。
- 为report附带child ID、parent ID、task anchor和status；parent把它包装为delegated result，不提升为用户授权。
- parent离线时实现固定容量的待确认report队列；重新连接后按identity投递，overflow返回child tool error。
- 多个spawn tool calls不经过batch API，可独立并发；同一child mutation串行。

**不在本 ticket**

- 不实现attach/detach、HostAdapter、restart recovery或复杂UI。
- 不增加`spawn_subagents`、wait/poll tool或terminal scraping。

**验收**

- 主Pi可同时spawn至少三个独立child sessions，每个有独立runner、registry record和RPC writer。
- parent可向running/idle child发送明确steer/follow-up；非法state返回错误。
- child可发四种`contact_parent`reason；错误identity不能串到另一个parent/child。
- parent disconnect不会阻塞child report；queue满时失败可见且内存有界。
- get/list只显示可确认live或last-known状态，并标记数据新鲜度。
- extension child branch不能递归spawn subagent。

**验证**：tool schema/result tests；ParentChannel identity/offline/backpressure tests；parallel children behavioral test；真实Pi end-to-end smoke（spawn、send、contact parent、query）。

**依赖**：SUB-03。

状态：`[x]`

---

## SUB-05：完成 stop、状态、summary 与 usage

**目标**：让RPC-only V1闭环具备正确终止和可信观测，而不是只有能启动的happy path。

**范围**

- 完成`stop_subagent`与human control入口共用的manager operation。
- stop顺序固定为：persist stopped intent -> set closing/abort -> release waits -> terminate writer/runner -> conditional metadata cleanup。
- stop幂等；process exit callback看到stopped后不触发restart。
- 从Pi events/session entries归一化running/idle/done/failed和last assistant summary。
- 记录interrupted diagnostic，不新增public state。
- 聚合已完成assistant turns的input/output/cache/cost/turns；缺失或非法provider数字明确处理。
- reconnect/event replay使用turn/message identity去重，避免usage重复累计。
- 所有tool result保留完整内容；collapsed UI只改变presentation。
- 为tool/manager操作落实统一error envelope：操作、child、原因、副作用、当前状态、安全重试条件。

**验收**

- running、idle和already-stopped child均可安全stop；重复stop不重启、不重复终止。
- stop与send/spawn callback交错时，stopped意图获胜，late ready/exit不能复活child。
- summary来自当前session branch最后有效assistant输出；failed/interrupted/stopped明确区分。
- usage跨多turn正确累计，reconnect同一事件不重复；不可用cost不伪造为可信billing。
- timeout、unknown exception和cleanup failure在有限deadline内返回，transition chain继续接受后续安全查询。

**验证**：stop ordering/idempotency/race tests；state/summary/current-branch tests；usage dedupe tests；error-envelope/deadline/queue-release tests；RPC-only end-to-end smoke。

**依赖**：SUB-04。

状态：`[x]`

---

## SUB-P1：投递话术与 child nudge

**目标**：让模型把 `contact_parent` 当成完成/报告通道，而不是靠 `get_subagent` / `list_subagents` 轮询。

**范围**

- 按 [`PLAN-delivery-presentation.md`](PLAN-delivery-presentation.md) §3.1 改写 parent/child 工具 description、spawn/send 的 promptSnippet，以及 `CHILD_BRIDGE_PROMPT`。
- 从 maplezzk `subagent-done.ts` 借入 `scheduleAgentEndNudge`，改为提醒 `contact_parent`；不写 sidecar、不退出 session。
- 保持 spawn 等到 ready；保持 `deliverAs: "nextTurn"`。
- 同步 `spec.md` 投递段落与 package README 工具表。

**不在本 ticket**

- 不新增 tool、不改 runner/IPC、不做 widget、不写 activity 文件。

**验收**

- spawn/send 文案明确禁止轮询等待；`get`/`list` 标明只用于检查状态。
- child 正常 `agent_end` 且本 turn 未 `contact_parent` 时，延迟 follow-up nudge；用户输入或再次 agent 活动取消 nudge。
- 现有 spawn/send/contact 行为测试仍过。

**验证**：tools/launch-spec/extension focused Vitest；package Biome。

**依赖**：SUB-05。

状态：`[x]`

---

## SUB-P2：activity sidecar

状态：`[-]` 明确不做。maplezzk 用磁盘 JSON 当状态总线，是因为没有 runner IPC。本包观测走 Pi events + `contact_parent`；TUI 若需要粗标签，归 SUB-08 在现有 IPC 上加 frame。见计划 §3.2。

---

## SUB-P3：interactive 策略位

**目标**：把 `interactive` 冻进 LaunchSpec。Interactive child 除 `contact_parent` 外不得 `triggerTurn` 叫醒 parent。

**范围**

- agent frontmatter `interactive: boolean`，缺省 `false`，非法值启动前失败。
- 写入 `ResolvedAgentPolicy` / `EffectiveLaunchConfig`；RPC/TUI/restart 复用。
- `PublicSubagent` 暴露只读 `interactive`。
- Recovery failure 仍通知 parent（parent 自己的诊断）。不实现 snapshot stall ping。

**不在本 ticket**

- 不引入 `auto-exit`、activity 文件、`pi-subagent-stall`、widget。

**验收**

- 缺省 false；`true`/`false` 之外启动前失败。
- 解析来源出现在 resolved policy。
- 现有投递测试：`contact_parent` 两种模式都叫醒；无新的自动 stall 消息。

**验证**：resolver + launch-spec + manager 投递 focused tests；package Biome。

**依赖**：SUB-P1。

状态：`[x]`

---

## SUB-P4：无边框 widget 投影

**目标**：above-editor widget 只投影 registry 里的活 child，不持有第二份 running set，不画边框。

**范围**

- 按 `pi-ext-tools` Todo widget：`registerWidget` + 标题行 + child 行；`truncateToWidth` 与 theme token。
- 可见：`starting | running | idle`；隐藏终态（`done | stopped | failed`）。
- 无可见 child 时 `setVisible(false)`。刷新跟 list/state，不轮询文件。
- 更新 `DESIGN.md` 一句 pi-subagents widget 合同，以及 spec §8。

**不在本 ticket**

- 不增加边框、`hiddenFromWidget`、attach 快捷键、agent picker、activity 读取。

**验收**

- widget 输入只能来自 `list()`；测试里改 registry 即改变渲染。
- 窄/宽宽度不打乱 identity 与状态；reload 后无 widget 泄漏。
- headless parent 不挂 widget。

**验证**：widget 窄/宽 layout tests；extension lifecycle cleanup test；package Biome。

**依赖**：SUB-P3。

状态：`[x]`

---

## SUB-P-X：用户级 child 扩展挑选器

状态：`[-]` 明确不做。Child 扩展只来自冻结的 agent `extensions` + 本包 `-e` bridge。见计划 §3.5。

---

## SUB-06：实现 reload/restart recovery 与原子 replacement claim

**目标**：parent branch消失后优先接回存活runner，只在旧runner和writer确认死亡时安全创建replacement。

**范围**

- parent `session_start`/reload从当前`parentSessionId` registry加载active children；fork/new parent session不继承控制权。
- parent shutdown/reload只释放connector、subscriptions和UI；不把活child stop注册进lifecycle cleanup。
- 按endpoint/runtimeIdentity执行ownership handshake和live state query；live runner优先adopt。
- 为所有replacement入口实现一个跨进程原子claim operation：锁内重新读取active/stopped/ownership并条件写入claim。
- claim在spawn前预存claimId、holder identity、new runtimeIdentity和endpoint。
- runner自行登记；启动writer前再次确认claim有效且child未stopped，start/stop串行。
- claim holder崩溃后，检查预存endpoint和holder/runner/writer liveness；不能只靠TTL或endpoint无响应抢占。
- 确认全部死亡才replacement；状态不明时返回错误，不启动第二个writer。
- replacement打开同一session和effective config，只等待新输入；中断工作和待确认消息不自动重放。

**不在本 ticket**

- 不恢复旧PID，不自动打开TUI，不实现handoff。
- 不把registry last-known `running`当作liveness。

**验收**

- parent reload后重连原runner，不增加writer、runner或usage。
- 两个parent process同时recover同一死亡runtime时，只有一个claim holder和一个replacement writer。
- holder在claim前、runner spawn后、registration前和writer start前崩溃的路径均不会重复启动。
- stop与replacement交错时stopped child不被激活；stale runner registration/cleanup不能覆盖新runtime。
- never-flushed child保留原session ID和initial task，标记interrupted但不重发；flushed file丢失明确失败。
- liveness不明与cleanup超时均在deadline内报错，后续get/list仍可执行。

**验证**：multi-process registry/claim race tests；runner crash-window tests；parent reload/reconnect smoke；first-flush recovery matrix；root typecheck和受影响tests。

**依赖**：SUB-05。

状态：`[x]`

---

## SUB-07：实现 Herdr/cmux HostAdapters

**目标**：提供只负责原生terminal承载的可观察HostAdapter，不触碰child语义或handoff决策。

**范围**

- 定义最小HostAdapter port：capability probe、attach launch、attachment identity、process observation、owned cleanup。
- 实现Herdr adapter，调用真实Herdr CLI；环境、workspace/pane和command失败分类清楚。
- 实现cmux adapter，调用真实cmux primitive；不存在或不可用时返回可解释capability failure。
- host selection遵循显式用户选择；无显式选择时采用文档化默认顺序，记录selected host/fallback reason。
- adapter只接收SUB-02 launch spec；不得重解析agent/model/resources或拼第二份Pi argv。
- attachment带独立identity；只清理本次创建且仍归当前transition拥有的pane/process。
- host command timeout不等于Pi process死亡；保留可核对的attachment/process信息。

**不在本 ticket**

- 不接入RPC pause/exit或完整attach transition。
- 不读取pane screen、不分析terminal文本、不自动fallback执行已接受的child task。

**验收**

- capability probe不会只凭binary存在宣称host可用。
- Herdr与cmux均用同一session/effective config启动真实native Pi TUI。
- 显式host不可用时可见失败；默认selection/fallback全程可观察，不静默routing。
- command超时但process实际启动时，adapter不会报告“已回滚”或自动再开一个process。
- stale attachment callback/cleanup不能关闭新pane或用户已切换的session。

**验证**：adapter argv/error/ownership tests；可用host的真实native Pi launch smoke；不可用host deterministic tests；package Biome/typecheck。

**依赖**：SUB-02、SUB-06。

状态：`[x]`

---

## SUB-08：实现安全 RPC → TUI attach（已被取代）

状态：`[—]` **已被 [`PLAN-panel-bridge.md`](PLAN-panel-bridge.md) 取代（2026-10-01）**。attach/detach、
pause handshake、`close_writer`/`start_rpc`、独立 runner 与 replacement claim 已从实现中删除；child 由
bridge 控制面驱动，呈现方式在 spawn 时决定（当前为后台 headless，panel 呈现属取代计划的 Stage 3）。
本 ticket 保留为历史背景，不再是当前行为的来源。

**目标**：在不中断当前tool call、不丢输入且不产生第二个writer的前提下，把同一child session交给native Pi TUI。

**V1 已落地（idle-only）**：idle RPC child 可 `/subagents attach <id>`；busy child 可见失败并保留 RPC；冻结 send、close_writer、HostAdapter 启动同一 LaunchSpec 的 native TUI、失败恢复 RPC 且不重放 pending input。

**范围（剩余：active pause handshake，Pi `>=0.87.0`）**

本包 peer/devDependency 升到 `@earendil-works/pi-coding-agent` `>=0.87.0` / `0.87.0`；不在本 ticket 全仓 bump `pi-tui` patch。

- runner 丢掉 `message_update` / `tool_execution_update` 等 partial，只向 parent 转发 `turn_*`、`agent_*`、`contact_parent`、lifecycle。
- ParentChannel/child branch：versioned pause、paused ack、closing/cancel、input gate。
- idle：关 gate 后直接 ack。
- running：等当前 Pi turn（一次 LLM + 该轮全部 tool）结束；child 在 `turn_end` 里 await，直到 parent `close_writer` 或 cancel/timeout。该钩子在 0.87.0 里挂在 `finishTurn` 上，能挡住下一轮 LLM 和 turn 后 compaction。
- 不得把 `continue: false` 当 stop；不得 `continue: true`；不得等 `agent_end`/`agent_settled`；不得用 RPC `abort`。
- pause 挂起时 `cache_warming_decision` 返回 `{ action: "stop" }`；ack 后可选 `clear_queue`。
- pause timeout/cancel 发生在旧 RPC 退出前：放钩子、解冻、保留 RPC、可见失败。不 abort 正在跑的 tool。

**已完成范围**

- 增加human attach action/shortcut和manager internal operation；暂不新增model-facing attach tool。
- attach开始即冻结新输入；busy 时不解冻失败前保留 RPC。
- 确认 idle 后禁止parent steer/follow-up，关闭RPC writer并确认process/stdio writer退出。
- 旧writer确认退出后调用SUB-07 HostAdapter，用同session/effective config启动native TUI。
- 旧RPC已退出、TUI确认未启动/已退出：恢复RPC等待输入，attach仍报错并包含恢复结果。
- 新TUI/旧writer状态不明：不启动其他writer，保留observability并在deadline内报错。

**验收（idle 路径）**

- idle child不等待不存在的下一次turn_end。
- 关闭 writer 到 TUI ready期间同session始终至多一个受管理writer。
- 已退出后pane创建失败恢复RPC但不静默重放输入。
- host timeout但TUI实际启动时不重复启动writer、不虚报rollback。
- attach等待期间stop/cancel不死锁，transition queue最终释放。
- session尚未首次落盘时明确拒绝attach并保留RPC。
- running child 在本 turn 的 `turn_end` 卡住并 ack 后才 close_writer；超时则保留 RPC。

**验证**：idle attach tests 保持；pause gate tests（idle ack、turn_end hold、timeout 放钩子、stop 不死锁、cache warming stop、partial events 不转发）；package 对 Pi 0.87.0 typecheck。全仓 pin 不在本 ticket。

**依赖**：SUB-06、SUB-07。

状态：idle attach `[x]`；active pause handshake `[x]`

后续修正 `[x]`（当前契约见 [`spec.md`](../../pi-subagents/spec.md) §7.3/§8）：

- close_writer 不再对旧 writer 发 RPC `abort`：结束其 stdin 让 Pi 自行 shutdown，被 hold 的回合在进程退出前保持，attach 不再中断正在跑的那一轮。
- attach 成功后不再把 child 留在 frozen 集合里；TUI 期间的 send 拒绝不再复用 "frozen for attach" 文案，并标记为不可重试。
- `mode=tui` 期间旧 writer 的残留事件（含 `writer_exit`）不再写回 state，也不再把已 attach 的 idle child 当作可 hibernate。
- Herdr attach 改为开新 tab（`tab create` + root pane `pane run`，cleanup 关 tab），不再 split 当前 pane。

---

## SUB-09：实现 detach、TUI session switch 与用户中断语义

**目标**：TUI离开受管理child后安全撤销attachment，并让原child回到RPC等待输入；用户暂停不会被误当自动续跑。

**范围**

- 观察真实TUI process exit与child bridge session lifecycle；pane close event只能触发核查，不能单独证明writer死亡。
- 已确认TUI exit且child未stopped时走detach，使用同runner/session/effective config恢复RPC等待输入。
- `/quit`、Ctrl+D、pane close和TUI crash使用同一detach产品语义；异常退出额外报告。
- 处理native TUI `/new`、`/resume`、`/fork`：只有确认进入session B且A writer释放后才解绑A。
- 解绑时撤销旧child bridge credential、PID/pane ownership和callbacks；B不成为subagent。
- `/resume`当前A与`/reload`不detach；switch request、session_shutdown或失败switch不提前恢复A。
- 明确识别可证实的用户中断，包括tool执行时abort的Pi语义；通知parent任务未完成并等待用户意图。
- crash/来源不明不能冒充用户暂停；普通中断且TUI仍在A时不重建RPC。
- detach recovery沿用SUB-06 claim和统一错误合同；stopped child不恢复。

**验收**

- 每种confirmed process exit都使非stopped A回到一个RPC writer；异常退出有额外diagnostic。
- pane event但process仍活时不kill、不detach、不启动RPC。
- 成功切到B后，A回RPC；A的stop/send/late exit不影响B，B不能以A身份`contact_parent`。
- switch取消/失败不提前恢复A；writer状态不明时错误返回且不开第二writer。
- 直接原生`/resume`运行中A保持Pi行为，不增加拦截或自动接管。
- 用户中断通知包含child和last activity；没有明确继续输入时不重发initial/pending task。

**验证**：manager process/pane/session-switch/interrupt tests；child-bridge reload vs leave tests；runner `bridge_unbound` after `left_session`；package Vitest/Biome/typecheck. 真实 Herdr/cmux TUI→RPC smoke 取决于本机 host，未作为默认 CI。

**依赖**：SUB-08（已取代）。

状态：detach `[—]`（随 SUB-08 一并删除）；session switch 与 user interrupt `[x]`，现由 `child_lifecycle`
的 `left_session` / `user_interrupt` 事件承载（契约见 [`spec.md`](../../pi-subagents/spec.md) §7.4）。

---

## SUB-11：bridge 控制面与 panel 默认呈现（取代 SUB-03/SUB-06/SUB-08/SUB-09 的 transport 部分）

**目标**：把 parent→child 的控制从 RPC writer 换成 child bridge，让 child 的呈现方式在 spawn 时决定。

**已落地（Stage 1–2）**

- parent 进程自己监听唯一 socket（`<runtimeDir>/parent-<parentSessionId>.sock`，0700/0600），每个 child
  一条可重连连接；请求（prompt/steer/follow_up/get_state/get_entries/abort/shutdown）、报告
  （contact_parent/task_result）、Pi 事件、`child_lifecycle`、`child_input` 都走这条连接。
- child 侧请求分发、事件转发、断线重连与有界报告缓冲；per-runtime token 保存在 `runtimeDir` 的 0600
  文件里，使 parent 重启后仍能认证重连的 child。
- `spawn_agent` 由 parent 直接 spawn headless child（`--mode rpc`，stdin 由 parent 持有），bridge 就绪后
  才投递 initial task；空闲 60s 回收 runtime（`done`），`send_agent` 用同一 session 自动恢复。
- 删除：独立 runner 进程与 endpoint/claim/handshake、`rpc-adapter`、`connector`（旧）、`pause-gate`、
  attach/detach/`restoreRpc`、host watch、`#frozen`、`writer_exit` 语义、`get_session_stats`、attach
  verb 与 attach 快捷键。

**已落地（Stage 3–4）**

- HostAdapter `attach` → `open`，并新增 `focused` 观察与 `reportsFocus` 能力：herdr 用 `tab list` +
  `workspace list`（两层都 focused 才算聚焦），cmux 未知因此 fail open（`TODO(cmux-focus)`）；herdr
  `tab create` 增加 `--label <subagentId>`。
- `spawn_agent` 默认把 child 开成 herdr 新 tab / cmux 新 surface（`presentation: "panel"`），没有 host 时
  退回后台并在结果里说明原因；`task` 固定后台。panel child 由 host 持有进程，parent 只保留 attachment。
- panel 生命周期：stop 关闭 panel 并以 `observe()` 确认其消失；idle 倒计时到期时先看聚焦（聚焦或不可判定
  就重新计时）；人工输入（`child_input` source=interactive）取消倒计时；child runtime 消失时释放 panel；
  本进程不持有 runtime 的 child（parent 重启后 adopt）不参与回收。
- `mode` 改名 `presentation: "panel" | "background"`（不做兼容读取，旧记录报错并提示删除）。

**收口后的第三轮自检（2026-10-02，全仓 open-code-review）**

- child 侧 `task_result` 改为原样透传已校验的 payload（此前重组丢字段，Task 结果被 parent 忽略）；
- bridge 去重按 runtimeIdentity + request id，同时在途的重复请求共享同一结果，child 的 request id 带实例前缀；
- parent 重启后未重连的 panel runtime 记为「未确认」（send 拒绝、只由 stop 清除），后台 child 的 runtime 证据清掉并记 interrupted；
- runtime token 按 parent session 分文件；host `open` 抛错按「结果未知」保留 token 与证据；
- child 侧 `reload` 也销毁 bridge client；adopt 用 `get_state` 同步 projector；idle 回收会被期间的 child 信号作废；
- `contact_parent`/`task_result` 透传 tool 的 `AbortSignal`；无法编码的 advisory frame 丢弃而不断连。

**已落地（生命周期收口）**

生命周期收口（2026-10-02）：人工关 panel / 已确认的外部 panel 进程退出 / `stop_agent` 都是终止，send 明确拒绝、`safeToRetry=false` 并提示新建 child。成功的系统 idle 回收仍可恢复同一 session，迟到断线不改成 stopped；adopted panel 断线且退出不可观察时保持明确拒绝。无 panel 身份持久化或恢复探测。

**未落地（Stage 5 剩余）**

- 真实机器端到端 smoke 的常规化（Stage 2 与 Stage 3–4 已各手动跑过一次）。

**验证**：bridge server/client/child-control 单测、manager bridge 与 panel 生命周期契约测试、runtime/
child-process 单测、host-adapter 单测（含真实 herdr 的 live tab smoke）、package typecheck 与 build；
真实的 panel 端到端（真实 Pi TUI 在 herdr 新 tab 中被 bridge 驱动、观察聚焦、关闭 tab）已在本次改动中
手动执行一次。

---

## SUB-10：完成最小UX、文档与端到端release gate

**目标**：让已完成的生命周期可由用户操作和诊断，并把public contract、文档与发布验证收口。

**范围**

- 使用Pi `ctx.ui.select`提供agent/child选择；用`setStatus`展示紧凑active/running/idle/interrupted/failed状态。
- 接入attach与stop快捷键；快捷键调用现有manager operation，不复制transition逻辑。
- 使用ext-core ToolTui展示spawn/send/get/list/stop完整结果；collapsed view保留artifact/output引用。
- 活 child 列表 widget 由 SUB-P4 提供；本 ticket 只补 attach/stop 操作面，不再重做投影。
- 更新package README、`docs/architecture/`高层设计和必要ADR；标明与ext-core in-process subagent execution contract的边界。
- 将`PLAN.md`与`PLAN-delivery-presentation.md`标记为设计来源，将`spec.md`标记为当前实现合同，tickets记录最终证据。
- 删除施工中产生的obsolete API、duplicate launch path、debug flags和compat shim。

**验收**

- 用户可在interactive Pi中选择child、attach和stop；headless/RPC仍可通过tools完成所有model-facing操作。
- 窄/宽terminal下状态和tool output不截断关键identity/error，ANSI宽度安全。
- reload后没有parent listener、widget、connector或timer泄漏；活runner仍可重连。
- Scenario A-I与spec失败矩阵全部有自动化或真实smoke证据。
- repository中只有一个agent resolution path、一个launch builder和一个manager transition owner。
- README/architecture/ADR不宣称自动续跑、阻止原生`/resume`或使用ext-core `startSubagent`提供durability。

**验证**

1. 运行 package Biome、focused Vitest 和 package typecheck。
2. 根目录全量 gate 在本 ticket 收口时执行；外部 tag/push/publish 仍需明确批准。
3. 真实 Pi attach→TUI→detach 依赖可用 Herdr 或 cmux；host 启动失败路径由 HostAdapter 单测覆盖。
4. Scenario A–I 由 package 单测覆盖后台 spawn/send/stop、idle attach、detach/switch/interrupt、recovery 与 UX 投影；不是真实 multiplexer smoke。

**依赖**：SUB-09、SUB-P4。

状态：`[x]`（UX/docs/package gate；全仓 release dry-run 与真实 TUI smoke 仍需本机 host）

---

## 依赖图

```text
SUB-01 Agent policy/package
  |
SUB-02 Registry/launch/session identity
  |
SUB-03 Runner/IPC/Pi RPC
  |
SUB-04 Channel + core tools
  |
SUB-05 Stop/status/usage       <- RPC-only usable milestone
  | \
  |  SUB-P1 话术 + nudge
  |    |
  |  SUB-P3 interactive 位
  |    |
  |  SUB-P4 无边框 widget
  |
SUB-06 Recovery/claims
  |\
  | SUB-07 HostAdapters
  | /
SUB-08 Safe attach
  |
SUB-09 Detach/switch/interrupt
  |
SUB-10 UX/docs/release gate
```


---

## SUB-12：会话租约只记录 intent 与 attachment

**目标**：把一个父会话的 subagent 所有权收成 `ConversationLease`。磁盘只留崩溃后必须接着做的决定。

**模块**：`ConversationLease`。调用方和测试只使用 `commit(edge)` 与 `roster()`。`open` / `ready` 属于 SUB-13，本 ticket 不实现。

**范围**

- 租约写在现有的按 `parentSessionId` 隔离的 registry JSON 里。不新建 ledger，不引入 SQLite。
- `commit` 只接受 `spawn-intent`、`attachment-bound`、`stop-intent`、`runtime-gone`、`left-session`。第一次写入有效；旧 revision 不能覆盖新 attachment。
- spawn 在进程启动前写 `intent=run`。宿主或 pid 交回句柄时写一次 attachment（Herdr tab、cmux surface 或 pid）。
- stop 在 kill 之前写 `intent=stop`，确认退出后再清 attachment。
- usage、activeTool、summary、working、socket 不再写入 registry。投影留在内存。
- background 的 stdin 写端留在进程内，`session_shutdown` 不关闭它。pid 写入租约。

**不在本 ticket**

- 不对账，不回灌，不改 `before_agent_start`。
- 不把 lease 抽到 ext-core。只有这一处调用方。
- 不改 child branch 的 leave/cancel 接线（SUB-14）。

**验收**

- 经过接口：连续的 usage/tool 事件零次 registry 写；spawn 两次写，stop 两次写。
- stale revision 盖不住新的 tab id。fork 不会在本 ticket 出现；本 ticket 只保证记录按 `parentSessionId` 隔离。
- registry 损坏、未知版本、parent mismatch 仍然 fail closed。
- `session_shutdown` 之后，测试里的 background pid 仍可被观察到，stdin 写端没有被关掉。

**验证**：lease commit/roster focused Vitest；registry 写次数测试；package Biome；package typecheck。

**依赖**：已落地的 registry 与 HostAdapter。

状态：`[x]`

---

## SUB-13：父边界对账，并在 turn 前回到会话状态

**目标**：重新打开父会话时，`before_agent_start` 之前账本已经对完。模型看到的是原来的 child，不是一个会去开 panel 的工具。

**模块**：同一个 `ConversationLease`。本 ticket 补上 `open(boundary)` 和 `ready()`。

**seam**：`HostDirectory`。生产 adapter 包现有 Herdr/cmux 的列表和开 panel；测试用内存 adapter。接口上没有 CLI 参数。

**范围**

- `session_start` 调用 `open`。`before_agent_start` 调用 `ready()`，未完成就等到完成。
- `startup` / `resume` / `reload`：列表里还在的 tab、surface 或活着的 pid 只重绑，不开第二个，这次重绑不写盘。
- `fork` / `new`：`roster()` 为空，不复制旧 attachment。
- cancel 不调用 lease。
- 列表未知：`ready()` 继续等，不新开进程。
- 宿主是新一代，且 `intent=run` 仍带 attachment 的 panel 全部不在：`ready()` 返回前用同一 session 回灌这些 panel。每个新 tab 写一次。idle 回收或 `intent=stop` 的不开。
- 宿主还活着、只有一个 tab 不在：只 `commit(stop-intent)` 那一个。
- background 不回灌。resume 时 pid 已死则 `commit(runtime-gone)`。同一进程 reload 且 pid 仍在则只重绑。
- 人用原生 `/resume` 占住 child session 时保持未知，不回灌。

**不在本 ticket**

- 不改 child branch 对 reload、fork、cancel 的上报（SUB-14）。回灌不得把 SUB-14 会写成 `left-session` 的 child 拉起；本 ticket 的测试用 `commit(left-session)` 直接放入这个前提。
- 不自动重放中断的 turn 或未确认输入。
- 不把 `ready()` 暴露成模型工具。

**验收**

- 测试只通过 `open`、`ready`、`roster` 和内存 `HostDirectory`。
- reload：原 tab 还在，panel 数不变，registry 写次数为 0。
- fork：新会话 roster 为空，旧会话 attachment 还在。
- cancel：账本字节不变。
- Herdr 新一代：两个当时开着的 panel 在 `ready()` 前回来，一个已 stop 的不回来。
- 列表未知时 `ready()` 不返回成功，且 `open` 次数不增加。
- 单 tab 消失：只有该 child 变成 `intent=stop`。
- 原生占用的 child session 不被回灌。

**验证**：lease parent-boundary focused Vitest（内存 HostDirectory）；package Biome；package typecheck。

**依赖**：SUB-12。

状态：`[x]`

---

## SUB-14：子边界把 leave、cancel 和单 panel 关闭交给租约

**目标**：子进程的 reload、resume、fork、cancel、kill 只改变 §7.7 允许改变的那些事实。

**模块**：同一个 `ConversationLease`。child branch 和 parent 收到 lifecycle 之后只 `commit`，不自己改 registry。

**范围**

- child reload：销毁旧 bridge client，新 client 重拨。不 `commit`。父进程的 attachment 还在。
- resume 同一 session：不 `commit`。
- resume 到别的 session、fork 或 new：`commit(left-session)`。不关 panel，收回 token。
- child cancel：不 `commit`。
- 宿主仍活着时，这一个 panel 被关或这个进程退出：`commit(stop-intent)`，确认后 `commit(runtime-gone)`。不自动复活。
- parent 在 `left-session` 之后的 `open` 不得回灌这个 child，也不得把输入送进新 session。

**不在本 ticket**

- 不新增模型工具。
- 不拦截人直接原生 `/resume` 同一 child session。该情况保持未知。
- 不把 nudge、投递或 usage 重新写回 registry。

**验收**

- child reload 后仍是同一个 attachment，registry 写次数为 0，bridge 只有一个 client。
- child fork 之后父 roster 不再持有 attachment，原 panel 没被关闭，token 不能再通过 handshake。
- child cancel 后 intent 仍是 `run`，attachment 还在。
- 关掉一个 tab、宿主和其他 tab 仍在：只有该 child 停止。
- 上述路径之后调用 SUB-13 的 `ready()`，不会为 `left-session` 或 `intent=stop` 的 child 开新 panel。

**验证**：child-boundary focused Vitest；一条 parent `ready()` 交叉测试；package Biome；package typecheck。

**依赖**：SUB-12、SUB-13。

状态：`[x]`


## 里程碑

### M1：后台RPC闭环（SUB-01～SUB-05）

主Pi可并行创建、通信、观察和停止children。此时不承诺跨parent restart recovery或native TUI attach。

### M1b：投递与观测面（SUB-P1、SUB-P3、SUB-P4）

模型不再靠轮询等待报告；interactive 冻进 policy；TUI parent 用无边框 widget 投影活 child。可与 SUB-06 并行。不引入 activity sidecar。

### M2：持久runtime恢复（SUB-06）

parent reload/restart可重连存活runner；确认死亡后可安全replacement，不自动续跑中断任务。

### M5：会话租约（SUB-12～SUB-14）

所有权回到父会话。`before_agent_start` 前对完账。规格在 [`spec.md`](../../pi-subagents/spec.md) §7.7。不在这三项落地前把 attachment 持久化塞进别的 ticket。

### M3：原生TUI handoff（SUB-07～SUB-09）

同一child可在RPC与native TUI之间安全切换，包含失败rollback、session switch和interruption语义。

### M4：可发布V1（SUB-10）

用户操作面、文档、全量验证和release dry-run完成；外部发布仍需用户对具体版本/动作明确批准。

---

## MCP R4：Codex Desktop 内嵌 UI（当前工作线）

**规格**：[`mcp.md`](../../pi-subagents/mcp.md) §2、§4–6。这里延续 R0–R3 已有的 MCP 入口，并将 AgentDock 原生 HTML 的实现模式直接落到 `@hheei/pi-subagents`。上方 SUB-01～SUB-14 是 Pi 原生 V1 的历史 backlog，MCP R4 独立编号。

**已确认的当前基线（2026-10-27）**：

- R0：`src/mcp/delegate.ts` + `SubagentManager.submitDelegation()` 已处理 spawn/reuse；`id` 时原生 steer。
- R1：Standalone headless controller、workspace owner 与 Pi extension 加载已有测试。
- R2：`src/receipts.ts` 与 controller receipt API 已有实现与测试。
- R3：`src/mcp-stdio.ts`、`src/mcp-server.ts`、本地 controller IPC 已接，legacy initialize / stdio 有包内测试。
- R4：`src/mcp/app.html` 是同一份 compact card。Task 与 Dashboard 用 `{{VIEW}}` 区分，构建时复制到 `dist/mcp/app.html`。刷新不重建输入框；终态停止 receipt 轮询。Codex Desktop 实机验收仍是 MCP-R4-05。

### MCP-R4-00：MCP Apps 资源与基础工具接线

**目标**：保留现有 MCP UI 起点，直接进入视图精修，而非重建协议栈。

**现有实现**

- `subagents_delegate` → `ui://hheei/subagents/task`，`subagents_dashboard` → `ui://hheei/subagents/dashboard`。
- `src/mcp-server.ts` 注册资源，并将 `get/list/stop/transcript/receipts/catalog` 等 UI 操作映射到现有 controller/manager。
- `src/mcp/views.ts` 已有 HTML + `ui/initialize`、`tools/call`、2s refresh 的基本路径。

**已验证**：`test/mcp-stdio.test.ts` 的 `tools/list`、`resources/read` MCP JSON-RPC 测试。

**状态**：`[x]`（基础接线；UI 细节归以下 tickets）。

### MCP-R4-01：以 AgentDock 原生 Compact Card 替换当前 views

**目标**：直接移植 AgentDock Task Progress 的视觉与最小 DOM 机制，让子代理卡片默认紧凑、原位展开。

**范围**

- 以 [`agentdock-protocol/mcpapps/app.html`](https://github.com/uvwt/agentdock-protocol/blob/main/mcpapps/app.html)（上游 blob `a0ffc5114507a498013dc8a5bbd572114e23bf5d`）为参照，提取 `:root`/theme CSS、`el()`、`compactShell()`、detail panel、`aria-expanded` 和响应式样式。颜色优先沿用 Codex/host 的语义 token。
- 将 `src/mcp/views.ts` 中的页面字符串收敛为**一个**可选择 `task` / `dashboard` view 的原生 HTML 模板；保留现有 URI、MIME 和工具 metadata。采用 AgentDock 的 `app.html` 模板注入方式，使用当前 MCP Server SDK 注册 resources。
- 静态 HTML 随 package `dist` 发布，编译/打包包含 HTML，`resources/read` 在 clean install 下直接返回可运行页面；不新增 React、Vue、额外前端状态库或 HTTP UI 服务。
- 若直接复制上游 CSS/JS 片段，在文件与发布产物保留源项目、固定版本和 Apache-2.0 归属/许可信息。

**验收**

- 默认仅显示 agent、任务、运行状态、当前活动与紧凑指标；点击后在原地展开，不重新挂载新卡片。
- 样式复用 AgentDock Compact Card 的间距、字体、轻分割线、浅/深主题与窄屏折叠；保留完整数据供详情读取。
- Task/Dashboard 两种 `ui://` URI、descriptor 和 `resources/read` 与现有 Codex 调用合同一致。

**验证**：新增 HTML/DOM 组件测试；`test/mcp-stdio.test.ts`（HTML resource 与 metadata）；package build + clean package asset 检查。

**依赖**：MCP-R4-00。

**状态**：`[x]`

### MCP-R4-02：Task Card 数据归属、实时刷新和正确的 DOM 生命周期

**目标**：将 AgentDock Task Progress 的可靠刷新机制接到当前 child/receipt，不再以刷新整个根节点覆盖用户正在编辑的内容。

**范围**

- 沿用 AgentDock `rpcRequest`/`rpcNotify`、`reportSize` + `ResizeObserver`、`initializeBridge`，处理 `ui/notifications/tool-input`、`tool-result`、`host-context-changed`、`ui/resource-teardown`；bridge request 有 timeout 与 pending cleanup。
- 用工具结果绑定 `childId` **及** `delegationId`；`subagents_get({id})` 更新 runtime 状态，`subagents_receipt({delegationId})` 给出本次委派结算文本。分开呈现 child 的当前运行与 delegation 的最终状态；前一轮结果不会覆盖新一轮 steer。
- 原样采用上游刷新策略：运行中 2s、blocked 10s、RPC 可重试错误 5s；同一个 view 一次只发一个 refresh。采用 generation 防止切换 child 后旧请求覆盖当前卡片，终态 receipt 停止当前 delegation 轮询。
- 隐藏时暂停、重新可见时立即刷新、teardown 时清除 timer 和 pending 请求；`ResizeObserver` 按展开/正文高度变化向宿主报告尺寸。
- 复用稳定 DOM 节点更新可变文本、状态；展开状态、输入焦点、用户已输入的消息、滚动位置与 transcript 不受状态刷新影响。

**验收**

- `wait:false` 首次回执展示任务卡片；从 `accepted/running` 正确过渡到 `completed/blocked/failed/uncertain`，包含最终 `resultText`。
- 多次发送同样 task、同一 child 多次 steer、并行 child、失败重试和 controller 断线后重新连接均正确归属结果。
- 每 2 秒状态刷新不会重建正在编辑的输入框；隐藏/teardown 后不会继续发 RPC；终态不重复请求历史结果。

**验证**：参考上游 `task_live.test.mjs` 的刷新/终态单测；浏览器 DOM/bridge mock 测试（切换/中断/焦点）；receipt/manager 当前聚焦测试。

**依赖**：MCP-R4-01、现有 R2/R3。

**状态**：`[x]`

### MCP-R4-03：展开详情与真实 UI 操作

**目标**：在同一 Task Card 内完成查询、继续发送与停止，交互走现有 manager 控制面。

**范围**

- 详情面板按 `Activity / Output / Diagnostics / Transcript` 展示：状态来自 `subagents_get`，最终结果来自 receipt，transcript 调用 `subagents_transcript({id,cursor?,limit?})` 按需分页。
- 发送消息走 `subagents_delegate({id,task,wait:false})`，始终复用原 child 和原生 `steer`；收到新 `delegationId` 后卡片切换本次回执归属。
- Stop 走 `subagents_stop({id})`，提供明确操作确认；失败保留输入与诊断，操作中锁定对应按钮以阻止重复写入。
- 提示 `blocked / failed / interrupted / disconnected / model_unavailable` 的明确恢复动作；长输出折叠显示摘要，展开时可完整读取原始数据。

**验收**

- UI 内发送 steer 不会创建新 child；同样按钮只提交一次；停止后刷新呈现真实 child 状态。
- 转换标签/刷新状态时已展开的完整 transcript 不丢失，分页 cursor 正确；长正文使用 `textContent` 等安全 DOM API。
- 错误页面保留 child/delegation ID，用户可复制结果、继续或检查历史。

**验证**：DOM 交互测试、重复点击/错误路径、工具 IPC 现有测试、长输出与分页测试。

**依赖**：MCP-R4-02。

**状态**：`[x]`

### MCP-R4-04：Dashboard 复用同一模板与状态组件

**目标**：以 AgentDock 的紧凑列表样式管理多个 child，所有操作复用 Task Card 的原有 MCP 工具和视觉组件。

**范围**

- 同一个 HTML 模板按 view 切换 task/dashboard；复用 CSS token、状态、用量、refresh、错误显示与详情结构。
- `subagents_list` 展示总数、running/blocked/done/failed、child 列表、最后活动；选中某 child 查看详情。
- 新建任务读取 `subagents_catalog` 而非写死 `worker`；派发 `wait:false` 后聚焦新 child；保持列表选择、过滤器与创建输入内容。
- 仅 Dashboard 在可见时刷新列表；选择切换与连续刷新沿用 generation、取消和终态规则。

**验收**

- 多 child 状态各自准确，列表选择后展示对应 child；回到列表保留过滤与滚动位置。
- 新建操作采用当前 workspace 的 agent catalog；panel 状态与 Task Card 中的 child 状态一致。
- 窄屏、空列表、断线、error 与长标题有稳定布局。

**验证**：Dashboard DOM/bridge 测试、列表/选择/筛选/创建状态测试；MCP JSON-RPC resources 回归。

**依赖**：MCP-R4-02、MCP-R4-03。

**状态**：`[x]`

### MCP-R4-05：Codex Desktop UI 验收与发布资源收口

**目标**：以用户真正看到的 Codex Desktop 卡片验收 R4，归档可复现证据。

**范围**

- 用真实 Codex Desktop 调用 `subagents_delegate(wait:false)`、`subagents_dashboard`；依次确认 `tools/list → tools/call → resources/read → ui/initialize → UI 内 tools/call`。
- 手动检查 Compact/展开切换、活动刷新、最终结果、编辑中保持输入焦点、继续 steer、Stop、transcript、多个 child 的 Dashboard、重新打开历史。
- 检查浅/深主题、窄/宽窗口、键盘/辅助技术、长任务、blocked/error/断线状态；记录截图与实测版本于 ticket，不把 CI mock 充作 Desktop 实机结果。
- 运行 MCP package focused tests/build、真实子进程 stdio smoke 与 `npm pack --dry-run`，检查两个 `ui://` resources 的实际 HTML、发布静态文件和上游 Apache-2.0 attribution。
- 只清理此 R4 范围内的临时 UI 接线和冗余视图代码；保留既有 `SubagentManager`、R2 receipt 与 R3 transport。

**验收**

- 真正的 Codex Desktop 对话内嵌卡片可见、可操作；无 Pi TUI 即可完成新任务 → 实时显示 → 结果 → steer / stop。
- Dashboard 能同时管理多个 child，前后台/重启后卡片恢复到正确 child/receipt。
- 代码、HTML 与 npm package 内容可复现，测试与手动 UI 证据记入此 ticket。

**验证**：focused Vitest + package build；实际 Codex Desktop 手动 visual/interaction gate；package asset / license 核查。

**依赖**：MCP-R4-01～04。

**状态**：`[ ]`（自动检查已收口，仍待 Codex Desktop 实机验收）。

**验收前自动检查（2026-10-27）**

- 对照 AgentDock `mcpapps/app.html` 固定 blob `a0ffc5114507a498013dc8a5bbd572114e23bf5d`：保留原生 Compact Card、单一 HTML、主题 token、`ui/initialize`/`tools/call`、稳定 DOM、定时刷新、尺寸通知；不复制 AgentDock 与 Pi 子代理无关的通用工具视图、进度步骤和多语言路由。
- UI 边界补齐：不同 child 的在途 transcript/steer/stop 回应不会覆盖当前选择；切换 child 清除之前的待发草稿，Transcript 标签打开时自动加载新选择；teardown 后停止轮询、旧回执不再触发刷新；工具输入在初始回执前显示任务；Dashboard 只允许从启用的 agent catalog 创建任务；验证宿主 `message.source` 与自适应主题、长输出、transcript 分页。
- 自动测试：`pi-subagents/test` 30 个文件，**350 passed、1 skipped**；`test-integration` 3 个文件，**8 passed**；根 TypeScript typecheck、受影响的 Biome 均通过；npm package build 成功。
- 发包模拟：`npm pack --dry-run --ignore-scripts` 包含 `dist/mcp-stdio.js`、`dist/mcp/app.html`、`NOTICE`、`LICENSES/Apache-2.0.txt`；CLI shebang 和 executable bit 已核对；静态 HTML 保持两种 `ui://` resource 的相同桥接实现。
- 仍需**真实 Codex Desktop** 的卡片出现、点击/键盘操作、主题与窄屏截图、模型工具循环及断线恢复证据。`get_entries` 无范围参数，Transcript 仍由 bridge 全量读取后在 controller 分页，不属于本轮 R4 的重构范围。以上自动检查不能代替 Desktop 实机验收。

### R4 执行顺序与交付点

```text
MCP-R4-00 [x] 现有资源/工具接线
     │
MCP-R4-01 [x] AgentDock Compact Card / 资源打包
     │
MCP-R4-02 [x] 状态/receipt + bridge + 可靠刷新
     ├──────────────────┐
MCP-R4-03 [x] 详情/steer/stop    │
     └──────────────────┤
MCP-R4-04 [x] Dashboard 复用
     │
MCP-R4-05 [ ] Codex Desktop 实机验收（`npm pack --dry-run` 已含 dist/mcp/app.html；Desktop 对话内验收未做）
```

R4 到 R5 的交接点：Codex Desktop 的 Task Card 与 Dashboard 完整可用。R5 继续增加原生 Elicitation 等交互增强；Codex TUI、MCP Tasks、远端 HTTP 归 R6。
