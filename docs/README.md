# Documentation

This directory records high-level information for users and developers. Detailed implementation and
TypeScript API usage belong in concise comments beside the relevant code.

Start with the section that matches your question, not with the whole tree.

## User Guides

- [Getting started](user/getting-started.md): published installation, local builds, and explicit extension loading.
- [Package catalogue](user/packages.md): current Pi packages and prerequisites.
- Package READMEs under `packages/*/README.md`: installation and compatibility by package.

## Development

- [Extension development](development/extension-development.md): feature workflow, package conventions, and focused verification.
- [Local Pi development](development/pi-dev.md): incrementally build and load a fixed local extension set while retaining the default Pi profile.
- [pi-ext-core development](development/pi-ext-core.md): ext-core and consumer-specific development rules.
- [Advisor core conversation](development/advisor-core-conversation.md): implementation record for the advisor conversation path.
- [Pi TUI design](../DESIGN.md): required specification for UI and UX work.

## Architecture

Package and lifecycle boundaries:

- [Extension reference architecture](architecture/extension-reference.md): target package layout, public API, lifecycle, concurrency, and test boundaries.
- [Tool packages](architecture/tool-packages.md): how the tool extensions split into separate packages.
- [Tool Search ownership](architecture/tool-search.md): which package owns discovery and deferred activation.
- [pi-ext-core](architecture/pi-ext-core.md): ext-core's proposal, public API, and concurrency rules.
- [Loadout architecture](architecture/pi-loadout.md): tool registration, activation policy, Settings host, and Extension page router boundaries.
- [Loadout retirement](architecture/loadout.md): what the native mechanism replaced.
- [Background task contracts](architecture/background-tasks.md): `bg_bash_*` / `agents_*` ownership, deferred discovery, and BackgroundDelivery batching.
- [Test runtime](architecture/testing.md): default vs integration entry points and deterministic vs bounded readiness coordination.

Tools and their execution:

- [Bash execution recovery](architecture/bash-execution-recovery.md): session ledger, read-only recovery to `unknown`, branch receipts, and fork isolation.
- [Unified grep architecture](architecture/grep.md): canonical ripgrep match contract, compact rendering, and Output recovery.
- [Search tools](tools/search.md): the unified file and content search surface.
- [File tools](ext-tools/README.md): file tool behaviour and the independent tool packages.
- [Web access](../packages/pi-web-access/README.md): web search, URL/PDF/GitHub extraction, tool names and exposure, and the `webSearch` config section.
- [Apply Patch result architecture](architecture/apply-patch.md): V4A outcome, jsdiff diagnostics, model recovery, stable diff, and Trace rendering.
- [Python Eval](architecture/eval.md): the interactive kernel and its execution facts ledger.

Rendering and UI:

- [Collapsible tool rendering](architecture/collapsible-tool-rendering.md): the deep-module design behind tool collapse, geometry, and semantic copy.
- [Continuous activity groups](architecture/pi-ext-ui-tool-groups.md): the implemented three-way grouping, read-only tail row, and cross-block turn timing.
- [File tool rendering and diff](architecture/file-tool-rendering-and-diff.md): standalone and nested presentation of file tools.
- [Render throttling](architecture/render-throttling.md): repaint budget and flush rules.
- [TUI host](architecture/tui.md): the terminal host contract extensions render into.
- [Memory and performance](architecture/memory-and-performance-optimization.md): the memory governance and lightweighting specification.

Memory:

- [Observational memory](architecture/ext-memory.md): tiered observations, reflections, and instant compaction.
- [Hindsight MCP](architecture/hindsight-mcp.md): the native MCP integration for long-term memory.

Subagents:

- [Subagent extension architecture](architecture/pi-subagents.md): independent reconnectable child sessions, host workspace targeting, and the sqlite ledger.
- [Removed in-process subagent coordinator](architecture/subagents.md): why `startSubagent` is gone and where its work lives now.

Pi internals (reference, not contract):

- [Pi extension APIs](architecture/pi-extension-apis.md): the `@earendil-works/pi-coding-agent` SDK surface, events, session model, and model registry.
- [Pi agent loop](architecture/pi-agent-loop.md): the layered execution pipeline behind a turn.
- [Pi native tools](pi-native-tools.md): installed Pi location, tool lifecycle, TUI rendering, and native grep/find behaviour.

