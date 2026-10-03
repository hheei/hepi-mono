# pi-subagents：panel 默认呈现与 child bridge 控制面（设计稿）

状态：**设计稿已确认（2026-10-01）；Stage 1–5 已落地（文档已收口，真实机器 smoke 待常规化）**。

已落地：
- Stage 1 bridge 控制面：`src/bridge-server.ts`（parent 侧 server）、`src/bridge-client.ts`（child 侧 client）、
  `src/child-control.ts`（child 侧请求分发/事件转发/输入上报，连接在 `session_start` 由 `start()` 打开，
  所以"连上"就等于"会话已就绪"）、`src/protocol.ts` 收窄（`BRIDGE_OPERATIONS`、`child_input`、`BridgeError`）
  及各文件配套测试。
- Stage 2 传输切换：`src/child-process.ts`（parent 直接 spawn 的 headless child）、`src/runtime.ts` 重写
  （唯一 socket 路径、per-runtime token 存储、`launchChild`）、`src/manager.ts` 重写（bridge transport +
  `handleChildRequest`/`handleEvent`/`handleConnectionChange` + adopt-on-reconnect + 60s idle 回收）。
  删除：`runner.ts`、`runner-entry.ts`、`rpc-adapter.ts`、`pause-gate.ts`、`connector.ts`，
  attach/detach/`restoreRpc`/host watch/`#frozen`/`writer_exit`/`get_session_stats`，
  registry 的 claim API 与 `runtime.pid`，commands 的 attach verb 与 `ctrl+shift+a`。

**真实机器验证**：`dist` 构建后用真实 Pi 验证了 parent 启动路径（无 `extension_error`、`parent-<id>.sock`
已创建、`/subagents` 只注册 `list | inspect | send | stop`），并用真实 Pi 跑通 headless child 全链路（parent bridge server ↔ 真实 child
进程：拨号、token 授权、`get_state` 返回 `{idle, pendingMessages, sessionId, sessionPath}`、`get_entries`
返回会话条目、SIGTERM 后进程退出），确认 child 会话落在 `<项目 session 目录>/agents/`。同一个 smoke 也确认
了 rpc mode 的 `ctx.shutdown()` 不会结束 idle child（flag 只在命令或 `agent_settled` 后检查），SIGTERM 才是
优雅退出路径并以 143 退出，见 spec.md §7.5。

- Stage 3 panel 默认呈现：`src/host-adapter.ts` 的 `attach` → `open`，herdr `tab create` 增加
  `--label <subagentId>`，`observe()` 增加 `focused`（herdr：`tab list` + `workspace list` 两层都
  focused；cmux 未知，`reportsFocus: false` + `TODO(cmux-focus)`），`HostAttachment` 暴露
  `reportsFocus`；`src/runtime.ts` 增加 `planChildRuntime`/`openChildPanel`（panel child 由 host 运行
  LaunchSpec，token 在 spec env 里），`SubagentManager` 通过 `presentation` 依赖在 spawn 时解析呈现
  （`auto` 有 host 用 panel、否则后台，fallback 原因写进 spawn 结果；`task` 也使用 `auto`，但仍保持一次性结果合同）。
- Stage 4 panel 生命周期：stop 关闭 panel 并再次 `observe()` 确认其不存在（关闭命令成功不算证据），
  adopt 来的无 attachment child 只等待 bridge 断开并有界超时后可见失败；idle 回收到期先看聚焦
  （聚焦或不可判定则重新计时，`reportsFocus: false` 与无 attachment 的 child 根本不倒计时）；人工输入
  （`child_input` source=interactive）取消倒计时；child runtime 消失时释放并遗忘 panel（有界、失败记日志），
  session 与身份保留，后续 send 开新 panel。
- 改名：`mode: "rpc" | "tui"` → `presentation: "panel" | "background"`（registry、`PublicSubagent`、
  `persistSubagentIntent`、launch spec、commands/widget 显示），不做兼容读取：旧记录解析失败并给出
  「删除该记录」的指引。

