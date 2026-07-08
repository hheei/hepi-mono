# Rewrite Pi extension modules plan

## Goal

Coordinate planning for the three-module Pi extension rewrite described in `docs/examples/pi-extension-plan.md`. The parent task owns the cross-module scope, dependencies, and final integration review while each module is brainstormed and planned in its own child task.

## Source Plan

The source plan defines three independently verifiable modules:

- `pi-extension-setting`: a shared TUI panel abstraction for registered extension settings and resource toggles.
- `pi-loadout` rewrite: a loadout panel built on top of `pi-extension-setting`, with project/global enable-disable semantics.
- `pi-common`: prompt/status chrome inspired by `oh-my-pi`, including per-reply metrics and editable prompt/status bars.

## Requirements

- Keep the three module discussions separate so product decisions, requirements, and acceptance criteria do not blur together.
- Treat `pi-extension-setting` as the shared UI dependency for the `pi-loadout` rewrite.
- Record any dependency ordering explicitly in child task PRDs instead of relying only on the task tree.
- Do not start implementation from this parent task unless a separate integration deliverable is later added.
- Preserve the original source plan as evidence; refine requirements in task PRDs during brainstorming.

## Child Tasks

- `.trellis/tasks/07-08-pi-extension-setting-panel`: brainstorm the shared extension setting panel.
- `.trellis/tasks/07-08-pi-loadout-rewrite`: brainstorm the pi-loadout rewrite that depends on the shared panel.
- `.trellis/tasks/07-08-pi-common-status-prompt`: brainstorm the pi-common prompt/status chrome.

## Acceptance Criteria

- [x] Each module has its own child task with a PRD seeded from the source plan.
- [x] Each child task captures confirmed requirements, acceptance criteria, and open questions independently.
- [x] Cross-module dependencies are documented in the relevant child task PRD.
- [x] Brainstorming proceeds one module at a time, asking only product or scope questions that cannot be answered from repository evidence.
- [ ] Before implementation begins for any module, that module has completed planning artifacts appropriate for its complexity.

## Out of Scope

- Implementing any of the three modules directly from the parent task.
- Collapsing the three module plans into a single monolithic PRD.
- Starting `task.py start` before the relevant child task planning is reviewed.
