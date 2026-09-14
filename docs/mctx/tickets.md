# pi-mctx 迁移 Tickets

本 backlog 实现 [`spec.md`](spec.md)。每个 ticket 应单独提交，除非注明依赖；完成一个 ticket 后更新本文件状态和 spec/architecture 文档。Ticket 不允许顺手搬迁 OMP host、handoff 或无关 feature。

状态：`[ ]` 未开始，`[~]` 进行中，`[x]` 完成，`[-]` 明确不做。

## MCTX-01：收敛 AgentMemory 配置与 project identity

**目标**：让 AgentMemory bridge 拥有独立、可审计的配置，并移除显式 project namespace。

**范围**

- 对照上游 `src/agentmemory/config.ts`、`project.ts`、`security.ts`。
- 将 project identity 固定为 `environment -> git root -> cwd`，但不再暴露 `agentmemory.project` 设置。
- 删除 `agentmemoryProject` 的 active runtime/config schema 路径；保留 `AGENTMEMORY_PROJECT_NAME` 作为显式环境覆盖。
- 保留 `agentId` 作为过滤维度，不作为安全边界。
- 统一 `requireHttps` 与 secret 的 fail-closed 规则。

**验收**

- 空配置不创建 AgentMemory runtime。
- 启用 bridge 时 project identity 可从 git root/cwd 稳定得到。
- bearer secret 发往非 loopback plaintext HTTP 时按配置拒绝或显式告警。
- 配置测试覆盖 setting、env、git root、cwd precedence 和 secret 保护。
- README、architecture、ADR 不再宣称支持显式 project setting。

**验证**：配置 focused tests、AgentMemory settings/security tests、changed paths Biome/typecheck。

**依赖**：无。

状态：`[x]`

## MCTX-02：迁移 AgentMemory client、session lifecycle 与 bridge runtime

**目标**：建立可复用、可取消、不会阻断 Window 的 HTTP bridge。

**范围**

- 将 OMP bridge 逻辑适配到现有 Pi lifecycle，不搬 `src/host`。
- 拆分 client、session binding、bridge runtime；每个 Pi session activation 至多建立一个远端 capture segment。
- 支持 health、start、end、observe、search、remember 所需的 typed client port。
- 所有响应使用 `unknown` narrowing/既有 schema 方式校验。
- timeout、AbortSignal、HTTP/network/invalid-response 错误必须保留错误种类。
- session switch、resume、shutdown、late callback 必须幂等且不污染新 session。

**验收**

- bridge disabled 时不构造 client、不发网络请求。
- 同一 session 重复启动不重复调用非幂等 `session/start`。
- shutdown 会 best-effort end 所有未结束 binding。
- 请求取消不会留下 pending promise 或未清理 binding。
- 外部服务失败不会抛穿到 Window transform。

**验证**：runtime isolation/smoke、client error matrix、session lifecycle focused tests。

**依赖**：MCTX-01。

状态：`[ ]`

## MCTX-03：迁移 capture、redaction、taint 与 Historian provenance

**目标**：把 session/tool/assistant 观察异步送入 AgentMemory，同时防止凭据、memory recall 和 memory tool 输出成为错误的独立证据。

**范围**

- 迁移 capture 事件映射和最大 observation 文本限制。
- memory tools、credential-shaped values、secret values 必须排除或 redact。
- 引入 `agentmemory_turn_taint` 及 host-entry/turn 的关联。
- recall、memory tool output、由 recall 派生的内容不得作为 Historian independent evidence。
- session shutdown 负责结束未完成 capture segment。

**验收**

- 常见 secret/token/password/api-key 形态不会进入 observe payload。
- `memory_search`/`memory_save` 输出不会被重复 capture 成可提升事实。
- capture 请求失败只记录 failure，不改变主 turn 结果。
- taint 传播覆盖 user entry、tool result、assistant restatement 和 historian candidate。
- capture 并发与 shutdown race 有 deterministic tests。

**验证**：redaction、capture failure、taint/provenance focused tests。

**依赖**：MCTX-02。

状态：`[ ]`

## MCTX-04：迁移 unified `memory_search` 与 transactional `memory_save`

**目标**：提供 tool-first 的 durable memory 能力，不改变 provider context projection。

**范围**

- `memory_search` 分离当前 session lane 与 AgentMemory lane；不把不可比 score 数值合并。
- 远端结果经过 project/agent/session Scope Gate 和 active capture exclusion。
- partial transport failure 返回健康 lane 和明确 partial 状态。
- `memory_save` 先写本地 transactional outbox，再异步 remember。
- outbox 支持 lease、retry、dedupe、delivery result 和 bounded drain。
- 删除当前精简 `runtime.ts` 中重复的 direct-save/search API，完成 clean cutover。

**验收**

- search 结果含 source identity、project、session、agent、digest，不只返回 count。
- 不会显示当前 active capture segment。
- `memory_save` 在 outbox commit 前不声称 delivered。
- 进程重启、重复 drain、远端 timeout 不造成重复 durable save。
- bridge down 时 local session lane 仍可工作，状态明确为 partial/degraded。

**验证**：search lane、scope gate、outbox crash/retry/dedupe focused tests。

**依赖**：MCTX-02、MCTX-03。

状态：`[ ]`

## MCTX-05：接入 schema、runtime registration 与统一 status

**目标**：把 bridge 作为 Pi extension 的完整可观测能力接入，而不是孤立模块。

**范围**

