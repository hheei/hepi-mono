# pi-mctx、pi-hindsight 与 pi-subagents 的可组合拆分研究

> 研究日期：2026-09-21
> 状态：研究结论，尚未作为实现方案批准。
> 说明：文中“事实”来自当前仓库或 Hindsight 官方资料；“建议”是本研究的架构判断。

## 1. 结论摘要

**建议拆成三个独立安装、独立发布、可组合使用的 concrete extension：**

```text
Pi host
├── pi-mctx       Window、compaction、local context、projection
├── pi-hindsight  retain/recall、Hindsight HTTP client、durable-memory lifecycle
└── pi-subagents  child Pi sessions、RPC、registry、parent/child control
```

推荐的依赖方向是：

```text
pi-mctx ──optional integration──> pi-hindsight
pi-subagents ──optional integration──> pi-hindsight
pi-mctx ──optional integration──> pi-subagents
pi-hindsight ──> pi-ext-core
pi-mctx ──────> pi-ext-core
pi-subagents ─> pi-ext-core
```

其中三条 integration 都必须是显式、可关闭、可观测的；不能把三个 extension 变成互相强依赖的套件。核心原则是：

1. **pi-hindsight 只拥有 durable memory 和 Hindsight API 适配。**
2. **pi-mctx 只拥有 Pi 上下文窗口、压缩、projection 和本地 session lane。**
3. **pi-subagents 只拥有 child session、RPC、恢复、registry 和父子控制。**
4. `provideService/getService` 只能解决**同一 Pi 进程**的可选能力发现，不能替代 child process IPC。
5. pi-mctx 与 pi-subagents 都可以消费 pi-hindsight；但 pi-hindsight 不应反向依赖任一具体 extension。

最小可行拆分不是把现有所有 memory code 原样搬到新包，而是先将 Hindsight port、`retain`、`recall`、health、outbox delivery 和 identity contract 移出 pi-mctx；之后再将 mctx 的 local search/projection 与 Hindsight durable lane 明确分层。

## 2. 当前实现盘点

### 2.1 pi-mctx 当前职责已经超过 Context Window

当前 `@hheei/pi-mctx` 的 package manifest 同时包含：

- Window/context transform 与 compaction；
- SQLite local context、memory、notes、primers、git commits；
- Pi-side `recall` 工具；
- native `mctx_memory` 管理工具；
- Hindsight client 依赖 `@vectorize-io/hindsight-client`；
- retain outbox、remote recall、context projection；
- Hindsight health command 和兼容配置。

证据：`packages/pi-mctx/package.json` 的依赖包含 Hindsight client；`docs/mctx/spec.md` 目前仍把 pi-mctx 描述为拥有 Window、projection、outbox、recall ledger 与 Pi lifecycle，同时把 Hindsight 描述为 durable-memory owner。

当前规格已经明确了一个重要边界：Hindsight 负责 bank、retain、recall、reflect、fact extraction、graph、consolidation；pi-mctx 负责 Window、projection、outbox、recall ledger 和 Pi lifecycle。这个边界适合作为拆包基础，但当前代码仍把两者放在同一 concrete extension 内。

### 2.2 `recall` 与 `retain` 已是自然的 Hindsight-facing contract

当前 model-visible 工具名已经改为：

- `recall`：查询本地 lane，并在启用时追加 Hindsight durable lane；
- `retain`：通过 transactional outbox 投递 Hindsight retain。

这两个名称比 `mctx_search` / `mctx_memory` 更适合成为 pi-hindsight 的公开 contract。`mctx_memory` 仍可保留为 pi-mctx 的 native maintenance surface，用于本地 memory 的 update/archive/merge 等操作，但它不应再承担 Hindsight retain 的别名职责。

证据：`packages/pi-mctx/src/tools/ctx-search.ts`、`packages/pi-mctx/src/tools/memory-save.ts`、`packages/pi-mctx/src/tools/index.ts` 及对应 tests。

### 2.3 pi-subagents 的职责边界相对清晰

`@hheei/pi-subagents` 当前拥有：

- child Pi session 的显式 session identity；
- detached runner 与可重连 RPC；
- parent/child registry；
- spawn、send、get、list、stop 等工具；
- child lifecycle、shutdown、resume/reconnect；
- `contact_parent` bridge。

