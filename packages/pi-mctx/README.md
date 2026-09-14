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

The previous implementation remains excluded at `packages/xpi-mctx/` for
historical comparison.

Pi MCTX owns its persistence. Runtime settings are stored in Pi's global
`settings.json` under `pi-mctx`; the database is stored under
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/../pi-mctx/` (default `~/.pi/pi-mctx/`).
It does not read, write, migrate, or merge the upstream CortexKit
`magic-context.jsonc` files or `~/.local/share/cortexkit/magic-context/`.
