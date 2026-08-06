# MCTX 与 Hindsight 记忆架构

状态：设计提案，未进入实现。

参考：

- Hindsight upstream `vectorize-io/hindsight`，revision `d637008fbef54efef6e4fdfc8896dfa9994bc23c`
- `references/repos/cortexkit-magic-context/`
- `packages/pi-hindsight/docs/hindsight-core-functions.md`
- `packages/pi-hindsight/docs/adr/001-memory-lifecycle-and-scope.md`
- `packages/pi-hindsight/docs/adr/005-domain-banks-and-agent-first-surface.md`
- Hindsight upstream `docs/superpowers/specs/2026-07-27-reflect-pages-runtime.md` at the pinned revision

## 1. 核心直觉与目标

MCTX 与 Hindsight 不应各自维护一套完整的长期记忆系统。Hindsight 负责从 raw source
中提取、巩固和推理长期知识；MCTX 负责把已选知识编译成受 context budget、prefix cache、
session、fork 和 handoff 约束的稳定模型上下文。

```text
Pi session / project evidence
        |
        v
Hindsight retain
        |
        +--> world / experience facts
        +--> observations
        +--> reflect / mental models / knowledge pages
        |
        v
MCTX knowledge materializer
        |
        +--> stable m0 baseline
        +--> bounded m1 delta
        +--> local per-turn page-section selection
        |
        v
Pi model context
```

目标：

- 保留 MCTX 的 deterministic context projection、m0/m1 snapshot、history tags、smart drop、
  historian、fork/handoff 和 compaction recovery。
- 使用 Hindsight 的 raw retain、semantic retrieval、facts、observations、reflect、mental models
  和 knowledge pages，不在 MCTX 重复实现这些知识能力。
- 让 Hindsight 的网络、异步 extraction、consolidation 和 refresh 不破坏 MCTX 的 prefix cache、
  CAS、取消和 context replay。
- 明确 remote knowledge freshness、MCTX snapshot freshness 和当前 turn relevance 的边界。

非目标：

- 不把 Hindsight 直接塞进 MCTX compartment graph。
- 不让 MCTX 每个 turn 对 Hindsight 做远程 recall。
- 不把 Hindsight recall 结果直接当作最终答案。
- 不把 MCTX 的 session compartments、history tags 或 Pi transcript 迁移到 Hindsight。
- 不在第一阶段重写 `pi-hindsight` 的 lifecycle、queue、bank routing 或 client。

## 2. 边界映射

### Pi host

Pi host 拥有 session branch、当前 model context、context hook、native compaction、reload、
ExtensionContext 和 cancellation。Pi host 不解释 Hindsight facts，也不拥有 MCTX memory policy。

### ext-core

ext-core 只拥有跨 extension capability transport、lifecycle、abort、cleanup 和 revision guard。
它不拥有 memory record、bank、tag、page、fact、observation、rendered content 或 MCTX policy。

### pi-hindsight

pi-hindsight 是 Hindsight capability provider。它拥有：

- Hindsight client 和 server capability detection；
- coding/life/isolated bank routing；
- project/user scope tags；
- retain queue、retry、dead-letter 和 shutdown flush；
- recall、reflect、mental model、knowledge page 操作；
- Hindsight operation/status diagnostics。

pi-hindsight 不直接改 MCTX SQLite，不创建 MCTX compartment，不参与 MCTX CAS，不调用
`ctx_reduce`，不负责 Pi context prefix cache。

### pi-mctx

pi-mctx 是 context compiler。它拥有：

- Hindsight knowledge snapshot 的 materialization state；
- m0/m1 context placement、token budget 和 cache identity；
- page-section local index 和 score floor；
- snapshot invalidation、stale state、CAS publish、fork/handoff projection；
- MCTX context markers、history tags、smart drop 和 native compaction interception。

pi-mctx 不拥有 Hindsight bank、retain queue、observation extraction、embedding、semantic rank、
reflect prompt 或 mental-model content generation。

### Hindsight knowledge snapshot

这是 MCTX 的投影缓存，不是 Hindsight 的第二份事实库。snapshot 保存：

- selected bank role 和 strict scope filter；
- source kind：reflect、mental model、knowledge page、observation；
- Hindsight object IDs 和 provenance；
- source version、updated timestamp 或 content fingerprint；
- rendered text、section metadata 和 token count；
- materialization status 与 last error。