它不直接拥有 durable memory。README 说明每个 child 有自己的 session file、RPC runtime 和 durable identity；registry 使用 ext-core 的 atomic cross-process-locked JSON 更新。

因此 pi-subagents 不应把 Hindsight client、bank 规则或 recall admission 复制进去。它只需要提供一个可选的 memory capability contract：child 是否继承 Hindsight extension、使用哪个 bank/identity、是否允许 retain/recall，以及父侧如何传递非秘密配置。

证据：`packages/pi-subagents/README.md`、`packages/pi-subagents/src/extension.ts`、`launch-spec.ts`、`registry.ts`、`rpc-adapter.ts`、`runner.ts`。

## 3. 三个 extension 的推荐所有权

| 能力 | pi-mctx | pi-hindsight | pi-subagents |
| --- | --- | --- | --- |
| Pi Window / transform / compaction | 所有 | 不负责 | 不负责 |
| 本地 SQLite context lane | 所有 | 不负责 | 不负责 |
| Hindsight HTTP client | 不拥有；只消费 port | 所有 | 不拥有；只消费 port |
| `retain` / Hindsight outbox | 不拥有 | 所有 | 通过 child 内 pi-hindsight 使用 |
| durable `recall` | 可选消费 | 所有工具与 backend contract | 可选透传给 child |
| local + durable result merge | pi-mctx integration | 提供 durable results | 不负责 |
| recall admission / projection | 所有 | 不负责 | 不负责 |
| child session / RPC / registry | 不负责 | 不负责 | 所有 |
| parent/child memory policy | 提供消费侧约束 | 定义 capability/policy inputs | 负责把 policy 传到 child |
| generic lifecycle / cleanup | ext-core | ext-core | ext-core |

### 3.1 pi-hindsight 应该是什么

建议 pi-hindsight 是一个真正可独立安装的 Pi extension，而不仅是内部 library。它至少提供：

- `retain` tool；
- `recall` tool；
- 显式 health/version command 或 status capability；
- Hindsight client、timeout、AbortSignal cancellation、协议错误处理；
- Hindsight bank/project identity resolution；
- local transactional outbox 与 retry/dedupe（若 outbox 必须与 Pi session 保持一致，则由 pi-hindsight 拥有）；
- capability service/API，供 pi-mctx 和 pi-subagents 可选消费。

pi-hindsight 独立安装时，用户仍能直接使用 `retain`、`recall`，而不会得到 mctx Window、compaction 或 subagent orchestration。

### 3.2 pi-mctx 应该如何消费 pi-hindsight

pi-mctx 保留自己的 `recall` facade 还是直接复用 pi-hindsight 的 tool，需要区分两层：

- **Pi tool surface：** 推荐由 pi-hindsight 注册 canonical `retain` / `recall`；pi-mctx 不重复注册同名工具。
- **Search composition：** pi-mctx 在自己的 local lane 完成搜索，再通过 Hindsight service/port 查询 durable lane，并把两者合并为一个可读结果。
- **Projection：** 只有 pi-mctx 能把 recall 结果经过 session/branch/generation/epoch/scope/taint/already-visible admission 后投影到 provider context；pi-hindsight 不应知道这些 mctx 规则。

当 pi-hindsight 未安装、未启用或不可达时，pi-mctx 必须继续提供 local lane、Window、native compaction 和 LKG；durable lane 只标记 unavailable/degraded，不应阻断主流程。

### 3.3 pi-subagents 应该如何消费 pi-hindsight

父 Pi 进程与 child Pi 进程是不同进程，不能依赖父进程的 in-memory service registry 共享 Hindsight client。推荐策略：

1. pi-subagents 的 launch spec 显式记录 child 的 extension selection；
2. 使用者选择是否把 pi-hindsight extension 注入 child；
3. bank id、project identity、agent identity 等非秘密配置通过显式 argv/env/child config 传递；
4. secret 仍由 child 自己从受控配置读取，不能写进 registry 或 RPC payload；
5. child 内的 `retain` / `recall` 由 child 自己的 pi-hindsight 实例执行；
6. 若未来需要父侧代办 durable memory，应新增有明确权限和审计语义的 RPC contract，而不是偷偷复用 `provideService/getService`。

最简单的默认行为是：pi-subagents 不强制要求 pi-hindsight；如果 child 的有效 extension selection 没有 pi-hindsight，child 就没有 `retain` / `recall`，而 spawn 仍正常工作。

