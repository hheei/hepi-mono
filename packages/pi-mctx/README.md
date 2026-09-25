# @hheei/pi-mctx

> [!WARNING]
> **DEPRECATED**: `@hheei/pi-mctx` 已弃用，不再维护，并已从 `pi-dev` 默认加载组合中移除。代码保留仅供历史对比与迁移参考。

`@hheei/pi-mctx` is the single Magic Context package for HEPI. Its Pi adapter
lives in `src/`; shared Magic Context implementation lives in `src/core/` and
is private to this package through `#core/*` imports.

公开包的 Pi 扩展入口是 `src/index.ts`，随包分发源码并由 Pi 的 TypeScript 加载器加载；
子代理的精简入口 `src/subagent-entry.ts` 同时随包分发。Magic Context Window 继续由 Pi hooks 和
本地 `context.db` 管理；可选 Hindsight HTTP backend 负责跨会话 durable memory。
启用 backend 后，agent-facing 工具名仍为 `mctx_search` / `mctx_memory`：search 将
local session lane 与 Hindsight lane 分开显示，memory write 先提交本地 transactional outbox，再异步投递。
`/ctx-status` 读取已观察的 backend 状态与本地 outbox 计数，不触发网络；`/agentmemory-health` 才执行显式
fresh probe。
Automatic recall admission is recorded in an additive Pi-owned ledger keyed by
session, branch generation, projection epoch, and real user-entry ID. Repeated
transforms replay the same immutable snapshot; stale, tainted, out-of-scope, and
already-visible results are rejected before commit. Admission does not write Pi
session JSONL or alter provider-visible context until the Context Projection
stage publishes it.

Interactive TUI recall is presented through an ext-core-managed `aboveEditor`
widget. Each admitted event is claimed with a short lease and receives a durable
presentation receipt only after the widget update succeeds; headless and RPC
runs never mount the widget. `/ctx-status` exposes at most three recent admitted
recall sources as sanitized, bounded previews and performs no network request.

The previous implementation remains excluded at `packages/xpi-mctx/` for
historical comparison.

Pi MCTX owns its persistence. Runtime settings are stored in global
`ext_settings.json` under the registered `operational` group; the database is stored under
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/../pi-mctx/` (default `~/.pi/pi-mctx/`).
It does not read, write, migrate, or merge Pi's native `settings.json`, the upstream CortexKit
`magic-context.jsonc` files, or `~/.local/share/cortexkit/magic-context/`.

## Hindsight 配置与验收

在全局 `<agentDir>/ext_settings.json` 的 `operational` group 中使用扁平配置键（不是嵌套的
`agentmemory` 对象），修改后 `/reload`：

```json
{
  "operational": {
    "agentmemoryEnabled": true,
    "agentmemoryUrl": "http://127.0.0.1:8888",
    "agentmemoryCapture": true,
    "agentmemoryInject": true,
    "agentmemoryMemoryTools": true,
    "agentmemoryHistorianRetrieval": false
  }
}
```

这些兼容字段现在连接 Hindsight API，而不再连接旧的 `/agentmemory/*` 协议。默认服务端是
Hindsight `http://127.0.0.1:8888`；也可以使用 Hindsight Cloud 或 self-hosted URL。
`agentmemorySecret` 作为 Hindsight API key，`agentmemoryRequireHttps` 要求安全传输；不要把真实
secret 提交到仓库。project identity 映射为 Hindsight bank id，`agentmemoryAgentId` 仅用于 tags。

Hindsight backend 的基本映射是：capture/remember → `retain`，automatic search → `recall`，health →
`/version`；没有远程 session start/end，session identity 通过 retain metadata/tags 保留。
参考官方 [TypeScript client](https://hindsight.vectorize.io/sdks/nodejs)、[retain](https://hindsight.vectorize.io/developer/api/retain)
和 [recall](https://hindsight.vectorize.io/developer/api/recall) 文档。

AgentMemory 默认关闭，开关独立于 Window 的 `enabled` 与 `compactionEnabled`。

`/ctx-status` 只读取已观察状态；`/agentmemory-health` 显式探测 Hindsight 服务，backend 关闭时直接报告 disabled。
本地协议 smoke 使用真实 Pi SDK 和隔离数据库，连接 loopback HTTP fixture，不使用用户凭据或真实模型：

```bash
pnpm --filter @hheei/pi-mctx exec node --no-warnings --import jiti/register scripts/agentmemory-live-smoke.ts
```

该 smoke 验证 Pi 接入和 Hindsight 兼容端口闭环，不替代部署中的 Hindsight 服务验收或真实 provider 请求验证。
