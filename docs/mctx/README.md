# pi-mctx

## 状态

已创建独立、可安装的 `@hheei/pi-mctx` package。默认 disabled，保持 Pi native behavior；启用且 historian
configuration 有效时，它在 `session_start` 解析 runtime、打开/migrate MCTX SQLite store，并绑定当前 project/session
partition。已启用 pipeline 在 `turn_end` 可触发 historian Completion；已验证 compartment graph 在 `context`
pass 替换其 covered raw history。它直接注册 `ctx_reduce`，但只能在 active MCTX session 中排队 deferred drop；inactive
session 返回明确 tool error。它仍不注册 command、status 或 child inheritance Service。

## 完整迁移目标

`pi-mctx` 的最终目标不是停在首个 context pipeline，而是替代 `@hheei/pi-magic-context@0.33.1-hepi.0`
baseline。完成定义是：所有仍被 HEPI 用户依赖的 MCTX 行为都有独立 owner、明确的持久化/取消/并发 contract、
focused tests 和可安装 package entry。deprecated `@hheei/hepi-mctx` wrapper 不是 compatibility target；它的
Loadout、reminder、subagent accounting bridge 不构成 MCTX migration scope，之后可直接移除。

迁移追求 behavioral parity，不追求旧 package API、tool 名称、settings key、SQLite schema 或 persisted state 的
binary compatibility。需要导入旧数据时，另立带 backup、validation、rollback 规则的数据迁移 feature；不能在
新 runtime 中隐式读取旧 state。

## 完整迁移 TODO

以下 checklist 是当前唯一 migration roadmap。`[x]` 表示实现和 focused verification 已完成；`[ ]` 表示尚未
开始或尚未达到完整 contract。每个未完成项开始前都必须更新本文、完成 focused design discussion、先写测试，再实现。

- [x] 独立 `@hheei/pi-mctx` package、显式 enable/model admission、user-level SQLite context store、project/session
  partition、revision CAS、lease、compartment graph、parent historian、repair/retry、trigger、context transform 与
  same-session branch divergence rebuild。
- [x] **Fork partition projection**：在 Pi fork 的 `session_start` 识别 source partition，验证并复制 child branch
  可见 ancestor compartments 到新的 partition；copy failure fail open，child 后续 rebuild，绝不共享 parent state。source
  session 从 child header 的 `parentSession` 经 Pi `SessionManager.open()` 读取 ID/cwd，再解析 source project identity；
  显式 Pi fork 可以跨 project copy，因为 child 已持有同一 raw branch。仅连续、通过 child branch range/fingerprint
  proof 的 records 可复制；missing source、source revision stale、invalid graph、destination 已存在或 SQLite error 都必须保留
  empty/existing child partition，不能阻止 session start 或读取 parent SQLite state。
- [x] **Pipeline diagnostics**：为 cooldown-eligible historian failure 提供 model-invisible native notification
  和 structured log。
- [ ] **Host verification**：在真实 Pi host 或 `tui-replay` 验证 activation、transform、fork、reload 与 failure 的
  可见行为。
- [ ] **Parent-to-child compressed-context Service**：`pi-mctx` 用 ext-core Service 发布 opaque、validated parent
  history projection；`pi-subagents` 消费它组装 child prompt。缺席/过期 fallback 为 Pi native inheritance，consumer
  不读取 MCTX SQLite。当前被缺失的独立 `pi-subagents` consumer 阻塞；在 consumer 的 installable runtime、prompt
  assembly 与 fallback test 存在前，不发布无可见行为的 provider-only Service。
- [ ] **Handoff/compaction integration**：定义 parent handoff 如何使用 compartment graph、protected tail、pending
  reductions 与 failure fallback；它必须和 Pi native compact 共存，不能把 MCTX summary 当 Pi session canonical source。
  当前被缺失的 `hepi-basics` `/handoff` command owner 阻塞；不得由 `pi-mctx` 越界注册 command。恢复并验证 Pi-native
  owner 后再设计 MCTX bridge。
- [x] **Session-history tag ledger 与 transform**：建立 `N -> immutable Pi identity` 的 session-local ledger、immutable
  source retention、protected tail、pending/deferred drop、branch/reload/fork proof 和 marker projection；不能用 raw message
  dump 或即时删除替代。
- [x] **`ctx_reduce`**：`pi-mctx` 直接注册此 tool，写入 tag-ledger pending operation；只接受 current active branch 的非保护
  tag，下一 context transform 才投影 marker。disabled runtime 或不合法 selector 返回明确 tool error，不修改 Pi JSONL。