snapshot 可以在 Hindsight refresh 前继续 replay。它必须标记 freshness，不能伪装成最新知识。

## 3. 知识产品与上下文层级

Hindsight upstream 明确区分：

```text
Retain        = 保存 raw source
Recall        = 返回相关候选
Reflect       = 针对问题做深度分析
Observations  = 从重复证据中巩固的事实/信念
Mental Models = 面向重复问题的可复用综合答案
Knowledge Pages = 面向人和 agent 的组织化长期知识视图
```

MCTX 不把这些产品混成一个 `Memory[]`。目标 context tier：

### m0 stable baseline

适合跨 turn 重放、prefix cache 和 handoff 的稳定知识：

- project mental model；
- Hindsight knowledge page 中明确标为 project-stable 的 sections；
- 经过 materializer 固定的 project observations；
- 一次 session-start 或 hard materialization 的 reflect synthesis。

m0 只使用已缓存 snapshot。普通 turn 不重新远程 recall 或 reflect。m0 fingerprint 包含
source IDs、source versions、scope、render policy 和 rendered payload。

### m1 bounded delta

适合当前 session 或近期变化、但尚未成为长期 baseline 的内容：

- 新的 Hindsight observations；
- 当前 project page refresh 后的增量 sections；
- hard materialization 后新增且通过 policy 的 stable knowledge。

m1 仍由 MCTX 固定 snapshot 后重放。它不是每个 turn 的动态远程结果。

### turn-local selection

Hindsight upstream 最新 Reflect + Pages runtime 的经验表明，raw recall-per-prompt 可能比无记忆更差。
因此 turn-local 路径不做默认远程 recall。第一阶段使用已缓存 knowledge pages 的本地 section index：

- 按 heading/body lexical overlap 评分；
- heading 命中权重更高；
- 选择 top 2-3 sections；
- 总预算约 700 tokens，但由当前 context budget 收紧；
- 低于 score floor 时不注入；
- 注入包含 page/section provenance 和读取完整 page 的指引。

后续若 benchmark 证明当前任务需要 query-dependent recall，才增加显式 opt-in 的 Hindsight recall。
它不能悄悄进入 stable m0/m1，也不能在每轮无 score floor 地注入。

## 4. 运行时流程

### Session start

```text
Pi host session_start
  -> ext-core starts pi-hindsight and pi-mctx lifecycles
  -> pi-hindsight resolves setup, banks and project scope
  -> pi-mctx loads last valid knowledge snapshot
  -> if snapshot fresh: replay m0/m1
  -> if stale and policy permits: schedule one bounded materialization
  -> Pi context receives stable snapshot only
```

session start 不因 Hindsight network failure 阻塞 MCTX context。若没有 valid snapshot，MCTX
明确显示 unavailable/stale，而不是把旧内容伪装为 fresh，也不回退到另一套 memory backend。

### First real task

使用 Hindsight Reflect + Pages runtime 的 upstream 模式：

```text
first task message
  -> one reflect query over selected bank/scope
  -> obtain synthesized answer or explicit failure
  -> fetch/cache knowledge page roster and content if supported
  -> build local section index
  -> publish one MCTX knowledge snapshot
```

不在 session-open 对空 query 做 reflect。不在每个 prompt 做新的 reflect。

### Each turn

```text
current prompt
  -> MCTX matches cached page sections locally
  -> score floor + token budget
  -> optional turn-local block
  -> replay unchanged m0/m1 snapshot
  -> provider request
```

local section selection 的结果不写 Pi transcript，不 retain 回 Hindsight，不改变 m0/m1 fingerprint。

### Agent end

```text
Pi host agent_end
  -> pi-hindsight retains raw structured session delta
  -> queue persists before network flush
  -> Hindsight extracts facts and updates observations/pages/models asynchronously
  -> pi-mctx marks knowledge snapshot stale on successful/known remote update
```

pi-mctx 不复制 pi-hindsight queue。retain 失败不能破坏已经可用的 MCTX snapshot；状态必须显示
queued/failed/dead-letter，而不是静默当作 durable。

### Hard materialization

触发条件：

