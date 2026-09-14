# pi-mctx 通过 HTTP 接入上游 AgentMemory

`@hheei/pi-mctx` 是 Pi 侧唯一的 AgentMemory bridge。Durable Memory 的 owner 是上游
AgentMemory HTTP 服务，不是 `context.db` 的 `memories` 表，也不是 Docker 部署形态。

## 决策

- 只使用公开 HTTP：`/agentmemory/health`、`/session/start`、`/observe`、`/search`、
  `/remember`、`/session/end`。不读上游 SQLite，不改上游 schema 或 ranking。
- 服务可以是本机进程、反向代理、Tailscale 或任意可达 URL。Docker 不是运行时假设。
- Window（tags / reduce / expand / note / historian compartments）继续走现有 Pi hook。
  Capture 挂在已经注册的 `session_start`、`before_agent_start`、`tool_result`、
  `agent_end`、`session_shutdown` 上，fire-and-forget，失败不影响 transform。
- `agentmemory.enabled` 独立于 Window `enabled`，默认 false。开启后主会话不再注册
  本地 store 版 `mctx_memory`，也不再把 historian facts 写入本地 `memories`。
- AgentMemory 不提供 project setting；`AGENTMEMORY_PROJECT_NAME` 显式环境覆盖优先，否则使用 git root basename，再退回 cwd basename。`agentId` 只用于过滤，不是安全边界。
- Bearer secret 发往非 loopback plaintext HTTP 时默认显式告警；`agentmemoryRequireHttps` 或 `AGENTMEMORY_REQUIRE_HTTPS=1` 使请求 fail closed。
- 自动 recall admission 依照 `docs/mctx/spec.md` 由 `pi-mctx` 的 additive projection epoch / recall ledger 管理；provider-visible splice、projection coordinator 与 LKG publish 仍由后续 Context Projection 阶段定义。
- Agent-facing 工具名固定为 `mctx_search` / `mctx_memory`。启用 AgentMemory 后只切换实现与 schema，不注册 `memory_*` 别名，也不 dual-write 本地 memory。
- `mctx_memory` 先提交到 Pi-owned SQLite transactional outbox，再异步调用 `/remember`；outbox 使用 lease、退避重试、内容 scope dedupe 与超时后的远端 reconciliation。工具在本地提交后只声明 `queued`，除非相同 dedupe row 已确认 `delivered`。
- `/ctx-status` 只读取 runtime 已观察状态和本地 outbox 计数，不为刷新状态发网络请求；`/agentmemory-health` 是唯一显式 fresh probe。
- bridge 初始化以 additive、可重入方式建立 outbox、turn taint、projection epoch / branch lineage、recall event/source/dependency、presentation receipt 与 recovery ref 表；reload/shutdown 取消 capture、等待有界 outbox drain，并结束 live remote sessions。
## 不做

- 不把 omp-mctx 的 capture 类、pending observation map 或 projection coordinator 搬进 hepi；recall ledger 只迁移与 Pi admission 契约直接相关的领域逻辑。
- 不 dual-write 本地 `memories` 与上游。
- 不在 `pi-ext-core` 增加 AgentMemory 能力。
