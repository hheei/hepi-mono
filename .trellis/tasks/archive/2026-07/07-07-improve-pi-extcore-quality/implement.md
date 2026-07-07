# Implementation Plan: Improve pi-extcore Quality

## Pre-Implementation Gate

- Do not start implementation until this plan is reviewed and `task.py start 07-07-improve-pi-extcore-quality` is explicitly approved.
- Before coding, read:
  - `prd.md`
  - `design.md`
  - `research/pi-extcore-structure-scan.md`
  - context files listed in `implement.jsonl`

## Proposed First Slice

Focus on behavior-preserving internal refactor of `settings/register.ts` and adjacent settings helpers. Only touch `settings/panel.ts` or `tui/grouped-toggle-picker.ts` if a small extraction is clearly safe and covered by tests.

## Ordered Steps

### 1. Establish Baseline

- Run `bun test packages/pi-extcore/test/*.test.ts`.
- Run `bun run typecheck` or `bun run check` if time allows before edits.
- Inspect current exports from `packages/pi-extcore/src/index.ts` and consuming imports with `rg "@hheei/pi-extcore" packages`.

### 2. Extract Pure Settings Namespace Helpers

Candidate extraction from `settings/register.ts`:

- namespaced group id creation
- namespaced group id splitting
- optional provider/group label composition if it stays pure

Constraints:

- Keep public API unchanged.
- Add focused tests if helpers become exported from an internal module; otherwise rely on existing settings panel/register tests only if behavior is covered.

### 3. Clarify Provider Normalization and State Routing

Candidate extraction from `settings/register.ts`:

- normalize provider defaults (`generalGroups`, `groups`, `panels`, `storage`)
- provider setting group aggregation
- provider state creation for a pane
- routing `SettingChange` back to the owning provider

Constraints:

- Maintain current behavior for general pane namespacing and provider pane local group ids.
- Keep `registerExtensionSettings()` and `registerExtensionSettingCommand()` public signatures unchanged.

### 4. Re-run Focused Tests

Run:

```bash
bun test packages/pi-extcore/test/*.test.ts
```

Fix regressions before continuing.

### 5. Optional Small Panel Extraction

Only if steps 2-4 are stable and the remaining diff is still easy to review:

- Extract setting table pure helper(s) from `settings/panel.ts`, or
- Extract setting item summary/format helpers while preserving `createSettingItems()` export.

Do not attempt a large `SettingsTable`/`GroupedTogglePicker` unification in this task.

### 6. Cross-Package Compatibility Check

Run:

```bash
rg "@hheei/pi-extcore" packages
bun run typecheck
```

Confirm consuming packages compile without import changes, or keep any required import changes minimal.

### 7. Final Validation

Run:

```bash
bun test packages/pi-extcore/test/*.test.ts
bun run check
```

If `pi-ssh` sshfs tests show the previously observed timeout flake, rerun the targeted failing test once and report it clearly.

## Review Gates

- After pure helper extraction, confirm diff still preserves public API.
- Before touching `settings/panel.ts`, confirm the change reduces complexity enough to justify UI regression risk.
- Before final commit, inspect `git diff --stat` and ensure no unrelated `.gitignore` or task-unrelated changes are included.

## Rollback Points

- If helper extraction causes broad type churn, revert that extraction and keep functions local with clearer names.
- If panel extraction affects keyboard/submenu/async-save behavior, revert panel extraction and finish with register/state boundary improvements only.
- If public exports need to change, stop and return to planning for explicit user approval.

## Completion Criteria

- Implementation matches PRD acceptance criteria.
- Focused `pi-extcore` tests pass.
- Root `bun run check` passes or any unrelated flake is documented with targeted rerun evidence.
- Task artifacts remain current with the actual implementation slice.