- [x] **`ctx_expand`**：从 current partition retained source 读取一个或多个 `N`/`N-M` tag 的受界限内容；它接受 all
  status tag、对 valid selector partial output，并明确列出 rejected selector。`offset`/`limit` 作用于 tag-order
  rendered result，default/max 均为 30,000 characters。它不读取别的 session/fork partition，不修改 tag status，也不把
  source 自动重新注入 model context。
- [ ] **Durable memory**：迁移 `ctx_memory` 的 project/workspace scope、category、archive/delete/restore、privacy、
  source provenance 与 cross-session visibility。它是 user-level durable state，不复用旧 SQLite schema，也不让 project
  config 或 child session 取得写权限。
- [ ] **Durable notes**：迁移 `ctx_note` 的 session anchor、read/dismiss/update、smart-condition ownership、surface
  trigger 与 stale cleanup。Dreamer-dependent smart note evaluation 必须等 Dreamer feature，不把 cron/polling 偷渡进 tool。
- [ ] **Composite search**：最后迁移 `ctx_search`；它跨 memory、note、session history、git commit 与 primer，必须在
  各 source 有验证过的 index/privacy/retention contract 后才暴露。没有某 source 时返回明确 partial scope，不伪造
  complete search。
- [ ] **Todo ownership decision**：legacy `todowrite`/`/todos` 是 session task UI，不迁入 `pi-mctx` 或重复注册。确认
  当前 Todo owner 的 behavioral coverage 与 legacy migration boundary；Pi 的 first-registered tool rule 禁止以新 MCTX
  tool 覆盖旧 aggregate。
- [ ] **Pipeline maintenance commands**：为 legacy `/ctx-flush`、`/ctx-recomp`、`/ctx-session-upgrade`、`/ctx-status`
  与 `/ctx-wrapup` 分别定义 user need、owner 和 Pi lifecycle integration。没有明确用户 workflow 的 internal maintenance
  action 保持不暴露。
- [ ] **Sidekick augmentation**：legacy `/ctx-aug` 是独立 project-memory prompt augmentation，需单独定义 model/tool/
  privacy/cancellation contract；它不是 historian retry 或 context transform 的快捷入口。
- [ ] **Dreamer 与 embedding commands**：legacy `/ctx-dream`、`/ctx-embed` 归入 historian-adjacent services；先完成
  Dreamer/embedding storage、leases、cost/cancellation 与 retention，再决定是否保留 command。
- [ ] **Historian-adjacent services**：按已验证需求设计 Dreamer、embedding provider、background maintenance、search
  index 与 retention/data-management。自动 TTL prune、shutdown deletion 或语义删除在得到明确 retention contract 前保持禁止。
- [ ] **Reserved configuration activation**：逐字段启用当前 opaque 的 upstream-shaped configuration，定义 user/project
  scope、runtime validation、default、reload semantics 和 invalid-value fallback；不得因保存过某字段而隐式开启 feature。
- [ ] **Installer migration 与旧 wrapper retirement**：发布独立 package entry、迁移安装文档和 Loadout ownership、验证
  clean tarball/install entrypoint；然后移除 deprecated `@hheei/hepi-mctx` 与 aggregate bundle 中的重复注册。wrapper
  bridge 不迁移，不能阻止 removal。

完成 migration 前，不得宣称 `pi-mctx` 已替代 Magic Context。每个 checkbox 需要独立 commit；跨 package contract
change 还必须更新 `docs/architecture/` 和相关 ADR。

Legacy `@hheei/pi-magic-context@0.33.1-hepi.0` 的首次 public-surface inventory 见
[研究记录](../research/pi-magic-context-0.33.1-inventory.md)。它是已发布 bundle 的证据索引，不是旧 API compatibility
承诺；后续 feature 只能以其确认的用户行为为输入，不能从内部 SQLite table 或 bundle private helper 推导新 contract。

### Historian diagnostics

Historian terminal `failed`/`invalid` 会产生无 source/context payload 的 structured event：partition identity、failure
class、completion attempt 和 lease terminal outcome。默认 sink 使用 `console.warn` 写 JSON，安装者可将 stderr 接入其
日志系统；测试可注入 sink。Pi native warning 只显示 failure class 和保留旧 context 的事实，不显示 provider error
message。相同 class 在一次 session 内只通知一次，直到下一次 successful publication rearm；每次 terminal failure
仍写 structured event。lease-held、lease-loss、caller cancellation、stale CAS 和 raw branch rebuild 属于预期并发/取消
结果，不触发用户 warning。unexpected runner throw 记录为 `unknown`、attempt `0`，同样不输出异常文本。真实 Pi host
或 `tui-replay` 的可见行为验证尚未完成。

### Session-history tag ledger

`ctx_reduce` 与后续 `ctx_expand` 共用一个 session-local ledger。用户和模型引用短 selector，例如 `` 或 `8`；
SQLite 永久绑定到 immutable Pi identity，不能以 tag number、文本值或 entry position 定位 source。tag number 仅在一个
MCTX partition 内递增，不能跨 session、fork 或 project 使用。

