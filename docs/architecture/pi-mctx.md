# pi-mctx

## 目標

`@hheei/pi-mctx` 是唯一的 Magic Context Pi package。它提供 Pi host extension adapter，並在同一個 package 內保留共享的 Magic Context implementation。`@hheei/xmagic-context` 不作為 workspace package、不可安裝、不可被其他 package 依賴。

## 邊界與資料流

```text
Pi host
  -> pi-mctx adapter (src/*.ts, src/commands/**, src/tools/**)
  -> private core (src/core/**)
  -> session storage / Pi APIs / configured external services
```

- adapter owns Pi hooks、commands、tools、surface registration、Pi session lifecycle，以及 `RawMessageProvider` registration。
- `src/core/**` owns Pi 使用的 shared storage、compaction、memory、search、Dreamer 與 pure transformations；`src/core/hooks/inject-compartments.ts` 是明確的 Pi-aware exception，集中 m[0]/m[1] injection、Pi message splice 與共享 memory render，避免 adapter wrapper 與 legacy injector 平行演進。
- Embedding provider state is project-scoped in `project-embedding-registry`; adapter search callers pass `embedQuery` and availability explicitly. Core search never creates an ambient provider or silently chooses a model.
- core is private implementation. Other workspace packages must not import it.
- `xpi-mctx` remains excluded: it is a historical archive, not part of active implementation.
- OpenCode backend is not retained: no OpenCode DB access、config/RPC integration、legacy migration、plugin context, or cross-harness fallback remains under this package.
- Pi MCTX 不拥有 Todo：不注册、观察或重放 `todowrite`，不提供 `/todos` 或 overlay，也不在数据库保存 Todo snapshot。独立 `pi-todo` package 是唯一的 Todo tool/UI owner；其工具 transcript 按普通 Pi tool 内容处理。
- Pi MCTX 自动模型提醒使用 Pi `custom` session message：模型内容保留 `<system-reminder>…</system-reminder>`，交互 transcript 通过 `registerMessageRenderer` 显示 `[magic context]` 块。Channel 1 的 gentle/firm 级别保持模型可见但不显示；仅 urgent 级别显示该块，Channel 2 始终显示。不得向 `toolResult.content` 挂载自动提醒。仅 `pi.on("context")` 的临时 message 变换可在当前 provider 请求中注入内容；该数组不写入 session，也没有 transcript 表示。

Pi raw-session data is supplied only by the adapter's `RawMessageProvider`; core fails closed when no provider is installed. Shared storage is Pi-owned and has no import or migration path from a legacy OpenCode database. Legacy subagent-invocation rows retain their invocation IDs and token totals, but the retired cross-host `harness` telemetry column is removed by a transactional table rebuild; callers no longer write or read a host origin for those rows.

## 设置

Pi MCTX 通过 `@hheei/pi-ext-core` 向 `/ext-settings` 注册唯一 provider：`pi-mctx`。设置仅写入 Pi 全局 `settings.json` 的直接 `pi-mctx.<field>` 键；不读取项目级 `.pi/settings.json`，也不读取、导入或迁移 CortexKit 的 JSONC 配置。

```json
{
  "pi-mctx": {
    "enabled": true,
    "compactionEnabled": true,
    "systemPromptInjection": true,
    "temporalAwareness": true,
    "memoryEnabled": true,
    "memoryInjectionBudgetTokens": 4000,
    "memoryAutoPromote": true,
    "memoryRetrievalPromotionThreshold": 3,
    "memoryAutoSearchEnabled": true,
    "memoryAutoSearchScoreThreshold": 0.6,
    "memoryAutoSearchMinPromptChars": 20,
    "memoryGitCommitIndexingEnabled": false,
    "memoryGitCommitSinceDays": 365,
    "memoryGitCommitMaxCommits": 2000,
    "historianEnabled": true,
    "historianModel": "github-copilot/gpt-5.4",
    "historianTwoPass": false,
    "historianTimeoutMs": 300000,
    "historyBudgetPercentage": 0.15,
    "commitClusterTriggerEnabled": true,
    "commitClusterMinClusters": 3,
    "dreamerEnabled": false,
    "dreamerModel": "github-copilot/gpt-5.4",
    "dreamerInjectDocs": true,
    "sidekickModel": "github-copilot/gpt-5.4",
    "embeddingProvider": "local",
    "embeddingModel": "Xenova/all-MiniLM-L6-v2",
    "embeddingEndpoint": "",
    "embeddingApiKeyEnv": ""
  }
}
```

这些是可编辑的运行设置：扩展/compaction/prompt/时间开关、memory 检索与 Git 索引、Historian 生命周期、模型和预算，以及 Dreamer 开关、模型与文档注入、sidekick 模型和 embedding 配置。embedding 支持 `local`、`off` 和 `openai-compatible`：remote 模式需要 model、endpoint；`embeddingApiKeyEnv` 保存环境变量名，不保存 API key，空值表示不发送凭据。Dreamer 启用时使用 schema 的 canonical task schedules；单任务 cron、fallback、thinking、Synapse embedding 的 fallback-provider 合约、remote provider 的请求格式高级项、agent overrides、项目覆盖以及安全/调试项不进入通用设置，继续使用 schema 默认值。保存通过 ext-core 的原子 JSON 更新完成，保留其他 extension section。运行时只在启动或 `/reload` 时读取设置；已运行 session 不做部分热更新。`enabled=false` 仍注册设置 provider，以便用户在 `/ext-settings` 中重新启用扩展。手工写入的无效值仅回退该字段的 schema 默认值，不会使整个配置失效。

## 存储版本边界

Pi MCTX 的持久化数据位于 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/extensions/pi-mctx/`；默认数据库为 `context.db`。此目录与旧的 `~/.local/share/cortexkit/magic-context/context.db` 隔离，Pi MCTX 不会读取、升级或删除后者。

最新 schema 不包含已退役的 v22 identity rekey 映射；workspace 只按当前成员身份解析。


Adapter source imports shared code through private `#core/*` specifiers. The package `imports` map resolves those specifiers to `src/core/**` under Bun. No public subpath export is added for core.

`pi-mctx` is a private source extension. Development loads it through an explicit source path such as `scripts/pi-dev`; it is not published through a package `pi.extensions` entry. The package remains excluded from repository-wide Biome/typecheck/test commands while its upstream-derived surface is adapted; its focused Pi suite and focused root typecheck are the current gate. Remove these exclusions once the package passes the repository root gates.

The completion check is `rg -i opencode packages/pi-mctx` returning no matches.

## 验证

Run the focused Pi MCTX suite and root typecheck after changes. Settings changes also require a Pi reload or restart before runtime behavior changes.
