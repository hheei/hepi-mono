# pi-mctx

## 状态

已创建独立、可安装的 `@hheei/pi-mctx` package。默认 disabled，保持 Pi native behavior；启用且 historian
configuration 有效时，它在 `session_start` 解析 runtime、打开/migrate MCTX SQLite store，并绑定当前 project/session
partition。当前仍不压缩上下文、不注册 tool、不调用 historian Completion，也不注册 `context` transform。

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
的 process 跳过本次 historian run。此 slice 只提供 store primitive，尚未启动 renewal timer 或 historian。

schema v4 增加 immutable compartment records：partition、`m0`/`m1` tier、source entry range、source fingerprint、
rendered payload 与 publication revision。`publishCompartment` 仅接受当前 partition snapshot，并在一个 transaction 内插入
record 和推进 revision；stale snapshot 不写任何 record。read API 只返回当前 partition 的 revision-ordered records。
结构/coverage/graph validation 与 historian output mapping 留给下一 slice。

draft validator 不序列化或猜测 Pi message。它只接收 ordered source entry IDs 与该 immutable snapshot 的 fingerprint：
draft 必须使用 `m0`/`m1` tier、匹配 fingerprint，且 start/end ID 必须在同一 snapshot 内按 source order 形成 inclusive
range。跨-tier merge topology、historian JSON mapping、repair prompt 与 publication policy 尚未启用。

默认 compartment trigger 在 parent `turn_end` 检查 token usage 的 threshold 与 hysteresis。越过阈值后，
`pi-mctx` 异步执行一次 compartment run；它只处理稳定 history snapshot，不能阻塞 prompt、改写 active turn，
也不能在 parent session replacement 后发布旧结果。

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
不能留下未分区 runtime。此 wiring 不注册 context hook 或 historian Completion。

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
shutdown 会清除该 holder。后续 store/partition wiring 已附加，但仍不注册 `context` hook 或调用 historian Completion。

已激活的 compartment trigger budget 使用 model-aware percentage threshold、absolute-token fallback/guard 和
hysteresis。具体 default 必须在 `pi-mctx` schema 与 focused tests 中固定；它不隐式追随会变化的 upstream
default。

context store 使用 upstream-aligned tiered graph：stable、cacheable `m[0]` history tier 加 newer
materialized `m[1]` tier，再接 compartment boundary 后的 live tail。context transform 将这三层组合为
model history；它不使用单一 rolling summary。

live tail 使用 token-budgeted recent complete parent turn groups。user input、其 assistant response 和关联
tool/result 不能被 compartment boundary 切开；只有 boundary 前的 eligible head 可以交给 historian。

Pi fork 在 `session_start` 创建新的 context partition，并从 source partition 过滤复制仍在 child branch 中有效的
ancestor compartments。复制失败 fail open，child 后续 compartment run 可 rebuild；forked child 绝不与 parent
共享 partition。

同一 Pi session 的 branch divergence 在每个 context transform 验证 stored source-range fingerprint 与
boundary。若不匹配，`pi-mctx` 原子失效 divergent compartments、保留可验证 ancestor，暂时传递 raw eligible
history，之后由 historian rebuild；不会新建 leaf partition，也不会注入 stale summary。

每个 context partition 使用 SQLite compartment lease 实现 historian single-flight。lease 有 finite TTL、
run 中 renewal、abort/shutdown release；其他 process 在持有期跳过该 run，crash 后可以在 TTL expiry 后接管。
lease 不替代 publication revision transaction。

首个 pipeline milestone 不对 context partition 做 automatic semantic deletion。可以进行 non-destructive
SQLite maintenance，但 TTL prune、shutdown deletion 和 user-facing data-management contract 都延后到独立 feature。

parent historian output 必须通过 structural、chunk coverage、protected-tail boundary 和 graph-invariant
validation 才能原子 publish。首次 validation failure 运行一次 repair Completion；repair 或任何 validation
failure 都保留上次 committed context，不写 partial state。

transient parent historian provider failure 最多进行两次 cancellable jittered retry。abort、authentication/400、
configuration error 与 validation failure 不重试；validation repair 是独立的一次 Completion。

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