每个可投影 payload 获得一个 tag：message text、tool call/result aggregate、以及 file/reference descriptor。text 和
可展示 tool output 在 model-visible content 中使用严格 legacy 前缀 `§N§ `；file/reference 的 retained source 只保存
可序列化 descriptor（例如 URL、media type 与 name），绝不复制 binary attachment。tool aggregate 的 immutable binding
包含 owner assistant entry ID 与 tool-call ID，避免不同 assistant turn 的相同 call ID 发生碰撞。

ledger 为每项保留 immutable source copy，供 future `ctx_expand` 在 reload、Pi compaction 或 source branch 不再暴露原 entry
后恢复。source copy 不自动注入、不能跨 partition 读取，且在独立 retention/data-management contract 出现前不会自动过期或
删除。

`ctx_reduce` 只把 validated selector 写为 pending operation。下一次 MCTX `context` transform 在当前 Pi active branch
重新验证 entry/tool identity、tag status 与 protected tail 后才将目标内容替换为严格 marker `[dropped §N§]`；raw Pi JSONL
永远不被改写。默认 `protected_tags` 为 20，user-level setting 只接受 1–100，project settings 无权改变它，reload 后生效。
受保护、已 dropped、未知、别的 branch/fork 或无法证明 identity 的 tag 必须拒绝或保持 pending，绝不按 position 猜测删除。

首 slice 不迁移 legacy 的 tool-specific skeleton/truncate heuristics、automatic/smart drops 或 reasoning compression。它们
需要各自可测的 reclaim policy，不能混入用户明确请求的 manual deferred drop。

### `ctx_expand`

`ctx_expand` 只接受同一 selector grammar 的 `N`/`N-M` range。它读取 current active MCTX partition ledger 中 immutable
source copy，允许 `active`、`pending` 和 `dropped` status；source 除显式 tool result 外绝不重新进入 model context。unknown、
other-partition 或 malformed selector 绝不按 entry position 猜测：malformed selector 返回 tool error，valid selector 仍按
tag-number order 返回，ineligible selector 单独报告。

tool 的可选 `offset` 与 `limit` 作用于完整 rendered result，而不是逐 tag pagination。`limit` 的 default 和 maximum 都是
30,000 characters。truncated result 报告 next offset；它既不改 status，也不将 source 恢复到 active context。`ctx_expand`
绝不读取另一 session/fork partition，也不让 retained source 提供给 background work、cross-extension Service 或 automatic prompt
injection。

## 目的

`@hheei/pi-mctx` 将成为 HEPI 对父 Pi 会话进行上下文管理的唯一 owner。未来它可以维护摘要、
compartment 和父会话长期上下文，并为子代理提供经过父会话压缩的继承内容。

它不是现有 `@hheei/hepi-mctx` 的 adapter 或重命名。后者是对外部
`@hheei/pi-magic-context` 的 transitional wrapper；两个 package 在迁移期间独立安装和演进。

`pi-mctx` 的目标是 behavioral parity：保留已确认的用户可见上下文管理结果，但不兼容旧 package API、
tool/command 名称、配置键、存储格式或已持久化 state。

## 边界

### pi-mctx

- 未来拥有父会话的 MCTX state、压缩决策、compartment、持久化和取消。
- 未来在 `inherit_context` 请求中提供父会话已压缩的历史内容。
- 不拥有 child agent、model、tool、worktree 或 delivery policy。

### pi-subagents

- 拥有 child session 的创建、agent/model/tool/worktree policy 和 prompt 组装。
- child 默认使用 Pi 原生自动 compaction。
- child 不运行 MCTX historian、memory、note、持久化、状态或 MCTX tools。
- 未来只在 parent `pi-mctx` 可用时消费其继承内容；未安装或 provider 明确过期时，保留
  Pi 原生 branch inheritance。

### pi-ext-core

- 只提供 runtime-scoped lifecycle、cleanup 和 first-provider-wins `Service` 协调。
- 不认识 MCTX state、摘要格式、Pi branch shape 或 child prompt。
- 不为当前单一 consumer 预建 MCTX 专属 contract、opaque boundary 或 projection helper。

跨 package 的 future inheritance provider 使用 `@hheei/pi-ext-core` 既有 Service 发现机制。
provider 和 consumer 分别声明相同的 namespaced service ID，不互相 import。provider 负责从
当前 parent branch 取得自身所需的压缩前缀与 tail；`pi-subagents` 只把结果放入自己的 child prompt。

### 预留的跨扩展 projection API

