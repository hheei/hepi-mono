# Documentation

This directory separates current documentation from historical implementation plans.

## Pi Basics

- [Pi Basics usage](../packages/pi-basics/README.md): commands, tools, settings, Loadout, persistence, and runtime behavior.
- [Pi Basics development](pi-basics-development.md): architecture, public integration APIs, local development, tests, and contribution rules.
- [HEPI design system](../DESIGN.md): normative TUI design language for new and changed Pi Basics interfaces.
- [Original Pi theme analysis](pi-original-theme-design-language.md): background research used to derive the HEPI design system.

## Repository Development

- [TypeScript design](../DESIGN_TS.md): normative TypeScript contracts, state modeling, validation, async ownership, lifecycle, and test style.
- [Pi upstream modular architecture](pi-upstream-modular-architecture.md): how `pi-ai`, `pi-agent-core`, `pi-tui`, and `pi-coding-agent` create extensibility through layered contracts, plus the corresponding HEPI boundary rules.
- [Extension development](extension-development.md): package conventions and repository-wide extension workflow.
- [TUI panel layouts](tui-panel-layouts.md): reusable layout helpers from `pi-extcore`; use only for packages that still depend on that package.
- [TUI panel example](examples/tui-panels.ts): examples for the `pi-extcore` layout helpers.

## Plans

[`plans/`](plans/README.md) contains completed or historical design and implementation plans. They preserve decisions and context, but they do not define current behavior. Use source code, tests, package README files, `DESIGN.md`, and `DESIGN_TS.md` as the current specification.

## Source Of Truth

When documents disagree, use this order:

1. Public behavior covered by source code and tests.
2. Package README usage and compatibility notes.
3. `DESIGN.md` for current TUI design rules and `DESIGN_TS.md` for TypeScript design rules.
4. Development guides for repository workflow.
5. Files under `docs/plans/` for historical context only.
