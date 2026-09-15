# @hheei/pi-mctx

`@hheei/pi-mctx` is the single Magic Context package for HEPI. Its Pi adapter
lives in `src/`; shared Magic Context implementation lives in `src/core/` and
is private to this package through `#core/*` imports.

Pi adapter 通过 `src/index.ts` 直接加载。Magic Context Window 继续由 Pi hooks 和
本地 `context.db` 管理；可选 AgentMemory HTTP bridge 负责跨会话 durable memory。
启用 bridge 后，agent-facing 工具名仍为 `mctx_search` / `mctx_memory`：search 将
local session lane 与 AgentMemory lane 分开显示，memory write 先提交本地
transactional outbox，再异步投递。`/ctx-status` 读取已观察的 bridge 状态与本地
outbox 计数，不触发网络；`/agentmemory-health` 才执行显式 fresh probe。
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

Pi MCTX owns its persistence. Runtime settings are stored in Pi's global
`settings.json` under `pi-mctx`; the database is stored under
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/../pi-mctx/` (default `~/.pi/pi-mctx/`).
It does not read, write, migrate, or merge the upstream CortexKit
`magic-context.jsonc` files or `~/.local/share/cortexkit/magic-context/`.

## AgentMemory 配置与验收

在 Pi 全局 `settings.json` 的 `pi-mctx` 下使用扁平配置键（不是嵌套的 `agentmemory` 对象），修改后 `/reload`：

```json
{
  "pi-mctx": {
    "agentmemoryEnabled": true,
    "agentmemoryUrl": "http://127.0.0.1:3111",
    "agentmemoryCapture": true,
    "agentmemoryInject": true,
    "agentmemoryMemoryTools": true,
    "agentmemoryHistorianRetrieval": false
  }
}
```

服务必须实现 AgentMemory HTTP 协议；以上 URL 只是本机配置示例，不会自动启动服务。
`agentmemorySecret` 配置 bearer secret，`agentmemoryRequireHttps` 要求安全传输；不要把真实 secret 提交到仓库。
`agentmemoryAgentId` 仅用于过滤。Project identity 依次取 `AGENTMEMORY_PROJECT_NAME`、git root basename、cwd basename，不支持 project setting。
AgentMemory 默认关闭，开关独立于 Window 的 `enabled` 与 `compactionEnabled`。

`/ctx-status` 只读取已观察状态；`/agentmemory-health` 显式探测服务，bridge 关闭时直接报告 disabled，不发起模型请求。
本地协议 smoke 使用真实 Pi SDK 和隔离数据库，连接 loopback HTTP fixture，不使用用户凭据或真实模型：

```bash
pnpm --filter @hheei/pi-mctx exec node --no-warnings --import jiti/register scripts/agentmemory-live-smoke.ts
```

该 smoke 验证 Pi 接入和 HTTP 协议闭环，不替代部署中的 AgentMemory 服务验收或真实 provider 请求验证。