## 4. 两种拆分方案比较

### 方案 A：pi-hindsight 作为独立 Pi extension（推荐）

```text
Pi host
 ├─ pi-hindsight: canonical retain/recall + backend
 ├─ pi-mctx: local context + optional Hindsight integration
 └─ pi-subagents: child lifecycle + optional child Hindsight
```

优点：

- 三个包都可单独安装和测试；
- `retain` / `recall` 有唯一 owner，避免重复注册和命名竞争；
- pi-mctx 可在没有 Hindsight 时继续工作；
- pi-subagents 可决定 child 是否安装 memory，而不是隐式继承；
- Hindsight backend 的升级、健康检查、协议错误和 retry 不再污染 mctx 核心。

代价：

- 需要设计一个小的 integration contract；
- 需要处理同一 Pi 进程内的 service discovery 和 registration order；
- 需要迁移现有 `agentmemory*` 配置、outbox、tests、docs；
- 需要明确单独安装 pi-hindsight 时的 bank identity 默认值。

### 方案 B：pi-hindsight 只作为 library/backend package

```text
pi-mctx ──> pi-hindsight library
pi-subagents ──> pi-hindsight library（child 自己加载）
```

优点：

- 没有 extension registration order；
- client 与协议 contract 可以更小；
- pi-mctx 能直接组合 local/durable search。

缺点：

- 无法独立提供 `retain` / `recall` Pi tools；
- pi-subagents 与 pi-mctx 会各自决定 tool、health、config、outbox 行为；
- 容易产生两个 Hindsight integration 实现；
- 独立安装语义变成“安装库但没有用户可见能力”，不符合用户提出的独立模块目标；
- child extension selection 与 backend lifecycle 仍要重复实现。

**判断：** 方案 B 适合作为 pi-hindsight 内部的无 UI client submodule，但不适合作为最终 package boundary。推荐“独立 extension + 内部可导出的 typed port”，而不是 library-only。

## 5. Service、IPC 与进程边界

ext-core 已提供 `createServiceKey`、`provideService`、`getService`、`waitForService`。其实现以 Pi extension runtime 为 registry key，并在资源清理时移除 service；这是同一 Pi runtime 内的生命周期受控对象发现机制。

因此：

- pi-hindsight 可以在当前 Pi runtime 提供 `HindsightMemoryPort`；
- pi-mctx 可以 `waitForService`，等待可选 provider 出现；
- 未安装 provider 时必须有 timeout/AbortSignal 和明确的 unavailable fallback；
- service key 必须是稳定、命名空间化的公共 contract；
- service value 不应暴露 Hindsight client 内部可变状态；
- service cleanup 必须跟随 extension lifecycle。

但 pi-subagents 的 child 是独立 Pi process。父子的 `provideService/getService` registry 不共享，不能传递函数、socket、client 或状态。跨进程必须使用已有 RPC 或显式网络/API boundary。这个区别是拆分设计的关键约束。

证据：`packages/pi-ext-core/src/service.ts`、`packages/pi-ext-core/src/lifecycle.ts`；pi-subagents 的 `runner.ts`、`rpc-adapter.ts` 和 `launch-spec.ts`。

## 6. 推荐的最小公共 contract

不要让 pi-mctx 依赖整个 pi-hindsight package 的内部类型。建议在 pi-hindsight 导出一个小而稳定的 port：

```ts
export interface HindsightMemoryPort {
  retain(input: {
    readonly content: string;
    readonly bank: string;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly id: string; readonly status: "accepted" | "duplicate" }>;

  recall(input: {
    readonly query: string;
    readonly bank: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly HindsightMemoryResult[]>;

  health(input?: { readonly signal?: AbortSignal }): Promise<{
    readonly status: "ok" | "unavailable";
    readonly version?: string;
  }>;
}
```

这是**建议 contract**，不是当前 API。它应满足：

- 不泄露 Hindsight SDK 类型；
- 不携带 Pi session object、数据库连接或 UI 类型；
- 所有网络操作支持取消和有限 timeout；
- retain 的 dedupe identity/operation identity 有明确语义；
- recall result 带来源、稳定 id、content 和必要 metadata，但不携带 projection 决策；
- health 是显式 probe，不应让普通 `/ctx-status` 隐式发网络请求。