`/handoff` 是 `hepi-basics` 的未来独立 command，不属于 `pi-mctx`。为避免每个 consumer 读取 MCTX SQLite 或
解析 compartment XML，`pi-mctx` 将来只发布一个窄的 runtime-scoped projection capability。它服务两个已定义的
consumer：`hepi-basics` 的 handoff 与独立 `pi-subagents` 的 inheritance；memory、notes、search 或任意第三方
extension 不得借此取得 MCTX state，未来各自需要独立 capability。

实际 implementation 出现两个 installable consumer 前，不创建 Service key 或 provider-only runtime。届时两个
package 通过 `pi-ext-core` 的 Service 使用同一预留 ID `@hheei/pi-mctx/context-projection@1`；MCTX runtime 是唯一
provider，first-provider-wins，生命周期 cleanup 自动撤销。以下是 contract 的设计基线，不是当前可 import API：

```ts
import type { SessionManager } from "@earendil-works/pi-coding-agent";

interface MctxContextProjectionService {
	prepare(input: {
		readonly purpose: "handoff" | "inheritance";
		readonly signal: AbortSignal;
	}): Promise<MctxContextProjection | undefined>;
}

type MctxContextProjection =
	| {
			readonly purpose: "inheritance";
			/** Opaque content; consumer appends it verbatim in its own child prompt boundary. */
			readonly payload: string;
	  }
	| {
			readonly purpose: "handoff";
			/** Installs the opaque hidden entry and atomically binds destination state. */
			install(
				destination: Pick<SessionManager, "getSessionId" | "appendCustomMessageEntry">,
				signal: AbortSignal,
			): Promise<void>;
	  };
```

`prepare()` snapshots only committed, graph-validated compartments plus the MCTX-owned protected tail. It never exposes
SQLite rows, source branch entries, revision internals or an editable summary. `handoff.install()` is idempotent for the
same destination session; it owns hidden-entry ordering and the destination marker that prevents fork projection from
duplicating the already materialized parent graph. It must not leave a durable destination marker when installation fails
or its signal aborts. Each operation is tied to the caller signal and parent lifecycle; concurrent handoff preparation for
one parent partition is rejected rather than publishing competing destination mappings.

No provider, disabled MCTX, no eligible committed projection, or an explicitly stale artifact resolve to `undefined` and
make the consumer use its Pi-native fallback. Once an enabled provider returns a plan, malformed payload, store failure,
or installation rejection is an operation error: consumer must surface it and must not silently switch to native fallback,
because doing so can lose an already chosen MCTX projection. Consumers never await `waitForService()` inside `session_start`;
they own cancellable continuation and fallback policy.

## Package 约定

`packages/pi-mctx` 的首版只包含一个 Pi extension entry。它直接依赖
`@hheei/pi-ext-core`，并以 Pi packages 为 peer dependency。core 提供 Pi settings JSON 的 locked file transport；
SQLite 使用 Node 内建 `node:sqlite`，不引入 SQLite npm dependency。它不得依赖：

- `@hheei/hepi-mctx`；
- `@hheei/pi-magic-context`；
- 任何 concrete HEPI extension。

没有 session resource 时，extension entry 不注册空 lifecycle。真正创建 resource 的功能必须通过
`registerExtensionLifecycle()` 取得 session-scoped owner，并将取消和 cleanup 注册到该 owner。

## 首个行为里程碑

package skeleton 后，首个实现是 parent session 的 context pipeline：将符合条件的 history 组织为
compartment，并向后续 parent turn 注入确定性渲染结果。它不实现 memory、note、search、Dreamer、embedding、
command、status 或 UI。

context pipeline 的 canonical state 是 MCTX-owned SQLite context store。它保存 parent session 的
compartment graph；Pi session branch 保留 source transcript 与 host compaction entry，但不是 MCTX 摘要的
canonical source。选择 SQLite 而非只依赖 Pi compaction entry 的理由见
[ADR 0005](../adr/0005-pi-mctx-owned-context-store.md)。

context store 是 user-level shared DB，按 stable project identity 与 Pi session identity 分区。多个
worktree 或 Pi process 可以安全打开同一个 DB；一个 partition 的 compartment 只能由其原 parent session
读取，不能作为跨 session shared state 复用。Pi fork 只复制有效 ancestor state 到新的 child partition。

project identity 优先使用 `git:<root-commit>`，使同一 repository 的 worktree/clone 对齐；non-git project 使用
`dir:<SHA-256(realpath)>`。transient Git failure 只能复用当前 process 的 last-known Git identity，否则使用
directory fallback；permission-denied 不可靠地界定 project boundary，拒绝 activation 并呈现 diagnostic。identity
不得来自 remote URL 或 development-machine absolute path。

context store 位于 `<getAgentDir>/mctx/context.db`。它与 global settings file 分开，不能放入 project/worktree，
也不能依赖开发机绝对路径。