- `/mctx recomp` 或 `/mctx wrapup`；
- snapshot stale 且 context pressure 允许后台工作；
- Hindsight refresh watermark 变化；
- 显式 memory refresh command。

流程：

```text
claim one materialization lease
  -> capture Hindsight source/version snapshot
  -> reflect/page read within bounded budget
  -> validate source IDs, scope, fingerprint and rendered size
  -> atomic MCTX snapshot replace
  -> release lease
```

失败、cancelled、stale、scope mismatch 或 source-too-large 时保留旧 valid snapshot。不能先删旧
snapshot 再等待 Hindsight。

## 5. Hindsight 能力利用方式

### Retain

保留 pi-hindsight 的 raw structured retain。MCTX 不把已经压缩的 context projection 再 retain
为长期真相；应 retain 原始 session delta、tool action、decision、code change context 等 source。

stable document ID 的 owner 是 pi-hindsight 的 session/import identity helper。MCTX 只提供
provenance metadata，不自行复制 retain cursor、append queue 或 retry。

### Observations

Observations 是 Hindsight 的 consolidation product。MCTX 只消费带 scope/provenance 的 observation
projection，不自己 merge、supersede、strengthen 或 decay。Hindsight observation scope 不能包含 volatile
session tag；project scope 使用 stable project tag，shared observation 必须显式 opt-in。

### Reflect

Reflect 用于：

- first real task 的 session synthesis；
- hard materialization；
- 显式 memory refresh；
- mental model/page refresh 的 server-side workflow。

Reflect 输出先经过 MCTX schema、scope、budget 和 provenance validation，才可进入 snapshot。
Reflect 不能直接修改 MCTX state。

### Mental models

Mental models 是 m0 的首选输入，因为它们已经面向 recurring question 综合。MCTX 读取 selected
bank 中的 project-scoped 与允许的 bank-global models，按 active project scope 过滤。MCTX 不自动创建
或刷新 mental model；刷新由 Hindsight 控制面或显式 pi-hindsight agent operation 负责。

### Knowledge pages

如果连接的 Hindsight server 提供 upstream knowledge pages API，MCTX 使用 page roster/content 作为
本地 section index 的 source。page 是 Hindsight 的组织化视图，不是 MCTX memory row。

若当前 server/client 只有 0.8 retain/recall/reflect/mental-model surface，则不模拟 pages。第一阶段
可使用 mental models + bounded observations，等 page API capability 明确后再启用 page path。

## 6. 一致性与缓存

### 真相与缓存

```text
Hindsight raw/derived knowledge = long-term knowledge authority
MCTX knowledge snapshot         = context compilation cache
Pi transcript                   = raw conversation authority
MCTX compartment store          = context transformation authority
```

MCTX snapshot 不是 Hindsight transaction。它记录 capture metadata，并通过 content/version
fingerprint 检测 stale。无法获得稳定 source version 时，materializer 必须使用 content fingerprint
和 capture timestamp，且 status 标为 time-based/weak freshness；不能声称强一致。

### Prefix cache

Hindsight refresh 不应直接改变当前 request 的 m0 bytes。新知识只在下一次 successful materialization
后进入 m0/m1。turn-local page sections 必须独立于 m0 fingerprint，并有明确 cache policy。

### Archive / correction

Hindsight observation stale、矛盾或 source correction 由 Hindsight 处理。MCTX 只在下一次 materialization
读取新结果。若 Hindsight 没有可验证的 exclusion/provenance，MCTX 不得宣称旧事实已被移除；status 应显示
`knowledge freshness unresolved`。

## 7. Capability contract

跨 extension 不共享 Hindsight client。ext-core 提供窄 capability：

```ts
interface MctxKnowledgeService {
  getStableProjection(input: {
    projectId: string;
    bankRole: "coding" | "life" | "isolated";
    signal: AbortSignal;
  }): Promise<
    | {
        kind: "projection";
        sources: readonly {
          sourceKind: "mental-model" | "page" | "observation" | "reflect";
          sourceId: string;
          version?: string;
          text: string;
          tags: readonly string[];
        }[];
      }
    | { kind: "empty" }
    | { kind: "unavailable"; reason: string }
  >;

  getPageSections?(input: {
    projectId: string;
    signal: AbortSignal;
  }): Promise<
    | { kind: "sections"; version?: string; sections: readonly KnowledgeSection[] }
    | { kind: "unsupported" }
    | { kind: "unavailable"; reason: string }
  >;
}
```

