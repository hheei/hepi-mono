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
- [Native bridge architecture](architecture/pi-ext-bridge.md): N-API boundary, vendored mpatch, native PTY sessions, and cancellation/cleanup ownership.
- [Loadout architecture](architecture/loadout.md): tool registration, activation policy, Settings host, and Extension page router boundaries.
- [Subagent execution architecture](architecture/subagents.md): completion, task, conversation, delivery, and concurrency boundaries.
- [Unified grep architecture](architecture/grep.md): FFF/rg admission, canonical match contract, compact rendering, and Output recovery.
- [Apply Patch result architecture](architecture/apply-patch.md): V4A outcome, mpatch diagnostics, model recovery, stable diff, and Trace rendering.
- [pi-t2s](t2s/README.md): Traditional-to-Simplified input conversion, settings migration, and lifecycle boundary.

## Feature Specifications

- [pi-mctx AgentMemory 与 Context Projection 迁移规格](mctx/spec.md)：目标边界、数据流、公共契约、失败语义与完成定义。
- [pi-mctx 迁移 tickets](mctx/tickets.md)：按依赖顺序可独立提交和验收的实施 backlog。

## Research

- [Advisor research](research/advisor.md): advisor design comparison and original feature boundary.
- [Pi upstream research](research/pi-upstream.md): upstream extension layering and the historical aggregate proposal.
- [Pi native tools, rendering, and extensions](pi-native-tools.md): installed Pi location, tool lifecycle, TUI rendering, extension boundaries, and native grep/find behavior.
- [FFF search research](pi-fff.md): FFF SDK data model, precise match ranges, lifecycle, pagination, and Pi integration boundaries.
- [Apply Patch model-information research](research/apply-patch-model-information.md): mpatch diagnostic evidence and V4A model-information design inputs.
- [Original Pi theme analysis](research/pi-original-theme.md): research used to derive the HEPI TUI design.
- [BTW implementation research](research/btw/implementation-research.md): comparison of four public BTW implementations.
- [BTW reuse inventory](research/btw/reuse-inventory.md): code reuse decisions made before implementation.

Research records evidence and prior reasoning. It does not override current code, tests, package READMEs, or design specifications.

## Plans

[`plans/`](plans/README.md) contains completed plans and durable historical decisions. Plans are context, not current behavior contracts.

## Source Of Truth

Use each source for the question it owns:

- Current implementation and observed behavior: source code and focused tests.
- Required UI/UX behavior: [DESIGN.md](../DESIGN.md).
- Repository engineering rules: [AGENTS.md](../AGENTS.md) and [DESIGN_TS.md](../DESIGN_TS.md).
- Installation and compatibility: package manifests and package READMEs.
- Intended boundaries and agreed decisions: current architecture guides, specifications, and ADRs; check their status before treating a target design as implemented.
- Background evidence: research and historical plans, not current behavior contracts.

When implementation and a required contract disagree, record the discrepancy and
resolve it explicitly. Existing code does not automatically override an agreed specification.