**真实机器验证（Stage 3–4）**：用真实 herdr 与真实 Pi TUI 跑通 panel 全链路 —— `herdr tab create`
（带 `--label`）+ `pane run` 在真实新 tab 里启动 child TUI，child bridge 拨入并授权成功，
`get_state` 返回 `{idle:true, pendingMessages:false, sessionId, sessionPath}`、`get_entries` 返回 3 条，
`observe()` 返回 `{alive:true, known:true, focused:false}`（`--no-focus` 的新 tab，符合预期），
`shutdown` 请求经 bridge 让 TUI child 退出，`tab close` 后 `observe()` 返回 `alive:false`，无残留 tab。

**第二轮 open-code-review（Stage 3–4 自检）**：共 18 条，已按「先修正确性」处理：host 查询失败/字段缺失一律算
unknown（`pane_not_found` 这类明确答复才算「进程已不在」，且 herdr 的错误 JSON 在 stderr）；hello 除 token 外还要
核对 registry 记录；异步鉴权期间的 `close()` 会结束尚未握手的 socket；report 沿用同一 request id，parent 重放首次结果
（同一连接内重复仍在途则报错），并增加响应超时与「序列化失败不算传输失败」；child 离开 session 后永久关闭自己的
bridge、parent 同时断开该连接；未确认退出的 runtime 会保留句柄并阻止 send 拉起第二个 runtime；panel 关闭/进程结束
只在确认后进行；token 文件改为原子替换；child 侧在没有活跃 session 时拒绝注入输入。逐条理由与保留项见下方「已知限制」。

**第三轮 open-code-review（收口后全仓自检，2026-10-02）**：修掉 child 侧 `task_result` 以上报时重组 payload 而丢掉
parentSessionId/runtimeIdentity（Task 结果因此被 parent 忽略却回了 `accepted:true`）；bridge 去重缓存改为按
**child + runtimeIdentity + request id** 记录（新 runtime 的 request id 从 1 重新计数，只按 child 加 id 会把它的第一份报告
答成上一个 runtime 的结果），child 的 request id 带本进程实例前缀，并且**同时在途的重复请求共享同一个结果**（把重发判成
重复会丢掉一份 parent 已经执行过的报告）；parent 重启后从未重连的 **panel** runtime 记为「未确认」并拒绝 send（后台 child 的
runtime 证据则清掉并记 interrupted，它随 parent 结束）；runtime token 改为按 parent session 分文件
（`tokens-<parentSessionId>.json`，两个 parent 共用一份文件会互相抹掉凭据）；host `open` 抛错按「创建结果未知」处理
（保留 token 与 runtime 证据，仍然不许第二个 runtime）；child 侧 `reload` 也销毁自己的 bridge client；adopt 用
`get_state` 同步 projector（否则随后任何不带状态的 Pi 事件会把记录改回 `running`）；在飞行中的 idle 回收会被期间的
child 信号作废并重新计时；`contact_parent`/`task_result` 透传 tool 的 `AbortSignal`（取消后不再等 parent）；
无法编码的 advisory frame 只丢弃并诊断，不再断开控制通道。

尚未落地：真实机器端到端 smoke 的常规化（Stage 2 与 Stage 3–4 已各手动跑过一次）。

**生命周期收口（2026-10-02，用户确认）**：人工关闭 panel 或 `stop_agent` 后，send 明确失败，不再要求完整复活；只有系统确认成功的 idle 自动回收仍可由 send 恢复同一 session。宿主只能确认 panel 中的 child 进程已退出，无法区分人工关闭与崩溃，因此非自动回收的已确认 panel 退出统一落 `stopped`。session 保留，send 返回不可直接重试的错误并提示新建 child。runtime 状态未知时保留证据并明确拒绝，不增加 panel 身份持久化、label 反查或恢复探测。自动回收落 `done` 后的迟到断线不得改成 `stopped`。

