# pi-mctx 使用独立 context store

`@hheei/pi-mctx` 的 parent context pipeline 使用 MCTX-owned SQLite context store 保存 compartment graph，
并以它作为渲染上下文的 canonical state。Pi session branch 仍保留 source transcript 与 host compaction entry。
虽然直接使用 Pi `compaction` entry 可以避免数据库，但它无法承载独立的多层 compartment 语义；SQLite 的
migration、locking、recovery 和 session identity 成本由 `pi-mctx` 自己承担，不能提升到 `pi-ext-core`。

store 是 user-level shared DB，并以 stable project identity 与 Pi session identity 分区。多个 worktree 或
Pi process 可以共享 DB，但 compartment 只可由创建它的 parent session 读取；context pipeline 不建立
跨 session shared state。Pi fork 只复制有效 ancestor state 到新的 child partition。

project identity 优先使用 `git:<root-commit>`，使同一 repository 的 worktree/clone 对齐；non-git project 使用
`dir:<SHA-256(realpath)>`。transient Git failure 只能复用当前 process 的 last-known Git identity，否则使用
directory fallback；permission-denied 不可靠地界定 project boundary，拒绝 activation 并呈现 diagnostic。identity
不得来自 remote URL 或 development-machine absolute path。

identity resolver 是 SQLite schema 之前的独立 runtime boundary：它只 canonicalize `cwd`、查找 reachable Git root
commit 或产生 directory hash，不创建 database row。Git command failure 可使用同一 process/canonical directory 的
last-known Git identity；没有该 cache 时才使用 directory fallback。canonical path permission failure 拒绝 activation，
不能把一个无法可靠识别的 directory 混入另一个 partition。

context store 位于 `<getAgentDir>/mctx/context.db`。它与 global settings file 分开，不能放入 project/worktree，
也不能依赖开发机绝对路径。

store 使用 SQLite WAL、短事务和 busy timeout。每个 partition 有独立 monotonic revision；writer 只能在
预期 revision 仍有效时发布 compartment。冲突 writer 必须重读和重算，不能采用 last-writer-wins。

store 的 revision CAS 接收 partition snapshot，使用单个 conditional `UPDATE` 使 revision 加一。返回新 snapshot
表示提交者保有 fence；未命中返回 `undefined`，调用者必须重新读取/recompute。它不接受 last-writer-wins fallback；
后续 compartment publication 会把 content write 与该 fence 置于同一 transaction。

schema v3 增加 per-partition historian lease。lease 由 owner token、finite expiry 组成；acquire 在短 transaction
清理该 partition 的 expired row 后条件插入，未获得者跳过本次 run。renew/release 必须匹配 token，不能干扰新 holder；
crash 后只有 TTL expiry 允许接管。lease 不替代 revision CAS，后续 publication 仍必须比较 revision。

schema v4 增加 append-only compartment record：partition、`m0`/`m1` tier、source range/fingerprint、rendered payload
与 publication revision。publish 将 insert 和 partition revision fence 放进同一 transaction；stale snapshot rollback，
不能留 partial record。read 只按 partition/revision 返回记录。output validation、tier graph invariants 与 payload mapping
仍属于 historian publication slice，不能由 storage schema 猜测。

draft validator 是 source-evidence boundary，不依赖 Pi message serialization：caller 传入 ordered entry IDs 和 immutable
snapshot fingerprint，validator 确认 tier、fingerprint 与 inclusive start/end range。它不推断跨-tier graph topology，也不
接受模型声明的未验证 coverage；historian output mapping/repair 在后续独立 slice 才能调用 storage publication。

source snapshot 从 Pi active `getBranch()` 的 ordered entry IDs 建立。每个 ID 必须 nonempty 且在 snapshot 中唯一；
fingerprint 是 SHA-256(JSON entry-ID array)。这只为 branch order/identity 提供 fence，不声称等价于 Pi message
serialization；后续 historian mapper 必须同时持有原 branch snapshot，不能把 ID hash 当可压缩的 source content。

historian output mapper 只接受 exact JSON object `{ tier, sourceStartEntryId, sourceEndEntryId, renderedPayload }`。它拒绝
Markdown/extra key/错误 type/invalid JSON，不接受模型控制 `sourceFingerprint`；MCTX 从 immutable snapshot 注入 fingerprint
后调用 source validator。invalid reason 是稳定 repair diagnostic，但 mapper 不执行 Completion 或 storage publication。

schema v2 在 v1 application/metadata fence 上建立 `projects` 与 `partitions`。partition 以 stable project identity
与 Pi session ID 唯一标识，revision 从 `0` 开始；get-or-create 使用短 `BEGIN IMMEDIATE` transaction，不能重复创建。
此迁移仍不建立 lease、compartment 或 graph table。未知 nonempty database、foreign application ID 或 future schema
version fail closed，不能以“version 0”覆盖可能属于其他程序的数据。

每次 parent model invocation 通过 `pi.on("context")` 将最后一个已 materialize 的 cache-stable context block
插入 transformed Pi messages，并将 live tail 裁剪到 compartment boundary。in-flight historian 不阻塞当前
invocation；其新 revision 只在后续 context pass 生效。MCTX 不把 summary 物化为 Pi compaction entry，也不插入
synthetic conversation message，从而保持 source transcript、MCTX canonical summary 和 model-visible rendered
context 分离。`before_agent_start` 的 system-prompt adjunct 不属于首个 context pipeline milestone。

pipeline 启用后，context store open、migration 或 schema validation failure 默认 fail closed：`pi-mctx` 阻止
parent turn 并呈现可操作 error。未来可以由显式 config opt out 回退 Pi native behavior；缺少可选 historian
model 不属于 store failure。

context store 使用 tiered `m[0]/m[1]` graph：stable cacheable `m[0]` history tier、newer materialized
`m[1]` tier 和 compartment boundary 后的 live tail 共同构成 transformed model history。单一 rolling summary
不满足 cache stability 与 upstream-aligned compartment semantics。

live tail 使用 token-budgeted recent complete parent turn groups。user input、其 assistant response 和关联
tool/result 不能被 compartment boundary 切开；只有 boundary 前的 eligible head 可以交给 historian。

Pi fork 创建新的 context partition，并从 source partition 过滤复制仍对 child branch 有效的 ancestor
compartments。复制失败时 child fail open 并在后续 compartment run rebuild；forked child 不得共享 parent
partition。

同一 Pi session 的 branch divergence 在每个 context transform 验证 stored source-range fingerprint 与
boundary。若不匹配，`pi-mctx` 原子失效 divergent compartments、保留可验证 ancestor，暂时传递 raw eligible
history，之后由 historian rebuild；不会新建 leaf partition，也不会注入 stale summary。

每个 context partition 使用 SQLite compartment lease 实现 historian single-flight。lease 有 finite TTL、
run 中 renewal、abort/shutdown release；其他 process 在持有期跳过该 run，crash 后可以在 TTL expiry 后接管。
lease 不替代 publication revision transaction。

首个 pipeline milestone 不对 context partition 做 automatic semantic deletion。可以进行 non-destructive
SQLite maintenance，但 TTL prune、shutdown deletion 和 user-facing data-management contract 都延后到独立 feature。

parent historian output 必须先通过 structural、chunk coverage、protected-tail boundary 和 graph-invariant
validation。首次 validation failure 可以运行一次 repair Completion；只有通过 validation 的结果才能原子
publish，失败时保留上次 committed context，不写 partial state。
