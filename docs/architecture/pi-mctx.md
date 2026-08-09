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
- `src/core/**` owns Pi 使用的 shared storage、compaction、memory、search、Dreamer 與 pure transformations。
- `src/context-handler.ts` 與 `src/auto-search-pi.ts` 是 Pi 唯一的 transform 與 auto-search 執行入口。已移除的 generic transform/Rust pipeline 不可由 adapter、動態載入或設定重新啟用；Pi 保留的 core helper 必須有 adapter 的直接 consumer。
- core is private implementation. Other workspace packages must not import it.
- `xpi-mctx` remains excluded: it is a historical archive, not part of active implementation.
- OpenCode backend is not retained: no OpenCode DB access、config/RPC integration、legacy migration、plugin context, or cross-harness fallback remains under this package.

Pi raw-session data is supplied only by the adapter's `RawMessageProvider`; core fails closed when no provider is installed. Shared storage is Pi-owned and has no import or migration path from a legacy OpenCode database. Legacy subagent-invocation rows retain their invocation IDs and token totals, but the retired cross-host `harness` telemetry column is removed by a transactional table rebuild; callers no longer write or read a host origin for those rows.

## 儲存版本邊界

Pi MCTX 只支援新建資料庫。啟動時會建立完整的最新 SQLite schema，不保留歷史 schema 升級、資料修復或跨版本相容程式。

已有的舊 `context.db` 不會被自動升級、重用或刪除；使用者必須先明確移除它，再讓 Pi 建立新資料庫。這避免舊資料在未確認遷移的情況下被靜默改寫。新資料庫開啟失敗仍 fail-closed，不會回退到記憶體資料庫。

## 模組解析與啟用條件

Adapter source imports shared code through private `#core/*` specifiers. The package `imports` map resolves those specifiers to `src/core/**` under Bun. No public subpath export is added for core.

This is an inactive, private upstream baseline. It declares no `pi.extensions` entry, has no build or publish script, and root formatter/typecheck/test deliberately exclude `packages/pi-mctx/**`. The copied core references missing upstream companion modules and targets a different Pi API, so enabling it before an adapted slice would conceal failures rather than create a working extension.

Before enabling any slice, remove the root exclusions, add only its needed source dependencies, implement its Pi adapter boundary, and make its focused test/typecheck pass. The package becomes loadable only when `pi.extensions` declares a verified extension entry. The completion check for this baseline is `rg -i opencode packages/pi-mctx` returning no matches.

## 合併與驗證

1. Move `xmagic-context/src/**` to `pi-mctx/src/core/**` and its tests to `pi-mctx/test/core/**`; rewrite test paths only where the added `core` directory changes resolution.
2. Rewrite former `@magic-context/core/*` adapter/test imports to `#core/*`.
3. Remove the `xmagic-context` workspace directory and manifest.
4. Keep the inactive combined baseline out of root validation until its first Pi-adapted slice has a passing focused test and typecheck.
