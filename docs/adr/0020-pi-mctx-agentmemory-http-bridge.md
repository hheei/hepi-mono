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
- 自动 recall 的 Context Projection / ledger / SQLite outbox 不在本 ADR 范围。
  显式写入走同名 `mctx_memory`（AgentMemory schema）的同步 `remember`；失败对工具可见，不静默落本地库。

## 不做

- 不把 omp-mctx 的 capture 类、pending observation map、taint store、recall ledger
  或 projection coordinator 搬进 hepi。
- 不 dual-write 本地 `memories` 与上游。
- 不在 `pi-ext-core` 增加 AgentMemory 能力。
