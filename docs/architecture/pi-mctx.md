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

Pi raw-session data is supplied only by the adapter's `RawMessageProvider`; core fails closed when no provider is installed. Shared storage is Pi-owned and has no import or migration path from a legacy OpenCode database. Legacy subagent-invocation rows retain their invocation IDs and token totals, but the retired cross-host `harness` telemetry column is removed by a transactional table rebuild; callers no longer write or read a host origin for those rows.

## 儲存版本邊界

Pi MCTX 只支持新建数据库。启动时会建立完整的最新 SQLite schema，不保留历史 schema 升级、数据修复或跨版本兼容程序。

已有的旧 `context.db` 不会被自动升级、重用或删除；用户必须先明确移除它，再让 Pi 建立新数据库。这避免旧数据在未确认迁移的情况下被静默改写。新数据库开启失败仍 fail-closed，不会回退到内存数据库。

最新 schema 不包含已退役的 v22 identity rekey 映射；workspace 只按当前成员身份解析。

## 模組解析與啟用條件

Adapter source imports shared code through private `#core/*` specifiers. The package `imports` map resolves those specifiers to `src/core/**` under Bun. No public subpath export is added for core.

This is an inactive, private upstream baseline. It declares no `pi.extensions` entry, has no build or publish script, and root formatter/typecheck/test deliberately exclude `packages/pi-mctx/**`. The copied core references missing upstream companion modules and targets a different Pi API, so enabling it before an adapted slice would conceal failures rather than create a working extension.

Before enabling any slice, remove the root exclusions, add only its needed source dependencies, implement its Pi adapter boundary, and make its focused test/typecheck pass. The package becomes loadable only when `pi.extensions` declares a verified extension entry. The completion check for this baseline is `rg -i opencode packages/pi-mctx` returning no matches.

## 合併與驗證

1. Move `xmagic-context/src/**` to `pi-mctx/src/core/**` and its tests to `pi-mctx/test/core/**`; rewrite test paths only where the added `core` directory changes resolution.
2. Rewrite former `@magic-context/core/*` adapter/test imports to `#core/*`.
3. Remove the `xmagic-context` workspace directory and manifest.
4. Keep the inactive combined baseline out of root validation until its first Pi-adapted slice has a passing focused test and typecheck.