本次聚焦 OCR 实际审查 `manager.ts`（测试被 CLI 默认规则排除），发现并修正两处：idle 观察先发现外部退出时必须走终止路径，不能误记成成功自动回收；已停止且退出未确认的 runtime 重连时不能覆盖 stopped 状态。人工关闭、同次 send 检测关闭与这两处边界均有回归测试和有效的撤销验证。

取代关系：本文取代 [`PLAN.md`](PLAN.md) 的 §5「RPC 为默认模式」、§16–§21 的 attach/detach 生命周期、
§42–§44 的 writer 交接职责，以及 [`spec.md`](spec.md) §7.3/§7.4。`PLAN.md` 保留为历史设计，不再作为当前行为的来源；
实现落地时同步更新 `spec.md`、`tickets.md`、`README.md`、`docs/architecture/pi-subagents.md`，必要时更新 `DESIGN.md`。
与 `PLAN-delivery-presentation.md` 冲突处：该文档「不 fire-and-forget 启动、不 send-keys」等禁令不变，
但其「agent 默认在 RPC 后台运行、attach 时才进 TUI」的前提由本文取代。

---

## 1. 用户可见目标

1. `spawn_agent` 默认把 child 开成**一块新的 host panel**：herdr 用当前 workspace 的新 tab（`--no-focus`，label = subagent id）；
   cmux 用新 surface；两者都不可用时直接在后台运行（无终端）。
2. child 是真正的 native Pi TUI，人可以直接在里面操作；parent 仍可用 `send_agent` / `get_agent` / `list_agents` / `stop_agent` 控制它。
3. **不再有 attach/detach**：不再有「RPC → TUI 交接」，因此没有输入冻结、没有 pause handshake、没有 `close_writer`/`start_rpc`。
4. `stop_agent` 立即关闭 child 的 panel（并结束 child 进程）。
5. **idle 回收只针对空闲 child**：一个 child 的 turn 结束且没有待处理输入后（state=idle），
   若它的 panel **未被聚焦**，启动 60 秒倒计时；人手动输入会取消倒计时；到期关闭 panel（child 进程随之结束）。
   **运行中的 child 永远不会被自动关闭**——只有 `stop_agent` 会结束正在工作的 child。
6. panel 被关闭（人工 `/quit`、关 pane、崩溃、idle 回收、stop）都不改变 child 身份：
   同一个 Pi session 仍在 registry 里，之后的 `send_agent` 用同一 session 拉起新 runtime（**send 必须自动恢复**），
   但不自动重放被中断的 turn（沿用 `PLAN.md` §27「reopen ≠ continue」）。
7. 没有 attach；child 相关快捷键（`ctrl+shift+a` 等）一并移除，人类操作只用 `/subagents` 与 child 自己的 panel。

---

## 2. 架构与数据流

### 2.1 目标结构

```text
父 Pi 进程（本 extension 的 parent 分支）
  ├── BridgeServer        <runtimeDir>/parent-<parentSessionId>.sock（0700 目录，0600 socket）
  │      ├── child bridge 连接（每个 child 一条，重连式）
  │      └── （无 runner、无 controller 角色）
  ├── SubagentManager ── Registry(~/.pi/agent/pi-subagents/registry/<parentSessionId>.json)
  ├── HostAdapter（herdr tab / cmux surface）：开 panel、观察 panel、关 panel
  └── 后台 child：父进程直接 spawn 的子进程（无 panel）

child Pi 进程（panel 里的 native TUI，或无终端后台进程）
  └── child bridge（extension 的 child 分支）：连接父的 socket，执行父请求、上报事件与报告
```

关键点：

- **控制面只有一条**：parent → child 的请求和 child → parent 的报告都走同一条 bridge 连接。
  RPC stdio 不再是控制通道。