- additive 初始化 `agentmemory_outbox`、`agentmemory_turn_taint` 及所需索引。
- 在 `src/index.ts` 接入 session_start、before_agent_start、tool_result、agent_end、session_shutdown lifecycle。
- `/agentmemory-health` 保留为显式 fresh probe。
- `/ctx-status` 增加 bridge gates、observed health、capture/search/inject 状态、outbox pending/leased/failed、最近错误。
- status 读取只读本地状态，不触发网络请求或重复写库。
- 更新 README、architecture、ADR 0020，写清 `mctx_memory` 到 `memory_save` 的 cutover。

**验收**

- 启用/禁用、健康/降级、outbox 状态在 TUI 和 headless status 中语义一致。
- status refresh 无网络副作用。
- schema 在新库和旧库上均可重复初始化。
- Pi extension reload/shutdown 后没有 listener、timer、outbox drainer 泄漏。

**验证**：fresh schema、runtime enable/isolation、status snapshot、reload/shutdown tests。

**依赖**：MCTX-03、MCTX-04。

状态：`[ ]`

## MCTX-06：迁移 Recall Ledger 与 Automatic Recall Admission

**目标**：把远端 recall 变成绑定到具体 user entry 的可审计事件，但暂不改变 Window 的其余 compaction 算法。

**范围**

- additive 创建 projection epoch、branch lineage、recall event/source/dependency、presentation receipt、recovery ref 表。
- 实现 `declarePreUpgradeEpoch`、active branch lookup、generation、stale discard、GC。
- admission 以 user-entry anchor 为身份；同一 anchor+epoch 重试复用 snapshot。
- Scope Gate、already-visible filter、taint mark 和 source metadata 必须在 admission 层完成。
- backend failure 不阻断 Window，也不产生空的伪 recall event。

**验收**

- 相同 user entry 的重复 transform 不重复 remote search。
- 相同文字但不同 user-entry id 会生成独立 event。
- session/branch/epoch/generation 改变时旧异步结果无法提交。
- admitted event 可从 durable ledger replay；不可达 event 可按 retention GC。
- ledger schema 不把 recall 写进 session JSONL。

**验证**：ledger invariants、admission reuse/stale/scope、GC/recovery focused tests。

**依赖**：MCTX-05。

状态：`[ ]`

## MCTX-07：接入 Context Projection 与 Pi context transform

**目标**：让 provider-visible context 具备 stable baseline + append-only tail，并把 recall 正确插入 user turn 后、assistant reply 前。

**范围**

- 迁移 `context-projection.ts` 和 `context-projection-coordinator.ts` 的领域逻辑，改用现有 Pi message/session abstractions。
- 实现 projection body digest、contract digest、unchanged/append/transition 分类。
- transform 成功后原子发布 projection；失败只回放有效 LKG。
- compaction、recomp、branch replacement、model/system/tool contract 改变时建立新 epoch。
- privacy withdrawal 不得回放已撤销 head。
- 保持现有 native compaction fence 和 Pi kept-tail reconciliation，不在 hook 内同步运行 Historian。

**验收**

- 未变化输入产生 byte-equivalent provider context。
- 仅尾部 append 保留原 prefix。
- contract 或前缀改变不会伪装成 append。
- recall 出现在正确 user/assistant 边界且不会重复序列化。
- transform 失败不会发布半成品 projection。
- native compaction 前后 projection/ledger 状态可重建。

**验证**：projection/coordinator、context transform、native compaction interaction、LKG failure tests。

**依赖**：MCTX-06。

状态：`[ ]`

## MCTX-08：TUI recall presentation 与 end-to-end hardening

**目标**：在 interactive Pi 中展示 newly admitted recall，同时保持 headless/RPC 输出不重复注入。

**范围**

- 迁移 recall presentation receipts 和 `aboveEditor` widget。
- 复用现有 ext-core surface/widget/ANSI width primitives；不新增 feature-specific color/token。
- presentation 失败不影响 transform；claimed-but-not-presented 可在 lease 后重试。
- `/ctx-status` Memory section 展示 bounded sanitized recall preview。
- 补齐 package README、architecture、ADR、focused tests 和 live smoke。
- 删除已过时精简 runtime、配置字段、注释、测试和旧 API。

**验收**

- interactive session 每个 event 在 presentation surface 至多显示一次。
- headless/RPC 不出现 recall widget 或重复 recall 文本。
- narrow/wide terminal 均保持 cell-width safe、bounded、可读。
- TUI/widget/setWidget 抛错不会破坏 provider transform。
- package focused suite、typecheck、Biome 和实际 Pi smoke 均通过。

**验证**：presentation receipt/widget tests、narrow/wide render tests、actual Pi smoke、focused package gate。

**依赖**：MCTX-07。

状态：`[ ]`

## 依赖图

```text
MCTX-01
   |
MCTX-02 ----+
   |        |
MCTX-03 ---+---- MCTX-04 ---- MCTX-05 ---- MCTX-06 ---- MCTX-07 ---- MCTX-08
```

## 每个 ticket 的提交规则

- 一个 ticket 一个 cohesive commit；commit message 使用 `feat(pi-mctx): ...` 或 `fix(pi-mctx): ...`。
- 不在 ticket 中运行项目级 formatter/check；只在最后的 MCTX-08 运行完整受影响路径验证。
- 每个 ticket 必须更新对应 focused tests；若只搬迁已有行为，必须说明原测试如何覆盖。
- 每次 schema、配置或用户可见行为变化都要同步更新 README/architecture/ADR，不把实现细节塞进高层 docs。
- 完成 ticket 前检查 `git diff`，不得包含用户无关改动或 OMP-only 文件。