store 使用 SQLite WAL、短事务和 busy timeout。每个 partition 维护 monotonic revision；写入必须比较预期
revision，冲突时重读并重算，不能以 last-writer-wins 覆盖较新的 compartment。

store 提供 revision CAS primitive：调用者提交当前 partition snapshot，成功时得到 revision 加一的新 snapshot；若
conditional update 未命中则得到 `undefined`，必须重新读取/recompute。CAS 不写 compartment 内容，后续 publication
会在同一 transaction 内组合 payload write 与该 revision fence。

schema v3 增加每个 partition 一个 historian lease。worker 使用唯一 owner token 获取 finite TTL；持有者可在到期前
renew 或 release，错误 token 不能影响其他 worker。expired lease 可由新 worker 在短 transaction 中替换；未拿到 lease
的 process 跳过本次 historian run。当前 historian run 会在 active 时续约 lease；具体 terminal semantics 见后文。

schema v4 增加 immutable compartment records：partition、`m0`/`m1` tier、source entry range、source fingerprint、
rendered payload 与 publication revision。`publishCompartment` 仅接受当前 partition snapshot，并在一个 transaction 内插入
record 和推进 revision；stale snapshot 不写任何 record。read API 只返回当前 partition 的 revision-ordered records。
结构、coverage、graph validation 与 historian output mapping 是当前 publication fence 的组成部分。

draft validator 不序列化或猜测 Pi message。它只接收 ordered source entry IDs 与该 immutable snapshot 的 fingerprint：
draft 必须使用 `m0`/`m1` tier、匹配 fingerprint，且 start/end ID 必须在同一 snapshot 内按 source order 形成 inclusive
range。跨-tier merge topology、historian JSON mapping、repair prompt 与 publication policy 由 historian publication
path 执行，不能由 store schema 推断。

source snapshot 从 `sessionManager.getBranch()` 的 active branch 顺序读取 entry IDs；它验证 nonempty/unique ID，并以
SHA-256(JSON entry-ID array) 生成 fingerprint。snapshot 不序列化 message content，避免在未确认 Pi entry shape 前把
lossy projection 当 canonical source；后续 historian mapper 必须保留这份 source branch 与 snapshot fence。

historian output mapper 只接受 exact JSON object：`tier`、`sourceStartEntryId`、`sourceEndEntryId`、`renderedPayload`。
它拒绝 Markdown fence、extra key、错误 type 或 invalid JSON；不信任模型提供 fingerprint，而是注入 immutable source
snapshot 的 fingerprint，再调用 source validator。mapper 的 stable invalid reason 可直接进入一次 repair Completion；
mapper 本身仍不调用 Completion 或 publish。

historian executor 使用 ext-core `startSubagent(..., { mode: "completion" })`，只提供 no-tools JSON-only completion。
caller 提供 source text 与 immutable snapshot；executor 将 ordered entry IDs 和 exact output schema 放入 prompt，并将 core
terminal result 规范为 completed/cancelled/failed。run-local abort 会 cancel handle；executor 不重试、不 repair、不获取 lease，
也不 publish record。

historian orchestrator 是显式 async function：以 current partition snapshot 获取一次 finite lease，运行 primary completion，
mapper invalid 时仅以 diagnostic 运行一次 repair completion，然后用同一 snapshot 原子 publish。lease acquisition failure
返回 skipped；CAS conflict 返回 stale，不重试；任意路径在 `finally` release lease。active run 续约 lease；仅 core
结构化分类为 `transient` 的 provider failure 可在同一次 lease 内最多重试两次，retry delay 使用 cancellable jitter。
它不做 trigger 或 Pi context rendering。

source-history projection 从 `sessionManager.getBranch()` 的 ordered `SessionEntry[]` 工作，使用 Pi
`sessionEntryToContextMessages()` 作为唯一 entry-to-message projection。一个 complete turn group 从 user message 开始，
包含直到下一 user message 前的所有 entries，且必须以 assistant message 收尾；最新 complete groups 保留为 protected tail。
eligible groups 的 entry IDs 建立 source snapshot，canonical projected messages 用 JSON source text 交给 historian；不自行猜测
Pi content block 或 tool-result shape。

branch runner 只组合 source-history projection 和 historian orchestrator。caller 提供 active branch entries、current runtime
partition/model/store 与 abort signal；ineligible projection 不取 lease、不调用 model，eligible projection 交给同一 explicit
orchestrator。parent `turn_end` 使用已实现的 token-pressure policy 调用该 seam，但 handler 不 await background job。