- **bridge 连接是 child liveness 的依据**：连接在 ⇒ child 进程在；连接断 ⇒ 结合 host 观察判断 panel 是否还在，
  两者都无法确认时 fail closed（不另开第二个 runtime）。
- manager **不理解** herdr tab id / cmux pane/surface 语义，只看 HostAdapter 的 `attachmentId` 与观察结果（沿用 `PLAN.md` §30）。

### 2.2 控制面消息（bridge 协议）

沿用现有 `protocol.ts` 的 JSON-line + request/response + event 形状，删除 handoff 相关操作：

```text
请求（parent → child）
  prompt / steer / follow_up      → pi.sendUserMessage({deliverAs})
  get_state                       → {idle, pendingMessages, sessionId, sessionPath}
                                     （child 侧由 ctx.isIdle() / hasPendingMessages() 推导）
  get_entries                     → ctx.sessionManager.getEntries()
  abort                           → ctx.abort()
  shutdown                        → ctx.shutdown()（优雅退出；失败则由 host 关 panel / 杀进程）

事件（child → parent）
  Pi 事件：agent_start | agent_end | turn_start | turn_end | tool_execution_* | agent_settled
           （复用现有 FORWARDED_PI_EVENT_TYPES 过滤，交给 state.ts 现有 projector）
  child_lifecycle：left_session | user_interrupt | tui_quit（语义不变）
  child_input：{source: "interactive" | "extension" | "rpc"}（只带来源，不带文本）
  report：contact_parent（pi_subagent_report）
  task_result
```

删除的操作/事件：`close_writer`、`start_rpc`、`pause`、`cancel_pause`、`report_paused`、`writer_exit`、`runner_exit`、
`runner_events_dropped`、`get_session_stats`（parent 用 entries + 现有 `aggregateUsage` 计算）。

---

## 3. 所有权

| 所有者 | 负责 | 不负责 |
| --- | --- | --- |
| parent extension（BridgeServer + SubagentManager） | 唯一 socket、registry、单 runtime 规则、panel 生命周期（开/关/idle 回收）、host 选择 | 不解析终端画面、不镜像 transcript |
| child bridge | 执行父请求、转发 Pi 事件、上报 `contact_parent`/生命周期/任务结果；断线重连与有界缓冲 | 不知道 host、不关自己的 panel、不写旁路文件、不扫 session |
| HostAdapter | panel 的 open / observe（含聚焦状态） / cleanup，以及「host 不可用」的事实 | 不解析 agent、不拼第二份 Pi argv |
| registry | child 身份、intent、state/presentation、session 位置、runtime attachment、未确认输入 | 不存 token、不当 liveness 证明 |

**删除的所有权**：独立 runner 进程及其 endpoint/claim/handshake 体系、pause gate、`#frozen`、attach/detach 状态、
`writer_exit` 语义、`controller`/`reporter`/`recovery` 角色划分。

---

## 4. 生命周期状态机

```text
spawn_agent
   │  (1) 写 registry: state=starting, presentation=panel|background, launchConfig 冻结
   ▼
launch runtime ── panel: host tab/surface + pane run LaunchSpec argv
   │              └ background: 父进程 spawn（stdio pipe 持有）
   ▼
bridge 连接就绪 ──→ state=running，投递初始任务
   │
   ├─（turn 结束、无 pending）→ state=idle → 无 focus 且 60s 无输入 ⇒ 关闭 panel ⇒ 进程结束
   ├─（人手动输入）→ 取消倒计时，state=running
   ├─（人 /quit 或 pane 关闭或崩溃）→ runtime 消失（identity 不变）
   └─（stop_agent）→ 先写 intent=stopped ⇒ 再关 panel / 杀进程
runtime 消失后：state 落回 idle（最后一个 turn 未完成时写 interrupted），
               send_agent 用同一 session 拉起新 runtime（不自动重放被中断的 turn）
```

