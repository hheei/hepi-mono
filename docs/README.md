# Documentation

This directory contains current user and developer documentation, architecture notes, research, and historical plans. Package-specific behavior remains in each package README so it ships with the package.

## User Guides

- [Getting started](user/getting-started.md): install packages, run a local checkout, and preserve load order.
- [Package catalogue](user/packages.md): current HEPI packages and prerequisites.
- Package READMEs under `packages/*/README.md`: commands, tools, settings, persistence, requirements, and incompatibilities.

## Development

- [Extension development](development/extension-development.md): package conventions and repository workflow.
- [Pi Basics development](development/pi-basics.md): architecture, public integration APIs, tests, and contribution rules.
- [HEPI TUI design](../DESIGN.md): normative TUI design language.
- [Pi source design](../.pi/skills/pi-development/references/DESIGN.md): Pi source-code design taste and integration guidance.

## Architecture

- [Pi upstream architecture](architecture/pi-upstream.md): upstream layering and corresponding HEPI boundaries.

## Research

- [Advisor research](research/advisor.md): advisor design comparison and original feature boundary.
- [Original Pi theme analysis](research/pi-original-theme.md): research used to derive the HEPI TUI design.
- [BTW implementation research](research/btw/implementation-research.md): comparison of four public BTW implementations.
- [BTW reuse inventory](research/btw/reuse-inventory.md): code reuse decisions made before implementation.

Research records evidence and prior reasoning. It does not override current code, tests, package READMEs, or design specifications.

## Plans

[`plans/`](plans/README.md) contains completed plans and durable historical decisions. Plans are context, not current behavior contracts.

## Source Of Truth

When documents disagree, use this order:

1. Public behavior covered by source code and tests.
2. Package README usage and compatibility notes.
3. `DESIGN.md` for HEPI TUI policy and the `pi-development` skill's `references/DESIGN.md` for Pi source design guidance.
4. Current development and architecture guides.
5. Research and completed plans.