默认 compartment trigger 在 parent `turn_end` 检查 token usage 的 threshold 与 hysteresis。越过阈值后，
`pi-mctx` 异步执行一次 compartment run；handler 不 await historian。job 使用 session-local
`AbortController`，`session_shutdown` 或 `/reload` 先 abort job、再 close store。它只处理稳定 history
snapshot，不能阻塞 prompt、改写 active turn，也不能在 parent session replacement 后发布旧结果。

每次 parent model invocation 在 `pi.on("context")` 从 context store 读取最后一个已 materialize 的
cache-stable context block，替换即将发送的 Pi messages，并将 live tail 裁剪到 compartment boundary。in-flight
historian 不会阻塞本次 invocation；它完成后的新 revision 只在后续 context pass 生效。`pi-mctx` 不把 summary
物化为 Pi compaction entry，也不插入 synthetic conversation message。这保持 source transcript、MCTX canonical
summary 与 model-visible rendered context 三层分离。

首个 pipeline milestone 不在 `before_agent_start` 追加 MCTX system-prompt block。该 surface 只在未来出现
guidance、memory、docs 等 system adjunct 时单独设计。

parent historian 必须有显式、形状有效的 model config，负责把 history snapshot 写成 compartment。未配置时，
`pi-mctx` 不产生 compartment，且不隐式复用 parent agent model；Pi 原生 history/compaction 继续工作。
runtime authentication 或 model-availability failure 不发布新 compartment，保留上次 committed context 并走
historian failure policy。

parent historian 是 `@hheei/pi-ext-core` 的 Completion consumer。`pi-mctx` 提供已解析的 historian
model 与 prompt policy；core 负责 completion 的 admission、execution、timeout/abort、terminalization 和
dispose。`pi-mctx` 不直接调用 Pi AI，也不启动 `pi-subagents` child。

在 DB/transform activation 前，`pi-mctx` lifecycle 配置或复用 core shared coordinator 的
`maxActiveTurns: 2`，与现有 core Completion consumers 对齐；SQLite lease 仍将 historian 限为每个 context
partition 一次。若已有 coordinator 使用不同 cap，activation 拒绝并产生 diagnostic，Pi native behavior 继续；
不直接调用 Pi AI，也不向 core 引入 implicit default。

pipeline 启用后，context store 无法 open、migrate 或通过 schema validation 时默认 fail closed：阻止 parent
turn 并呈现可操作的 storage error。未来可通过显式 config opt out 回退 Pi native behavior。无 historian model
config 属于可选能力缺席，不是 context-store failure。

store foundation 使用 Node `node:sqlite`。schema v2 新增 `projects` 和 `partitions`：partition 以 stable project
identity 与 Pi session ID 唯一标识，初始 revision 是 `0`。get-or-create 在短 `BEGIN IMMEDIATE` transaction 内保证
同一 key 只得到一个 partition；不创建 lease、compartment 或 context block。migration 从 v1 metadata fence 原子升级；
未知 nonempty database、foreign application ID 或高于当前版本的 schema 均拒绝打开。成功 store 是 session runtime
resource，shutdown 必须 close；enabled pipeline 的 open/migration/schema failure 先显示 storage error，再让 lifecycle
start fail，不能留下无 store 的 active runtime。

stable project identity resolver 独立于 SQLite：它先 canonicalize Pi `cwd`，再读取 Git reachable root commit，得到
`git:<commit>`，使 worktree/clone 对齐。non-Git directory 使用 `dir:<SHA-256(realpath)>`；raw path 不进入 identity
或 database。Git command transient failure 只可重用本 process 同一 canonical directory 的 last-known Git identity，
否则退回 directory identity；canonicalization permission failure 不能安全 fallback，拒绝 activation。resolver 本身不创建
project 或 partition row。

enabled session activation 在 store open 后解析 project identity，并以它和 Pi session ID get-or-create partition；
runtime 持有该 partition。identity 或 partition 失败会关闭刚打开的 store、呈现 storage error 并失败 lifecycle start，
不能留下未分区 runtime。runtime 后续在 `turn_end` 执行 historian，并在 `context` pass 使用该 partition 的 verified graph。

`pi-mctx` 自己拥有 HEPI/Pi-native configuration：user-level `pi-mctx` namespace 加 optional project `.pi`
override。保存配置不热改 active pipeline；extension 只在下一次 `session_start` 或 `/reload` 读取并应用。它不
依赖 `hepi-basics` settings provider，也不读取 CortexKit config 路径。

configuration 使用既有 Pi settings layout：global `<getAgentDir>/settings.json` 和 project
`<cwd>/.pi/settings.json` 的 `pi-mctx` section。两处都保存 raw schema，但 active pipeline 使用 field-scoped
merge：user config 必须启用 pipeline 并选择有效 historian；project 只可 disable，不可单独启用。historian、
fail-closed policy 与 SQLite tuning 是 user-only；project 只能提高已由 user 设置的 trigger threshold，不能
引入或降低 threshold。future reserved field 必须在其 feature milestone 决定 scope，不能继承 blanket override。
它通过 atomic read-modify-write、process queue 和 file lock 更新，不能覆盖同一 settings file 的 sibling section；
它不与 SQLite context store 混用。

