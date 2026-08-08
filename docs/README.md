# Documentation

This directory records high-level information for users and developers. Detailed implementation and TypeScript API usage belong in concise comments beside the relevant code.

## User Guides

- [Getting started](user/getting-started.md): install packages, run a local checkout, and preserve load order.
- [Package catalogue](user/packages.md): current HEPI packages and prerequisites.
- Package READMEs under `packages/*/README.md`: installation and compatibility by package.

## Development

- [Extension development](development/extension-development.md): feature workflow, package conventions, and focused verification.
- [Isolated Pi development](development/pi-dev.md): run the local Pi host with only this repository's independent packages.
- [pi-ext-core development](development/pi-ext-core.md): core and consumer-specific development rules.
- [HEPI TUI design](../DESIGN.md): required specification for UI and UX work.

## Architecture

- [Extension reference architecture](architecture/extension-reference.md): target package layout, public API, lifecycle, concurrency, and test boundaries.
- [Native bridge architecture](architecture/pi-ext-bridge.md): N-API shell boundary, vendored Brush/uutils ownership, and cancellation contract.
- [Loadout architecture](architecture/loadout.md): planned tool registration, activation policy, Settings host, and Extension page router boundaries.
- [Subagent execution architecture](architecture/subagents.md): planned completion, task, conversation, delivery, and concurrency boundaries.
- [pi-t2s](t2s/README.md): Traditional-to-Simplified input conversion, settings migration, and lifecycle boundary.

## Research

- [Advisor research](research/advisor.md): advisor design comparison and original feature boundary.
- [Pi upstream research](research/pi-upstream.md): upstream extension layering and the historical aggregate proposal.
- [Original Pi theme analysis](research/pi-original-theme.md): research used to derive the HEPI TUI design.
- [BTW implementation research](research/btw/implementation-research.md): comparison of four public BTW implementations.
- [BTW reuse inventory](research/btw/reuse-inventory.md): code reuse decisions made before implementation.

Research records evidence and prior reasoning. It does not override current code, tests, package READMEs, or design specifications.

## Plans

[`plans/`](plans/README.md) contains completed plans and durable historical decisions. Plans are context, not current behavior contracts.

## Source Of Truth

When documents disagree, use this order:

1. Source code, its comments, and focused tests.
2. `DESIGN.md` for HEPI UI and UX policy, and the `pi-development` skill's `references/DESIGN.md` for Pi source design guidance.
3. Package README installation and compatibility notes.
4. Current development and architecture guides.
5. Research and completed plans.
