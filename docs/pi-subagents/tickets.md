# pi-subagents V1 Tickets

本 backlog 实现 [`spec.md`](spec.md)。[`PLAN.md`](PLAN.md) 是核心生命周期设计依据；投递话术、interactive 策略与 widget 投影以 [`PLAN-delivery-presentation.md`](PLAN-delivery-presentation.md) 为准。每个 ticket 应形成一个可运行、可验证的 cohesive commit；完成后更新本文件状态。禁止把后续 ticket 的抽象、兼容层或占位实现提前加入。

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

后续修正 `[x]`（当前契约见 [`spec.md`](spec.md) §7.3/§8）：

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
的 `left_session` / `user_interrupt` 事件承载（契约见 [`spec.md`](spec.md) §7.4）。

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

## 里程碑

### M1：后台RPC闭环（SUB-01～SUB-05）

主Pi可并行创建、通信、观察和停止children。此时不承诺跨parent restart recovery或native TUI attach。

### M1b：投递与观测面（SUB-P1、SUB-P3、SUB-P4）

模型不再靠轮询等待报告；interactive 冻进 policy；TUI parent 用无边框 widget 投影活 child。可与 SUB-06 并行。不引入 activity sidecar。

### M2：持久runtime恢复（SUB-06）

parent reload/restart可重连存活runner；确认死亡后可安全replacement，不自动续跑中断任务。

### M3：原生TUI handoff（SUB-07～SUB-09）

同一child可在RPC与native TUI之间安全切换，包含失败rollback、session switch和interruption语义。

### M4：可发布V1（SUB-10）

用户操作面、文档、全量验证和release dry-run完成；外部发布仍需用户对具体版本/动作明确批准。