同一 Pi 进程中可以通过 ext-core service key 提供此 port。跨进程只传 serializable identity/config，或走已有 RPC；不把 port 本身跨进程传递。

## 7. 配置与兼容风险

### 7.1 当前 `agentmemory*` 命名

当前规格说明 `agentmemory*` 设置键暂时保留为已有用户设置的兼容命名，但底层语义已经是 Hindsight。拆出 pi-hindsight 后有三种选择：

1. 继续读取旧键，并在 pi-hindsight 中标记为 legacy；
2. 新增 `hindsight.*`，启动时迁移旧键；
3. 直接删除旧键。

**建议采用 1 → 2 → 3 的分阶段迁移：**先兼容读取并发出可见 deprecation 状态，再提供显式迁移，最后在有版本边界时删除旧键。不能静默把两个配置源合并，也不能在未安装 pi-hindsight 时继续假装 backend 存在。

### 7.2 工具命名

- `retain` / `recall`：pi-hindsight 的 canonical public names；
- `mctx_memory`：pi-mctx local/native maintenance tool，可继续存在但必须明确它不是 Hindsight retain；
- 不应同时注册两个 `recall` 或两个 `retain`；
- 若用户同时安装多个 memory provider，必须显式拒绝冲突或要求一个明确的 provider selection，不得 silent routing。

### 7.3 Extension registration order

Pi extensions 可能独立被加载，不能假设 pi-hindsight 一定先于 pi-mctx 初始化。pi-mctx 应：

- 注册自身 local tools/hooks；
- 通过 `waitForService` 等待 Hindsight capability；
- 在 provider 缺失时保持 local-only 模式；
- 在 provider 后续出现时仅启用明确的 integration，不重复注册 canonical tools；
- 把启用/降级原因展示在 status/debug surface 中。

## 8. 生命周期、并发与失败语义

### pi-hindsight

- 每个 Pi runtime 一个 client/port；
- HTTP request 支持 AbortSignal、timeout 和协议错误分类；
- outbox worker 在 session shutdown 时停止接收新任务，并有界等待当前投递；
- cleanup 必须幂等；
- retry 必须使用稳定 operation identity，避免重复 retain；
- Hindsight 不可达时 retain 状态只能是 queued/failed，不能报告 delivered；
- health probe 只在显式命令、启动诊断或用户请求时执行。

### pi-mctx

- projection admission、epoch、branch、taint 和 already-visible 过滤仍由 mctx 独占；
- Hindsight recall 失败不应阻断 Window/native compaction/local lane；
- 不把 remote recall 写进 Pi JSONL，也不伪装成 tool call；
- 每次 projection 必须能取消，旧 generation 的结果不能写入新 generation。

### pi-subagents

- spawn 前先持久化 intent，再启动 child；
- child 的 Hindsight 能力是 launch selection 的一部分；
- registry 不存 secret；
- child process 断线时按既有 runner/RPC 规则恢复，不把 Hindsight port 当成可恢复对象；
- child shutdown 时先停止 memory work，再关闭 extension/runtime；
- 父侧不得在 child 没有显式授权时代替 child retain。

## 9. 建议迁移顺序

### Phase 0：冻结并确认 contract

- 为 `HindsightMemoryPort`、service key、bank identity、tool ownership 写 ADR；
- 明确 `mctx_memory` 与 `retain` 的差异；
- 明确 pi-hindsight 缺失时 pi-mctx 的 local-only 行为；
- 明确 child extension selection 与 memory policy。

### Phase 1：在当前 pi-mctx 内先抽出 port

- 把 Hindsight client、协议解码、health、retain/recall request 变成独立模块；
- 把 pi-mctx 对 Hindsight 的依赖改成 port；
- 不改变 package boundary；
- 增加 contract tests 和 fake port tests。

这样可先验证 ownership，而不同时引入安装、发布和跨包迁移风险。

### Phase 2：建立 pi-hindsight package

- 将 Phase 1 的 backend/client、retain tool、recall tool、outbox 和 Hindsight config 移到 `packages/pi-hindsight`；
- 添加唯一 `pi.extensions` entry；
- 导出 typed port 与 service key；
- pi-mctx 先通过 optional peer/integration path 消费它；
- package manifest、build、publish artifact、README、docs/user/packages.md、release validation 一起更新。

### Phase 3：迁移 pi-subagents 的 child contract