core 的 merged settings entry 同时提供 `global`、`project`、默认 project-wins `merged` 和 structured key path
来源查询，供不需要额外 trust policy 的 consumer 使用。MCTX 保留 raw layers 执行上述 field-scoped merge；不能以
默认 `merged` 允许 project 选择 historian 或改变 fail-closed policy。

迁移期保留完整 upstream-shaped MCTX configuration schema。首个 pipeline milestone 只读取已实现的
`enabled`、historian model、trigger budget 和 fail-closed policy；其余字段保存为 reserved/inactive，暂不产生
行为。它们不是 backward-compatibility promise；未来每项 feature 启用其字段时，代码必须用 `ponytail:` 注释说明
当前 inactive ceiling 与 activation trigger。schema baseline 固定为
`@hheei/pi-magic-context@0.33.1-hepi.0`；public CortexKit source 只能辅助研究，不能让 validation 跟随
upstream `master` 漂移。reserved/inactive values 作为 opaque JSON 保存；首版只 validation active pipeline
fields，不提前复制 Dreamer、embedding、experimental 等未实现 feature 的 runtime validator。

context pipeline 默认关闭。用户必须显式配置 parent historian model 并启用 pipeline；只有启用后才打开或
migrate context store、注册 context transform，并进入 fail-closed storage contract。未启用的 package 不改变
Pi runtime。

若 `enabled: true` 但 parent historian configuration 无效，`pi-mctx` 拒绝 activation：不打开 store、不注册
transform，呈现 config diagnostic 后保留 Pi native behavior。它不是 context-store failure；用户修正配置并
reload 后才启用 pipeline。

首个 runtime activation slice 在 `session_start` 读取 config，并用 Pi `modelRegistry.find()` 与
`hasConfiguredAuth()` 解析显式 historian model。disabled config 保持静默 native behavior；invalid config、
unavailable/unconfigured model 或 core Completion coordinator cap collision 显示 diagnostic 后保持 native
behavior。只有解析成功时才配置/reuse `maxActiveTurns: 2` coordinator 并创建 session-scoped MCTX runtime holder；
shutdown 会清除该 holder。store/partition wiring、`turn_end` historian 和 verified `context` projection 已附加。

已激活的 compartment trigger budget 使用 model-aware percentage threshold、absolute-token fallback/guard 和
hysteresis。具体 default 必须在 `pi-mctx` schema 与 focused tests 中固定；它不隐式追随会变化的 upstream
default。

trigger policy 是 pure state decision；parent `turn_end` 使用它但不改变配置读取。percentage 默认值为 `65`，并且必须在
`20..80`；known context window 时 trigger token threshold 是 `max(ceil(window * percentage / 100), absolute)`，
其中 absolute 可缺省。unknown context window 时只使用 absolute；两者都没有时结果为 unavailable。一次 trigger
将状态设为 cooling；cooling 仅在 usage 不高于 percentage threshold 减少 `10` percentage points，且（若配置）
不高于 absolute 的 `90%` 时 re-arm。usage、context window 和 absolute threshold 必须是正 safe integer。

context store 使用 upstream-aligned tiered graph：stable、cacheable `m[0]` history tier 加 newer
materialized `m[1]` tier，再接 compartment boundary 后的 live tail。context transform 将这三层组合为
model history；它不使用单一 rolling summary。

context transform 只处理已验证 graph。它使用 Pi `sessionEntryToContextMessages()` 重建 branch 的 raw
message sequence，并只在该 sequence 以 object identity 连续存在于 imminent `context` event 时替换 covered
segment；这样保留其他 extension 已注入的 messages。无法匹配时 fail open，不改 Pi context。replacement 使用两个
model-visible、`display: false` custom messages（`pi-mctx:m0`、`pi-mctx:m1`）和 branch live tail；每个 tier
payload 以稳定 order 拼接，timestamp 固定为 `0` 以保留 m0 cache stability。store read failure 仍遵守 enabled
pipeline 的 fail-closed contract。

canonical tier graph 以 `publishedRevision` 严格递增排序。每个 record 的 source range 必须在 current
branch 重新计算 fingerprint；相邻 record 的 range 必须连续、不可 overlap 或 gap，tier 只能从零或多个
`m0` 进入零或多个 `m1`，不得在 `m1` 后回到 `m0`。第一个 range 可以位于 Pi initial metadata 之后；
最后一个 verified range 的 end 是唯一 live boundary。任何不满足这些条件的 graph 不注入 model context，
而是保留 raw Pi history，等待后续 rebuild。后续 historian publication 必须从该 verified boundary 后
开始，不能再次覆盖已有 range。空 graph 的首个 publication 必须是 `m0`；已有 verified graph 的
publication 必须是 `m1`。成功 publication 返回的新 partition revision 成为该 session runtime 的下一次
compare-and-commit snapshot。

