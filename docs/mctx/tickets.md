# pi-mctx Hindsight backend migration tickets

本 backlog 的目标是移除旧 AgentMemory backend，改用官方 Hindsight client/API；上层 Pi lifecycle、outbox、recall ledger 和 Context Projection 保持不变。

状态：`[ ]` 未开始，`[~]` 进行中，`[x]` 完成，`[-]` 明确不做。

## HCTX-01：Hindsight client port

**目标**：将内部 client port 的实现替换为 `@vectorize-io/hindsight-client`。

**范围**：

- `retain` 承载 capture 与 explicit memory；`recall` 承载 search；`/version` 承载 health。
- 删除旧 `/agentmemory/*` endpoint、远程 session lifecycle 和旧 response envelope 假设。
- 保留 timeout、AbortSignal、HTTP/network/invalid-response 错误分类。

**状态**：[x]

## HCTX-02：配置、身份与文档

**目标**：将现有 `agentmemory*` 用户设置解释为 Hindsight backend 设置，project identity 映射为 bank id。

**范围**：

- 默认地址改为 Hindsight API `http://127.0.0.1:8888`。
- 更新 README、architecture、spec、ADR 和 smoke fixture。
- 记录 Hindsight Cloud/self-hosted 部署前提，不把 Hindsight server 打包进 Pi。

**状态**：[~]

## HCTX-03：行为验证与旧 backend 清理

**目标**：确认所有运行路径只使用 Hindsight，并移除旧协议测试/文案。

**验收**：

- 搜索源码不再出现旧 `/agentmemory/*` runtime endpoint。
- focused tests 覆盖 Hindsight retain/recall/version、失败、取消和 outbox retry。
- focused typecheck、Biome 与 pi-mctx smoke 通过。

**状态**：[~]

## HCTX-04：projection 与显式 reflect 边界

**目标**：保持 Hindsight recall 经过 Pi-owned admission/projection；不把 reflect 隐式加入 historian 或 provider transform。

**验收**：

- stale、tainted、out-of-scope、already-visible recall 不能进入 provider-visible projection。
- branch/reload/replay 下 admission 幂等。
- reflect 只通过明确的用户/工具路径触发。

**状态**：[x]

## 不在范围内

- 不嵌入 Hindsight server、PostgreSQL、fact extraction、ranking 或 consolidation。
- 不保留旧 AgentMemory HTTP 协议作为第二 backend 或 fallback。
- 不把 recall 写入 Pi JSONL 或伪装成 tool call。
- 不在 `pi-ext-core` 增加 Hindsight-specific capability。

参考官方文档：[TypeScript client](https://hindsight.vectorize.io/sdks/nodejs)、[Retain](https://hindsight.vectorize.io/developer/api/retain)、[Recall](https://hindsight.vectorize.io/developer/api/recall)、[Installation](https://hindsight.vectorize.io/developer/installation)。