序列化沿用现状：每个 child 一条 `#mutate` 串行链，一次只有一个 transition 在跑（`spec.md` §6.3）。

---

## 5. 公共合同变化

1. registry 的字段由 `mode: "tui" | "rpc"` **改名**为 `presentation: "panel" | "background"`：
   `panel` = host panel 里的 native Pi TUI；`background` = 无终端的后台 Pi。
   **不做兼容读取**：旧版本写入、只有 `mode` 没有 `presentation` 的记录按解析错误处理，
   错误信息给出文件路径与「旧版本记录需删除」的指引，不静默丢弃、不猜测、不迁移。
2. 默认呈现：`spawn_agent` 与 task tool ⇒ panel（有 host 时），无 host 时 ⇒ background。
   `spawn_agent` **不新增** presentation 参数（无 host 时自动降级为后台，并在返回结果中可见）。
3. `send_agent`：对 panel child 走 bridge（child 侧 Pi 决定 steer/follow-up）；runtime 已消失时用同一 session 自动恢复。
4. `HostAdapter` 契约变化：`attach` → `open`；`observe` 增加 `focused?: boolean`；
   `cleanup` 语义不变（只关自己创建的 panel）。`selectHostAdapter` 顺序与「显式不可用不降级」不变。
5. 失败语义沿用 `PLAN.md` §8.2：无法确认 runtime 死活时 fail closed，不启动第二个 runtime，错误可见地返回给 model。
6. idle 回收：`SUBAGENT_IDLE_TIMEOUT_MS` 由 30s 调为 60s；只在 state=idle 且无待处理输入时计时，
   panel child 的倒计时受聚焦影响，background child 不受影响，running 的 child 不参与回收。
7. 快捷键：attach（`ctrl+shift+a`）及相关快捷键全部移除；不新增替代快捷键（需要时再议）。

---

## 6. 进程与恢复语义

| 场景 | 行为 |
| --- | --- |
| panel child，父进程重启 | 父进程在新进程里重新监听**同一** socket 路径；child bridge 断线重连后 adopt 既有 runtime（不新建、不重建 session） |
| panel child，父进程长期不在 | child 继续在 panel 里跑（host 持有进程）；期间的 `contact_parent` 在 child 侧有界缓冲，重连后补投 |
| 后台 child，父进程重启 | 随父进程结束（D1 已定：不保留 supervisor）；registry 记录 interrupted，不自动重放 |
| panel 消失但 bridge 仍连着 | 不重开 panel，也不新建 runtime；标记 attachment 丢失并报错（可见失败） |
| 两个 Pi 进程打开同一 parent session | 第二个进程无法绑定同一 socket 路径 ⇒ fail closed（同一 session 同时只有一个受管理 runtime） |

单 runtime 规则由「socket 绑定 + registry 记录 + 无法确认死活即 fail closed」共同保证，
不再需要 `PLAN.md` §42 的 runner claim 交接体系。

---

## 7. Host 呈现细节

| host | open | observe | cleanup |
| --- | --- | --- | --- |
| herdr | `herdr tab create --cwd <cwd> --no-focus --label <subagentId> --env …` 然后 `herdr pane run <root pane> <LaunchSpec argv>` | `herdr tab list`（`focused`）+ `herdr workspace list`（`focused`）判聚焦；`herdr pane process-info --pane <id>` 判 pane 是否还在 | `herdr tab close <tab_id>` |
| cmux | `cmux --json new-surface --command <launch text>` | `cmux --json list-panels` 判 surface 是否还在；聚焦状态**未知** | `cmux --json close-surface --surface <id>` |

- 聚焦 = 该 tab 的 `focused` 且其 workspace 的 `focused`（tab 的 `focused` 只在 workspace 内有意义）。
  已用真实 herdr 0.9.0 验证这两个字段存在。
