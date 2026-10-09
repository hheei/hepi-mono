# Documentation

This directory records high-level information for users and developers. Detailed implementation and TypeScript API usage belong in concise comments beside the relevant code.

## User Guides

- [Getting started](user/getting-started.md): published installation, local builds, and explicit extension loading.
- [Package catalogue](user/packages.md): current HEPI packages and prerequisites.
- Package READMEs under `packages/*/README.md`: installation and compatibility by package.

## Development

- [Extension development](development/extension-development.md): feature workflow, package conventions, and focused verification.
- [Local Pi development](development/pi-dev.md): incrementally build and load a fixed local extension set while retaining the default Pi profile.
- [pi-ext-core development](development/pi-ext-core.md): ext-core and consumer-specific development rules.
- [HEPI TUI design](../DESIGN.md): required specification for UI and UX work.

## Architecture

- [Extension reference architecture](architecture/extension-reference.md): target package layout, public API, lifecycle, concurrency, and test boundaries.
- [Loadout architecture](architecture/loadout.md): tool registration, activation policy, Settings host, and Extension page router boundaries.
- [Subagent execution architecture](architecture/subagents.md): completion, task, conversation, delivery, and concurrency boundaries.
- [Subagent extension architecture](architecture/pi-subagents.md): independent reconnectable subagent child sessions and host workspace targeting.
- [Observational memory architecture](architecture/ext-memory.md): tiered observations, reflections, and instant compaction.
- [Unified grep architecture](architecture/grep.md): FFF/rg admission, canonical match contract, compact rendering, and Output recovery.
- [Apply Patch result architecture](architecture/apply-patch.md): V4A outcome, jsdiff diagnostics, model recovery, stable diff, and Trace rendering.
- [pi-optimizer](optimizer/README.md): T2S、Caveman/Ponytail 提示词、可选 RTK 与统一设置入口。

## Research

- [Gemini Responses thinking 显示调查](research/gemini-responses-thinking.md)：medium 请求、流解析、签名载体与跨 provider 历史转换的证据及待确认问题。
- [Gemini 与 OpenAI 系统指令及缓存](research/gemini-system-messages-and-cache.md)：官方 API 的指令角色差异、动态工具追加、Gemini 缓存方案与 Interactions API 限制。
- [Pi Durable 调研](research/pi-durable.md)：持久执行底座、TUI／功能分离边界与渐进迁移风险。
- [Pi native tools, rendering, and extensions](pi-native-tools.md): installed Pi location, tool lifecycle, TUI rendering, extension boundaries, and native grep/find behavior.
- [FFF search research](pi-fff.md): FFF SDK data model, precise match ranges, lifecycle, pagination, and Pi integration boundaries.
- [Original Pi theme analysis](research/pi-original-theme.md): research used to derive the HEPI TUI design.

Research records evidence for current code and design. It does not override source, tests, package READMEs, or specifications.

## Plans

[`plans/`](plans/README.md) contains current implementation plans and safety constraints.

## Source Of Truth

Use each source for the question it owns:

- Current implementation and observed behavior: source code and focused tests.
- Required UI/UX behavior: [DESIGN.md](../DESIGN.md).
- Repository engineering rules: [AGENTS.md](../AGENTS.md) and [DESIGN_TS.md](../DESIGN_TS.md).
- Installation and compatibility: package manifests and package READMEs.
- Intended boundaries and agreed decisions: current architecture guides, specifications, and ADRs.
- Background evidence: current research documents.

When implementation and a required contract disagree, record the discrepancy and
resolve it explicitly. Existing code does not automatically override an agreed specification.