## Specifications

Behaviour that must hold, per package:

- `pi-subagents`:
  - [Runtime contract](pi-subagents/spec.md): identity, ownership, data flow, tools, persistence, mailbox protocol, lifecycle, host contract, failure semantics.
  - [Scope and roadmap](pi-subagents/roadmap.md): user goals, explicit non-goals, definition of done, and implementation order.
  - [Unified Agents API spec](pi-subagents/unified-api-spec.md) with [plan](pi-subagents/unified-api-plan.md), [review](pi-subagents/unified-api-review.md), and [tickets](pi-subagents/unified-api-tickets.md).
  - [MCP and Codex Desktop UI](pi-subagents/mcp.md): inline task cards, dashboard, delegation receipts, and transport integration.
- [Response telemetry](status/response-telemetry.md): what the status line reports.
- [Settings](settings/README.md): the extension settings surface.
- [Todo](todo/README.md): todo state and its UI.
- [Addon](addon/README.md): the extension addon package.
- [Auto title](auto-title/README.md): generated session titles.
- [Dollar skill](dollar-skill/README.md): `$skill` suggestions.
- [pi-optimizer](optimizer/README.md): T2S, Caveman/Ponytail prompts, optional RTK, and the unified settings entry.

## Decisions

- [ADRs](adr/): accepted decisions, one file each. ADRs are historical records; a superseded ADR stays in place and is marked by the decision that replaced it.

## Research

Research records evidence for current code and design. It does not override source, tests, package
READMEs, or specifications.

- [Gemini Responses thinking](research/gemini-responses-thinking.md): medium requests, stream parsing, signature carriers, and cross-provider history conversion.
- [Gemini and OpenAI system messages and caching](research/gemini-system-messages-and-cache.md): instruction-role differences, dynamic tool appending, Gemini caching, and Interactions API limits.
- [Pi Durable](research/pi-durable.md): durable execution substrate, TUI/feature separation, and incremental migration risk.
- [billion-context](research/billion-context.md): long-context context management survey.
- [pi-ext-memory upstream comparison](research/pi-ext-memory-upstream-comparison.md): the amosblomqvist branch's UI/UX and features.
- [Python Eval ledger stability](research/python-eval-ledger-stability.md): whether a narrow execution-facts ledger is viable.
- [Read tool port](research/read-tool-port.md): Pix, Pi 0.84.0, and pi-ext-tools compared.
- [RTK upstream comparison](research/rtk-pix-upstream-comparison.md): Pix and pi-rtk-optimizer compared for bash optimization.
- [Codex conversion rendering](research/codex-conversion-rendering.md): `pi-codex-conversion` rendering and tool result passing.
- [Responsive side panel](research/responsive-side-panel.md): side panel behaviour in Pi 1.2.0.
- [Pix Pretty port](research/pix-pretty-port.md): the port study.
- [Original Pi theme analysis](research/pi-original-theme.md): research used to derive the Pi TUI design.

## Plans

[`plans/`](plans/README.md) holds design records that explain why a shape was chosen. They are
historical background, not the source of current behaviour.

## Archive

[`archive/`](archive/README.md) holds documents that describe something that no longer exists:
superseded designs, completed task backlogs, and research for removed features.

## Source Of Truth

Use each source for the question it owns:

- Current implementation and observed behavior: source code and focused tests.
- Required UI/UX behavior: [DESIGN.md](../DESIGN.md).
- Repository engineering rules: [AGENTS.md](../AGENTS.md) and [DESIGN_TS.md](../DESIGN_TS.md).
- Shared vocabulary: [GLOSSARY.md](../GLOSSARY.md) for module and domain terms, [CONTEXT.md](../CONTEXT.md) for cross-package tool contracts.
- Installation and compatibility: package manifests and package READMEs.
- Intended boundaries and agreed decisions: current architecture guides, specifications, and ADRs.
- Background evidence: current research documents and plans.

When implementation and a required contract disagree, record the discrepancy and
resolve it explicitly. Existing code does not automatically override an agreed specification.
