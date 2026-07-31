# Advisor Core Conversation 实施计划

## 目标

将 Advisor 的 child execution 从 feature-owned `Agent` lifecycle 迁至 `@hheei/pi-ext-core` 的
`conversation` handle，同时保留 Advisor 的 evidence、节流、重确认、反馈、context budget 与 usage 行为。

## 固定边界

- Advisor factory 解析 model、system prompt、read-only tools 与 bootstrap policy，并创建 `AgentSession`。
- core 独占 session 的 prompt、cancel、dispose、terminalization、compact mutation 与 usage normalization。
- Advisor 不读取 raw session、不改 child messages；它只在 idle 时按原 threshold 调用 `compact()`，并读取
  `usage()` snapshot。
- review 输出为严格 JSON text；JSON schema validation 在 Advisor boundary，`advise` tool 不保留。

## 实施顺序

1. 在 core 定义 `ConversationUsage`、`ConversationSubagentHandle.compact()`、`usage()`，实现 idle gate、abort、
   child disposal 与 terminal snapshot retention。
2. 为 core 添加 focused tests：usage normalization、idle-only compact、queued/running/terminal reject、compact
   failure、lifecycle abort 与 retained terminal snapshot。
3. 将 Advisor extension 改为真实 `registerExtensionLifecycle` consumer；同 lifecycle 配置 shared active-turn cap。
4. 以 `createAgentSession` 构造 `ResolvedChildSessionFactory`，将 Advisor runtime 改为 conversation handle adapter；
   保留 evidence/cooldown/reconfirm/feedback code。
5. 将 review contract 改为严格 JSON text，更新 runtime fixtures；不得删除既有 context、usage、timeout、replay
   与 compaction tests 来获得通过。
6. 运行 core 和 Advisor focused tests、Biome、实际 Pi host/replay smoke verification；完成后独立提交。

## 测试 seam

Pi 的公开 `createAgentSession` 不接受旧 `Agent` 测试使用的 `streamFn` transport override。第一 slice 因此在
Advisor adapter 加入仅供测试注入的 `ResolvedChildSessionFactory`：生产路径仍保留 legacy `Agent` 与 `streamSimple`，
测试路径提供受控 fake `AgentSession`。不得改写 `session.agent` 或任何未公开 Pi 字段。fixture 必须保留原有 context、
usage、timeout、replay 与 compaction assertions，而不是以删除测试替代迁移。

## 不做

本计划不拆 `pi-advisor` package、不提取 settings API、不新增 generic session inspection、telemetry、scheduler 或
跨 extension RPC。