live tail 使用 token-budgeted recent complete parent turn groups。user input、其 assistant response 和关联
tool/result 不能被 compartment boundary 切开；只有 boundary 前的 eligible head 可以交给 historian。

Pi fork 在 `session_start` 创建新的 context partition，并从 source partition 过滤复制仍在 child branch 中有效的
ancestor compartments。复制失败 fail open，child 后续 compartment run 可 rebuild；forked child 绝不与 parent
共享 partition。

同一 Pi session 的 branch divergence 在每个 context transform 验证 stored source-range fingerprint 与
boundary。若不匹配，`pi-mctx` 原子失效 divergent compartments、保留可验证 ancestor，暂时传递 raw eligible
history，之后由 historian rebuild；不会新建 leaf partition，也不会注入 stale summary。

recovery planner 只把 range missing/reversed 或 fingerprint mismatch 视为可恢复 branch divergence：它从首个
失效 `publishedRevision` 起标记 tail，保留此前连续 verified graph，并给出 rebuild source start。gap、overlap、tier
regression 或 revision disorder 是 store corruption，不推测删除任何 record，继续 fail closed。无 verified ancestor
时，rebuild 从失效 range 仍可定位的 start 开始；若 start 不在 branch，则从 index `0` 重新评估完整 raw branch。
tail prune 与 partition revision compare-and-commit 在同一 SQLite transaction；stale snapshot 不删除任何 record，
caller 必须 reread 并重新 plan。

成功 prune 后，当前 context pass 保留 raw history，并立即安排一项 cancellable rebuild historian job，不等待普通
token trigger。若旧 branch historian 仍运行，先 abort 它并保留唯一 pending rebuild；旧 job terminal 后才启动新 job。
shutdown/reload 清除 pending rebuild 并 abort current job。

每个 context partition 使用 SQLite compartment lease 实现 historian single-flight。lease 有 finite TTL；run 每半个
TTL renewal，abort/shutdown/terminal path 均 release 最新 owner lease；其他 process 在持有期跳过该 run，crash 后可以在
TTL expiry 后接管。renewal 未命中代表 owner 已丢失 lease，orchestrator abort 当前 Completion、拒绝 publication，并在
`finally` release；lease 不替代 publication revision transaction。production interval 固定由 lease TTL 推导；测试可仅通过
historian request 的 private timing seam 缩短 interval，不能成为 user configuration。

首个 pipeline milestone 不对 context partition 做 automatic semantic deletion。可以进行 non-destructive
SQLite maintenance，但 TTL prune、shutdown deletion 和 user-facing data-management contract 都延后到独立 feature。

parent historian output 必须通过 structural、chunk coverage、protected-tail boundary 和 graph-invariant
validation 才能原子 publish。首次 validation failure 运行一次 repair Completion；repair 或任何 validation
failure 都保留上次 committed context，不写 partial state。

transient parent historian provider failure 最多进行两次 cancellable jittered retry。core 只根据数值 HTTP
`status`/`statusCode` 与标准 transport `code` 生成 retry classification；未能可靠分类的 error 不重试，不能从
message 文本猜测。abort、authentication、HTTP 400 或其他 client error、configuration error 与 validation
failure 不重试；validation repair 是独立的一次 Completion，且共享该 run 的总 retry budget。

首个 pipeline milestone 使用 model-invisible Pi native notification 加 structured log 报告 invalid config、
context-store failure 与 cooldown-eligible historian failure。它不注册 `/ctx-*` command、statusbar 或 custom
renderer。

parent-to-child inheritance Service 与 `pi-subagents` integration 不属于首个 pipeline milestone。该 milestone
不公开 service payload、不注册 provider，也不让 `pi-subagents` 读取 MCTX SQLite；parent transform/store/historian
须先独立通过 focused tests。

## 延后决策

- 具体 schema default、token accounting source、stable project identity，以及 SQLite schema/migration 版本；
- memory、note、search、Dreamer、embedding、command、status 和 UI 的具体行为；
- parent-to-child inheritance Service payload 和 `pi-subagents` integration；
- child `mctx-lean` historian profile。只有 Pi 原生 compaction 在长任务中被证实不足时，才单独
  提出该 profile；它不应成为 child 默认行为；
- 现有 `@hheei/hepi-mctx` wrapper 的弃用或移除计划。

任何上述功能开始前，先更新本文档并完成 focused design discussion、测试设计和用户确认。
