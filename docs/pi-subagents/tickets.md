# pi-subagents V1 Tickets

本 backlog 实现 [`spec.md`](spec.md)。[`PLAN.md`](PLAN.md) 是设计依据，不是逐行施工清单。每个 ticket 应形成一个可运行、可验证的 cohesive commit；完成后更新本文件状态。禁止把后续 ticket 的抽象、兼容层或占位实现提前加入。

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
- 若 MCTX 仍是 Pi invocation resolution 的第二调用方，只提取该已证实 helper 到 ext-core public export；否则保留 package-local。
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

状态：`[~]`

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

状态：`[ ]`

---

## SUB-08：实现安全 RPC → TUI attach

**目标**：在不中断当前tool call、不丢输入且不产生第二个writer的前提下，把同一child session交给native Pi TUI。

**范围**

- 增加human attach action/shortcut和manager internal operation；暂不新增model-facing attach tool。
- 在ParentChannel/child branch实现versioned pause request、paused ack、closing/cancel和input gate。
- attach开始即冻结新输入；保留已接受未消费输入并在结果/status中报告。
- idle child关gate后直接ack；active child等待当前tool call完成，在安全turn boundary暂停，不把`turn_end`本身当pause。
- ack后禁止parent steer/follow-up，关闭RPC writer并确认process/stdio writer退出。
- 旧writer确认退出后调用SUB-07 HostAdapter，用同session/effective config启动native TUI。
- pause timeout/cancel发生在旧RPC退出前：释放gate、解除冻结、保留RPC并返回错误。
- 旧RPC已退出、TUI确认未启动/已退出：恢复RPC等待输入，attach仍报错并包含恢复结果。
- 新TUI/旧writer状态不明：不启动其他writer，保留observability并在deadline内报错。
- stop/shutdown先设置closing/abort并释放gate，再由transition chain完成终止。

**验收**

- running child attach时，正在执行的tool不被强切；paused ack前不会启动TUI。
- idle child不等待不存在的下一次turn_end。
- ack后到TUI ready期间同session始终至多一个受管理writer。
- pause timeout/cancel保留旧RPC；已退出后pane创建失败恢复RPC但不静默重放输入。
- host timeout但TUI实际启动时不重复启动writer、不虚报rollback。
- attach等待期间stop/cancel不死锁，transition queue最终释放。
- session尚未首次落盘时明确拒绝attach并保留RPC。

**验证**：pause gate/idle/running tests；input freeze/uncertain delivery tests；attach-stop race tests；host failure matrix；真实RPC→native TUI smoke并核对conversation continuity。

**依赖**：SUB-06、SUB-07。

状态：`[ ]`

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

**验证**：process/pane exit matrix；session switch/fork/resume/reload behavioral tests；bridge credential revocation tests；interrupt origin tests；真实TUI→RPC detach smoke。

**依赖**：SUB-08。

状态：`[ ]`

---

## SUB-10：完成最小UX、文档与端到端release gate

**目标**：让已完成的生命周期可由用户操作和诊断，并把public contract、文档与发布验证收口。

**范围**

- 使用Pi `ctx.ui.select`提供agent/child选择；用`setStatus`展示紧凑active/running/idle/interrupted/failed状态。
- 接入attach与stop快捷键；快捷键调用现有manager operation，不复制transition逻辑。
- 使用ext-core ToolTui展示spawn/send/get/list/stop完整结果；collapsed view保留artifact/output引用。
- 仅在默认primitive无法满足时增加最小widget，并复用ext-core ANSI/cell-width/lifecycle primitives。
- 更新package README、`docs/architecture/`高层设计和必要ADR；标明与ext-core in-process subagent execution contract的边界。
- 将`PLAN.md`标记为设计来源，将`spec.md`标记为当前实现合同，tickets记录最终证据。
- 删除施工中产生的obsolete API、duplicate launch path、debug flags和compat shim。

**验收**

- 用户可在interactive Pi中选择child、attach和stop；headless/RPC仍可通过tools完成所有model-facing操作。
- 窄/宽terminal下状态和tool output不截断关键identity/error，ANSI宽度安全。
- reload后没有parent listener、widget、connector或timer泄漏；活runner仍可重连。
- Scenario A-I与spec失败矩阵全部有自动化或真实smoke证据。
- repository中只有一个agent resolution path、一个launch builder和一个manager transition owner。
- README/architecture/ADR不宣称自动续跑、阻止原生`/resume`或使用ext-core `startSubagent`提供durability。

**验证**

1. 运行package Biome、focused Vitest和package typecheck。
2. 运行根目录`pnpm run check:fix`、`pnpm run typecheck`、`pnpm test`。
3. 在真实Pi中完成：parallel spawn → send → child report → attach → TUI交互 → detach → parent reload reconnect → stop。
4. 分别验证一个可用host和host启动失败路径；记录未能在本机验证的外部host边界。
5. 检查预期package version/dependency范围与publish dry-run，但未经明确批准不tag/push/publish。

**依赖**：SUB-09。

状态：`[ ]`

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

### M2：持久runtime恢复（SUB-06）

parent reload/restart可重连存活runner；确认死亡后可安全replacement，不自动续跑中断任务。

### M3：原生TUI handoff（SUB-07～SUB-09）

同一child可在RPC与native TUI之间安全切换，包含失败rollback、session switch和interruption语义。

### M4：可发布V1（SUB-10）

用户操作面、文档、全量验证和release dry-run完成；外部发布仍需用户对具体版本/动作明确批准。