- cmux 无文档化的聚焦查询 ⇒ **fail open**：不自动回收，等用户在需要时自行关闭（见决策 D3）；
  适配器内以明确标注的 `TODO(cmux-focus)` 记录这个缺口，不假装有聚焦信息（cmux 不是当前主力 host）。
- 「关闭了 panel」只证明 attachment 消失，不证明进程已死；进程死亡证据以 bridge 断开 + 必要的进程观察（后台 child 用 PID）为准。
- 不做：把 panel 变成隐藏窗口（herdr 无 hidden 原语）、send-keys、readScreen、屏幕抓取。

---

## 8. 分阶段实施

```text
Stage 1  bridge 控制面（协议收窄、请求/事件/child_input、断线重连 + 有界报告缓冲、测试）
Stage 2  BridgeServer + manager 传输从 runner 切到 bridge（保留启动/停止路径；一次性替换，不留双控制面）
Stage 3  panel 默认呈现：HostAdapter.open（herdr tab label / cmux surface）+ 聚焦观察 + spawn_agent 默认 panel
Stage 4  panel 生命周期：stop 关 panel、idle 60s 回收（聚焦暂停 / 输入取消）、runtime 消失后的自动恢复
Stage 5  删除 runner 进程、pause 门、attach/detach、claim/endpoint/token 交接、`#frozen`、陈旧 projector 分支
Stage 6  文档与 ticket 收口（spec.md / tickets.md / README.md / architecture / DESIGN.md 快捷键）
```

每个 stage 都要有可运行的端到端路径，不留临时架构；Stage 5 的删除清单由 Stage 2–4 的实际落地决定，
不为了「小 diff」保留死代码。

---

## 9. 测试与验收

单元 / 包内（vitest）：

- bridge 协议：请求映射（prompt/steer/follow_up/get_state/get_entries/abort/shutdown）、事件过滤、
  `child_input` 只带来源、报告有界缓冲与重连补投。
- manager：传输替换后的 spawn/send/get/list/stop；无法连接时 fail closed；stop 先写 intent 再关 panel；
  idle 倒计时在聚焦/输入时的暂停与取消；runtime 消失后的自动恢复用同一 session。
- host-adapter：herdr `tab create --label` + `pane run` + 聚焦观察 + `tab close`；cmux `new-surface`/`close-surface`、
  聚焦未知时 fail open。
- 删除项：`pause-gate.test.ts`、`rpc-adapter.test.ts`、attach 相关 `manager.test.ts` 用例与 `FakeRunner` 中的 handoff 操作；
  `protocol.test.ts:49` 的 `RUNNER_OPERATIONS` 列表要按新协议收窄，`:114` 的 limit 默认值断言保留；
  `test/helpers/runner-harness.ts`（`spawnFakePi` / `startFakeRunner` / `openRawController` / `helloFrame`）整体重建为 bridge harness；
  `test/fixtures/fake-pi.mjs` 目前整个文件就是 Pi `--mode rpc` 子进程，需改为可被 bridge 驱动的假 child；
  `commands.test.ts` 的 attach 用例与快捷键断言删除。

集成（`packages/pi-subagents/test-integration/`，真实子进程）：

1. 启动 child（fake host adapter）→ bridge 连接 → `send_agent` 触发一次 turn → `agent_settled` 落 idle。
2. 杀掉父进程再启动 → child 仍在 → bridge 重连 → adopt（不新建 runtime，不重开会话）。
3. idle 回收：到点关 panel；随后 `send_agent` 用同一 session 自动恢复。
4. stop：intent 先落盘，panel 被关，child 进程结束，不自动恢复。

真实机器 smoke（人工执行，herdr 已安装）：

- `spawn_agent` 在当前 workspace 开新 tab（`--no-focus`，label = subagent id），child 可被 `send_agent` 驱动；
- 聚焦 panel 时 idle 倒计时暂停；手动输入取消倒计时；
- `stop_agent` 关掉该 tab，不留下别的 tab；
- cmux 路径本机不可验证，需用户在有 cmux 的机器上确认。

---

## 10. 已确认决策（2026-10-01）

- **D1 后台 child 的存活 → A：不保留 supervisor。**
  后台 child 由父进程 spawn 并持有 stdin，父进程结束它即结束；registry 记 interrupted，不自动重放。
  panel child 由 host 持有进程，天然跨父进程存活。因此不保留 claim 交接、endpoint 存活判定、
  `/proc` runner 探测这套恢复体系（本文取代 `PLAN.md` §16/§25 的旧合同）。
- **D2 registry 字段 → 改名为 `presentation: "panel" | "background"`，不做兼容。**
  旧版本写入、只有 `mode` 的记录按解析错误处理，并给出文件路径与删除指引（见 §5.1）；
  已知影响：现有 `~/.pi/agent/pi-subagents/registry/*.json` 里由旧版本写入的记录需要自行删除。
- **D3 cmux 聚焦 → fail open + 代码内明确 `TODO(cmux-focus)`。**
  cmux 不是主力 host，先不自动回收；herdr 用 `tab list`/`workspace list` 的 `focused` 正常判断。
- **D4 idle 回收 → 60 秒。** panel 与 background 都适用，只有 panel 受聚焦影响。
- **D5 关闭/回收之后 → 结束进程。** child identity 与 session 保留，之后 `send_agent` 自动恢复。
  **运行中的 child 不自动关闭**，只有 `stop_agent`（或用户自己关 panel）才会中断正在工作的 child。
- **D6 过渡 → 一次性替换控制面。** task tool 也走 bridge，用户可见合同不变；不保留 RPC writer 双轨。
- **D7 快捷键 → 全部移除。** attach 与相关快捷键都不保留，也不新增「跳到 panel」快捷键；人类操作用 `/subagents`。

---

## 10.5 已知限制（第二轮自检后保留）

- `runtimeDir/tokens.json` 由同一台机器上的所有 parent session 共享：并发写入是「后写覆盖」，不会损坏（原子替换），
  但两个 parent session 互相看不到对方的 token，重启后可能需要对端重新 spawn 才能恢复认证。按 parent 分文件或加
  跨进程锁属于独立改动。
- `get_entries` 无分页：超长 session 的响应可能超过 frame 上限。现在它只会让该次请求失败（父端收到明确错误），
  不会拆掉整条连接；分页留给后续。
- `contact_parent`/`submit_task_result` 不接受 tool 的 AbortSignal：model 侧取消不会中断一次在途报告，
  child 离线时仍会占用有界缓冲直到重连。
- cmux 不能报告聚焦（`TODO(cmux-focus)`），因此 cmux child 只由 `stop_agent` 关闭。
- parent 重启后 adopt 的 panel child 没有本进程的 `HostAttachment`，聚焦观察/自动关闭/回收退化；见 spec.md §7.6。
- `src/markdown.ts` 属于另一条进行中的工作（子代理协议里的 markdown → ANSI 转换），本轮不做改动。

## 11. 明确不做

- 不 fire-and-forget 启动（spawn 仍等到 bridge 就绪并投递初始任务）。
- 不 send-keys、不 readScreen、不扫 session JSONL、不写 activity sidecar。
- 不做隐藏 panel（herdr 无该原语）、不做第二编辑/transcript UI。
- 不引入全局调度器、workflow engine、批量 spawn API、成本自动干预。
- 不把 `hiddenFromWidget`、child 扩展选择器、`subagent_done` 等上游设计带进来。

---

## 附录 A：删除与改写清单（来源：包内清点，行号为清理时参考）

```text
协议 / 传输
  protocol.ts         REMOVE  close_writer, start_rpc, pause, cancel_pause, report_paused,
                              writer_exit, runner_exit, runner_events_dropped, get_session_stats
                      KEEP    prompt, steer, follow_up, abort, get_state, get_entries,
                              contact_parent, report_lifecycle, task_result
                      ADD     child_input 事件
  rpc-adapter.ts      DELETE  整文件（PiRpcAdapter 随 writer 一起退出）
  rpc-events.ts       KEEP    FORWARDED_PI_EVENT_TYPES 过滤表（移到 child 侧使用）
  runner.ts           DELETE  整文件（进程、endpoint、claim 握手、pause 门、close_writer/start_rpc）
  runner-entry.ts     DELETE
  runtime.ts          KEEP    runtimeDirectory / endpoint 与 token 生成与存储
                      DELETE  launchDetachedRunner, recoverDetachedRunner, startClaimedRunner,
                              claim 交接与 /proc runner 存活判定
  connector.ts        KEEP    重连式客户端骨架（bridge 侧使用，需补 timeout 重连）
  pause-gate.ts       DELETE

身份与持久化
  domain.ts           SubagentRecord.mode → presentation: "panel" | "background"（ExecutionMode → Presentation）
  registry.ts         按 presentation 解析与校验；旧记录（只有 mode）解析失败，错误信息给出文件路径与删除指引
  state.ts / widget.ts / commands.ts  展示层读 presentation（状态行显示 panel / background）

manager / 呈现
  manager.ts          DELETE  #frozen, #attachCancels, #hostAttachments, #hostWatches,
                              #tuiQuitExpected, #runAttach, #runDetach, #restoreRpc*,
                              #releaseHost, #watchHost, inspectHost, restoreRpc, presentation 切换
                      ADD     BridgeServer 客户端、panel 开/关、聚焦轮询、idle 回收
  host-adapter.ts     attach → open；observe 增加 focused?: boolean；Herdr 加 --label；
                      cmux 的聚焦观察标 TODO(cmux-focus)（fail open）
  commands.ts         attach verb 与 ctrl+shift+a / 其他 child 快捷键一并删除；
                      /subagents 保留 list | inspect | send | stop
  tools.ts            合同不变（spawn_agent 默认 panel；错误信息更新）

child 侧
  child-bridge.ts     KEEP    contact_parent / report_lifecycle / task_result / nudge / widget / title
                      DELETE  PauseGate、PAUSE_EVENT/CANCEL_PAUSE_EVENT、turn_end hold、report_paused
                      ADD     请求分发（prompt/steer/follow_up/get_state/get_entries/abort/shutdown）、
                              事件转发、child_input、断线重连 + 有界报告缓冲
```

## 附录 B：需要同步的文档位置

| 文件 | 位置 | 处理 |
| --- | --- | --- |
| `spec.md` | §2.1（37 行 child branch 职责）、§3.2（attach/detach 数据流）、§6.1（Runner IPC）、§6.2（state/presentation）、§7.3（attach）、§7.4（detach）、§8（host 与快捷键）、§13（实施顺序） | 重写为 bridge 控制面 + panel 生命周期 |
| `README.md` | 4、14、22、97、100–106、112、117、121、123、126、161、164、166 行 | attach 段落改为 panel，spawn 行改为默认 panel，快捷键说明删除 |
| `tickets.md` | SUB-02（140/148/153）、SUB-07（343–362）、SUB-08（372–420）、SUB-09（426/442/453）、SUB-10（464–473/484） | SUB-08 标注被取代，新增 panel/bridge ticket |
| `docs/architecture/pi-subagents.md` | HostAdapter 行、SUB-08 段落 | 改为 panel 呈现 + bridge 控制面 |
| `DESIGN.md` | 快捷键与 widget 合同 | attach 及相关快捷键移除；如 widget 行文案变化则同步 |
| `PLAN.md` / `PLAN-delivery-presentation.md` | 各自 attach / RPC-默认 段落 | 加一行「由 PLAN-panel-bridge.md 取代」，正文不改（历史文档） |