该 capability 拥有 Hindsight routing、network、retry、response validation 和 source provenance。
MCTX 拥有 snapshot publication、context rendering 和 cache invalidation。`pi-hindsight` 可以省略
`getPageSections` when its connected server lacks the capability; MCTX then uses only stable projection,
not a fake page implementation.

## 8. Failure and fallback policy

- Hindsight unavailable before any snapshot exists: MCTX remains active with no knowledge block and shows
  an explicit diagnostic.
- Hindsight unavailable with a valid snapshot: replay snapshot as stale; show stale status.
- Reflect/page response malformed: reject the new snapshot; retain old snapshot.
- Scope/provenance mismatch: reject the response; never widen recall scope to make it fit.
- Hindsight retain failure: pi-hindsight owns retry/dead-letter; MCTX does not pretend retention succeeded.
- MCTX store failure: do not inject an untracked new knowledge block; preserve Pi raw context.
- No Hindsight provider: no knowledge capability is registered; no alternate backend is silently selected.

The only fallback is replaying a previously validated MCTX snapshot. This is stale-data replay with visible
status, not a second memory implementation.

## 9. Implementation phases

### Phase 0: capability audit

- Pin the upstream Hindsight revision and connected server/client version.
- Verify page list/read/version/provenance APIs, or record that pages are unavailable.
- Verify mental-model payload, tags, update timestamps and stable IDs.
- Verify observation recall filters, source facts and provenance.
- Verify correction/stale behavior after retain `replace`.

### Phase 1: stable projection, no UI behavior change

- Add the ext-core capability contract.
- Implement pi-hindsight provider using existing lifecycle/client ownership.
- Validate responses with runtime guards.
- Store MCTX knowledge snapshot and replay it only through existing context materialization.
- Keep current MCTX local memory behavior until comparison tests pass.

### Phase 2: Hindsight-backed knowledge compilation

- Use mental models and bounded observations for m0/m1.
- Add reflect hard materialization with one lease and atomic snapshot replacement.
- Add scope/provenance/fingerprint tests.
- Do not add per-turn remote recall.

### Phase 3: pages and local sections

- Enable only when server capability is verified.
- Build local page section index.
- Add score floor, budget trim, provenance labels and silence-on-low-score.
- Benchmark reflect-only against reflect+pages; reject regressions.

### Phase 4: remove duplicate MCTX knowledge machinery

Only after Phase 1-3 verification:

- remove local embeddings/vector search;
- remove local observation/dreamer/consolidation paths that duplicate Hindsight;
- remove duplicate retain queue only after pi-hindsight owns all required delivery semantics;
- retain MCTX snapshot/compiler state required for deterministic context.

No dual-read or dual-write compatibility path is planned. Any old durable data migration must be a separate,
explicit import operation with a receipt and verification before old tables/code are deleted.

## 10. Verification gates

- Scope isolation: project A cannot appear in project B strict projection.
- Bank-global/life memory cannot enter coding project projection without explicit policy.
- Recalled/retained source provenance survives projection and is inspectable.
- Hindsight response failure never changes existing m0/m1 bytes.
- Materialization CAS conflict leaves old snapshot intact.
- Repeated defer/context passes produce identical snapshot bytes.
- Reload aborts old provider requests and does not publish late results.
- First-task reflect is at most once per session.
- Page section injection makes no remote call on the hot path.
- Low-score page match injects nothing.
- Raw recall is not automatically retained again.
- Hindsight retain queue is durable before network delivery.
- Reflect-only and reflect+pages benchmark both beat or do not regress against the chosen baseline.

## 11. Open decisions before implementation

1. Which upstream Hindsight release exposes knowledge pages in the supported server/client contract?
2. Can current recall responses provide stable document/source provenance for MCTX dedupe?
3. Should MCTX compile observations into m1, or only mental models/pages into m0 until observation payload is proven stable?
4. What exact Hindsight freshness/version signal invalidates MCTX snapshot?
5. Does the project want Hindsight to become the sole long-term knowledge authority immediately, or only after
   an explicit import/reconciliation command proves existing MCTX memories were retained?

