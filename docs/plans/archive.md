# Completed Extension Plans

This document preserves the durable decisions from feature plans that have already landed. It is historical context, not a current behavior specification. Source code, tests, the package README, and `DESIGN.md` take precedence.

## Ask

Ask provides one focused `ask` tool for 1-4 related questions. It validates structured options, supports single and multiple selection plus custom answers, and submits only from a final review step. TUI sessions use the full questionnaire component; supported dialog hosts use a sequential fallback; unsupported non-interactive hosts fail closed.

Implementation: `packages/pi-ask/src/`
Tests: `packages/pi-ask/test/`

## Goal

Goal manages one branch-local objective at a time. `/goal <objective>` starts or replaces it, while bare `/goal` suspends or resumes it. The model records terminal evidence through `goal(status: "blocked" | "complete")`. Incomplete objectives survive branch replay without automatically dispatching work; continuation timers and run ownership remain session-scoped. Safety stops preserve resumable state.

Implementation: `packages/pi-goal/src/`
Tests: `packages/pi-goal/test/`

## Plan Mode

Plan Mode separates planning from implementation. `/plan` starts the flow, persists the proposed plan as a branch-local artifact, and opens a confirmation surface for refinement, implementation, or dismissal. Persistence and confirmation behavior are isolated from Goal and Todo state.

Implementation: `packages/pi-plan/src/`
Tests: `packages/pi-plan/test/`

## Statusbar

The statusbar contribution centralizes session status rendering and lifecycle cleanup. It composes compact status items without letting individual features overwrite host UI independently, and it follows the shared width, ANSI, and rendering rules in `DESIGN.md`.

Implementation: `packages/pi-status/src/`
Tests: `packages/pi-status/test/`

## Todo

Todo uses an ordered operation batch rather than full-list replacement. Create, update, list, and delete operations validate atomically, including status transitions and dependency cycles. State is restored from branch history, and `/todos` plus the widget remain read-only views of the same model.

Implementation: `packages/pi-todo/src/`
Tests: `packages/pi-todo/test/`

## Archived Decisions

- Runtime state is session-scoped unless a feature explicitly owns branch persistence.
- Shared active-tool state has one coordinator; features contribute demand instead of writing the host list independently.
- Terminal UI rendering must be ANSI-safe, cell-width-safe, responsive, and cleaned up idempotently.
- Public behavior belongs in the package README and tests. Planning documents are removed after their durable decisions are captured here.