- 在 launch config 中加入显式 memory capability/policy，而不是强制依赖 pi-hindsight；
- child extension selection 明确包含或不包含 pi-hindsight；
- 增加独立 child smoke：安装三者、仅安装 mctx、仅安装 subagents、subagents + hindsight；
- 验证断线、resume、shutdown、不同 bank 和权限边界。

### Phase 4：删除 pi-mctx 的 Hindsight backend 残留

在确认所有 caller、配置、resume/fork、docs 和发布包迁移后，删除：

- pi-mctx 内部 Hindsight client/backend implementation；
- 旧 AgentMemory compatibility naming（按已批准的 deprecation window）；
- 重复的 retain/recall registration；
- 只服务旧 bridge 的 tests、commands 和 dead config。

## 10. 需要重点验证的行为

1. 只安装 pi-mctx：Window、compaction、local search、native tools 正常；没有 Hindsight 时不阻断。
2. 只安装 pi-hindsight：`retain`、`recall`、health、retry/dedupe 正常；不出现 mctx Window。
3. 只安装 pi-subagents：spawn、RPC、resume、stop 正常；不假设 memory provider 存在。
4. 三者一起安装：工具无重复注册；local + durable recall merge 正确；projection admission 正确。
5. pi-mctx + pi-hindsight provider 后加载：service wait 可取消，provider 出现后 capability 正确启用。
6. Hindsight timeout/down/invalid response/cancel：local lane 和 child lifecycle 不被拖死，状态可观测。
7. child 有 pi-hindsight：child 自己使用正确 bank/identity；父进程不共享 in-memory service。
8. child 无 pi-hindsight：spawn 仍成功，缺少 `retain` / `recall` 是显式 capability 缺失而不是运行时崩溃。
9. 两个 provider 同时存在：拒绝冲突或依据显式配置选择，不能静默路由。
10. release artifact：每个包独立安装、`pi.extensions` 入口正确、发布文件包含 dist/README/LICENSE、依赖范围和 lockfile 一致。

## 11. 最终建议

用户提出的三段式拆分是合理的，但不应把它实现成三方硬耦合链。最合理的模型是：

```text
                optional same-process service
pi-mctx  <------------------------------------>  pi-hindsight
   ^                                                ^
   | optional child extension / explicit policy      |
   +---------------- pi-subagents ------------------+
                 cross-process RPC/config boundary
```

更准确地说，三者是**独立产品包 + 小型显式 integration contracts**，而不是 `pi-mctx <-> pi-hindsight <-> pi-subagents` 的必需依赖链。pi-hindsight 是 durable-memory owner；pi-mctx 和 pi-subagents 是两个不同的消费者：前者需要 local/durable context composition，后者需要 child capability propagation。

这会得到更小的核心、更清晰的故障边界和更可控的发布：memory backend 可以升级而不拖动 Window；subagent 可以独立使用而不偷偷开启 memory；Pi 用户也可以按需安装三者或任意子集。

## 12. 来源

### 仓库内来源

- `packages/pi-mctx/package.json`
- `packages/pi-mctx/src/tools/ctx-search.ts`
- `packages/pi-mctx/src/tools/memory-save.ts`
- `packages/pi-mctx/src/tools/index.ts`
- `packages/pi-mctx/src/agentmemory/client.ts`
- `packages/pi-mctx/src/agentmemory/runtime.ts`
- `packages/pi-mctx/src/index.ts`
- `docs/mctx/spec.md`
- `packages/pi-subagents/package.json`
- `packages/pi-subagents/README.md`
- `packages/pi-subagents/src/extension.ts`
- `packages/pi-subagents/src/launch-spec.ts`
- `packages/pi-subagents/src/registry.ts`
- `packages/pi-subagents/src/rpc-adapter.ts`
- `packages/pi-subagents/src/runner.ts`
- `packages/pi-ext-core/src/service.ts`
- `packages/pi-ext-core/src/lifecycle.ts`

### 官方外部来源

- Hindsight TypeScript client: <https://hindsight.vectorize.io/sdks/nodejs>
- Hindsight Retain API: <https://hindsight.vectorize.io/developer/api/retain>
- Hindsight Recall API: <https://hindsight.vectorize.io/developer/api/recall>
- Hindsight installation: <https://hindsight.vectorize.io/developer/installation>
