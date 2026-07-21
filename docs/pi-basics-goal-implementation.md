# `pi-basics` Goal 逐步实作方案

> 上游 Review contract：[`pi-basics-goal-high-level.md`](./pi-basics-goal-high-level.md)。  
> Domain、tool、persistence、timer、compact 与 visibility contract：[`pi-basics-goal-design.md`](./pi-basics-goal-design.md)。  
> 本文件是 planning；当前没有 Goal production source。

## 1. Implementation principles

- 只实现单 Goal、durable `inactive | active`、runtime `awaitingObjective`、`goal(blocked|complete)`、15 秒 grace delay 与 20 次 cap。
- 先升级/验证 Pi host seam，再写 Goal；缺少 `agent_settled` 时停止，不用 polling 或 `agent_end` 代替。
- Branch custom entries 是唯一 durable state。Timer、goal id、run sequence 与 awaiting flag 不持久化。
- `appendEntry()` 是同步 `void`：append 成功后 commit state/tool demand；失败时保留旧 state，不先 abort 或 delivery。
- Tool 省略 `promptSnippet` 与 `promptGuidelines`；不能把 active schema 描述成零 context。
- Active-tool set 只有一个 writer；必须迁移 composition root、Ask 与 exported Loadout module 的所有 direct writer。
- 不新增 dependency、generic plugin bus、settings、queue、budget、Goal tab 或 footer owner。

## 2. Planned file map

```text
bun.lock

packages/pi-basics/src/index.ts
packages/pi-basics/src/runtime/tool-activation.ts
packages/pi-basics/src/modules/ask/index.ts
packages/pi-basics/src/modules/loadout/index.ts
packages/pi-basics/src/modules/goal/model.ts
packages/pi-basics/src/modules/goal/persistence.ts
packages/pi-basics/src/modules/goal/feature.ts
packages/pi-basics/src/modules/goal/index.ts

packages/pi-basics/test/runtime/tool-activation.test.ts
packages/pi-basics/test/modules/goal/model.test.ts
packages/pi-basics/test/modules/goal/persistence.test.ts
packages/pi-basics/test/modules/goal/feature.test.ts
```

Do not create a parallel test layout if current repository convention differs.

## 3. Phase 0 — Pi host prerequisite

### 3.1 Dependency update

1. Current registry version 0.80.10 public types have been checked: `agent_settled`, `ctx.hasPendingMessages()`, `ctx.isIdle()`, command `ctx.waitForIdle()`, input APIs and ExtensionAPI `sendUserMessage(): void` are present.
2. Preserve root manifest's `latest` convention; refresh all three lock resolutions together: `pi-ai`, `pi-coding-agent`, `pi-tui` to 0.80.10.
3. Use Bun to update the lock intentionally, then verify with `bun install --frozen-lockfile`.
4. Do not change package peer ranges; `pi-basics` already accepts host-provided Pi.

Expected production file: `bun.lock` only.

### 3.2 Focused host probe

Before Goal source, prove:

- `agent_end` may precede retry/automatic compaction/queued work;
- `agent_settled` fires after retry/queued work drains;
- manual compact aborts the current run and can complete without `agent_settled`;
- auto compaction with `willRetry: true` reaches later settled flow;
- `ctx.isIdle()` and command `ctx.waitForIdle()` have expected ordering;
- input source/streaming semantics match objective capture rules;
- `sendUserMessage(..., { deliverAs: "followUp" })` is accepted and returns `void`;
- terminal tool result `terminate:true` is only an early-termination hint when every finalized result in its batch has the hint;
- abort/final error are distinguishable from non-error settled outcome.

Delete temporary probe after evidence unless it defends a stable contract.

### 3.3 Gate

Stop if updated Pi lacks required settled/idle/compact semantics. Do not emulate with retry loops, interval polling, private fields or sleep after `agent_end`.

## 4. Phase A — Loadout/Ask/Goal active-tool coordinator

This phase is required for exact “Goal schema hidden outside active mode.” Omitting prompt metadata only removes extra prompt text; active schema still occupies context.

### A1. Narrow coordinator

Create `packages/pi-basics/src/runtime/tool-activation.ts`:

```ts
export interface ToolActivationCoordinator {
  setLoadoutBaseline(names: readonly string[]): void;
  setAskVisible(visible: boolean): void;
  setGoalVisible(visible: boolean): void;
  isConfigured(toolName: string): boolean;
  isEffective(toolName: string): boolean;
  dispose(): void;
}
```

Implementation:

- retain one deduplicated Loadout baseline in configured order;
- Ask/Goal masks may only remove their named baseline tool, never add a disabled tool;
- compute once per mutation and call `pi.setActiveTools()` only when effective list changed;
- no arbitrary owner map, token estimate, persistence, events, priorities or plugin registration.

```text
effective = Loadout baseline
          minus `ask` when Ask is not interactive
          minus `goal` unless Goal is active
```

Default Goal mask is false before Goal activation.

### A2. Migrate every writer

In `packages/pi-basics/src/index.ts`:

1. create coordinator before registering/loading Goal, Ask or Loadout;
2. register Goal tool before Loadout inventory is loaded so inventory discovers it;
3. create shared Loadout runtime bridge and shared Goal reference;
4. make lifecycle Loadout runtime call coordinator baseline API;
5. make Ask call `setAskVisible(interactive)`;
6. make Goal call `setGoalVisible(active)`;
7. dispose dependent features before coordinator.

In `packages/pi-basics/src/modules/loadout/index.ts`, remove its direct `pi.setActiveTools()` call. Its exported module must receive/use the same runtime bridge as the composition root; no fallback direct writer remains.

After Phase A, `grep setActiveTools(` under `packages/pi-basics/src` must show only coordinator implementation.

### A3. Loadout disable transaction

Loadout controller calls runtime tool application after storage update. The shared bridge must apply Goal disable in this order:

```text
old baseline contains goal, next baseline excludes goal
  -> await goal.disableFromLoadout()
     persist suspended slot
     set Goal inactive and hidden
     abort current Goal-owned run
  -> coordinator.setLoadoutBaseline(next)
```

- If `disableFromLoadout()` fails, throw to existing Loadout controller so storage/maps/runtime rollback restores old baseline.
- If baseline refresh re-enables `goal`, only permission returns; stored Goal does not auto-resume.
- Waiting capture is cleared when Goal is disabled.
- Both lifecycle-created and exported UI-created Loadout controllers use this bridge.

### A4. Side-plan tests

Prove:

1. masks cannot enable baseline-disabled tools;
2. configured order and deduplication are stable;
3. repeated identical mutation does not call host setter again;
4. Ask non-interactive mask and Goal inactive mask compose without clobbering each other;
5. all three current writers route through one setter;
6. disable safety-stop runs before baseline removal;
7. safety-stop failure triggers Loadout rollback;
8. re-enable never resumes Goal;
9. dispose ignores later writes.

## 5. Phase B — Pure Goal model and persistence

### B1. `model.ts`

Implement typed transitions:

- `startNew`
- `restoreStored`
- `replace`
- `suspend`
- `recordBlocked`
- `recordComplete`
- `safetyStop`
- `incrementContinuation`
- `reconstructStored`

Keep `awaitingObjective` outside reducer state. Inject id factory for deterministic tests. Reducer returns explicit next state/result; no mutation through object identity.

Required model tests:

- inactive/active transitions;
- waiting flag start/cancel/capture;
- bare inactive restore with fresh id;
- replacement from inactive/active;
- active supplemental input does not replace objective;
- blocked retains objective/evidence;
- complete clears slot;
- error/abort/limit/disable/manual compact safety-stop stores objective;
- exact cap at 20, no 21st continuation;
- malformed objective/summary rejected without mutation.

### B2. `persistence.ts`

Implement versioned custom-entry encode/decode, append adapter and branch replay:

- snapshot statuses `active | suspended | blocked`;
- terminal `complete` entry;
- latest valid entry wins;
- replayed active normalizes to inactive + stored suspended;
- malformed/newer-version entries ignored;
- no `clear` payload and no duplicated timestamp fields;
- no disk fallback.

Required persistence tests:

- branch isolation and ordered replacement;
- blocked snapshot restore;
- complete removes slot;
- malformed entries leave latest valid slot;
- active snapshot never reconstructs as auto-running;
- append errors preserve source state contract.

## 6. Phase C — Feature, command, input and tool surface

Keep command parsing and registration in `feature.ts`/`index.ts`; no standalone `command.ts` for a two-branch parser.

### C1. Command and input

Parser:

```text
empty args -> bare toggle
non-empty trimmed args -> literal objective
```

Command ordering:

1. validate objective/capability;
2. cancel timer;
3. append durable transition;
4. commit fresh state/tool demand and invalidate old goal/run ownership;
5. abort only old Goal-owned streaming run;
6. await idle for kickoff, recheck session/mode/fresh goal id, then send best-effort kickoff.

Append failure causes neither abort nor delivery. Synchronous send failure leaves objective inactive + stored.

Input handler captures `awaitingObjective` only for non-empty `interactive | rpc` text that is not images-only or source `extension`. Streaming input is allowed and preserves Pi's existing queue behavior. Return original input unchanged.

Tests cover literal parsing, waiting capture, waiting cancellation, streaming capture, direct replacement, append failure, abort ordering and Loadout-disabled rejection.

### C2. Register `goal` tool

Use:

```ts
Type.Object({
  goal_id: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("blocked"), Type.Literal("complete")]),
  summary: Type.String({ minLength: 1 }),
})
```

Do not set `promptSnippet` or `promptGuidelines`.

Execution verifies current session, active mode, configured/effective visibility, exact id and trimmed summary. Append before terminal commit. Return `terminate: true` only as a hint after append succeeds.

Prompt requires terminal `goal` to be final and preferably sole tool call. Focused integration must submit a mixed tool batch and assert other finalized tools may still execute; Goal contract only guarantees durable closure and no later automatic Goal continuation.

### C3. Prompt trust boundary

`before_agent_start` injects escaped untrusted objective and exact current goal id. Test marker delimiters, control/newline content and instruction-like objective text; context remains balanced and guidance remains outside user-data region.

## 7. Phase D — Settled timer and compaction

### D1. Run ownership

- `before_agent_start`: if active, bind current `goalId` and increment `runSequence`; clear prior error candidate and cancel stale timer.
- `agent_end`: retain only exact current goal/run `error` or `aborted` candidate; do not safety-stop because retry/overflow may follow.
- `agent_settled`: matching error/abort candidate safety-stops; otherwise the settled run is non-error, and count 20 safety-stops before timer.

No epoch, branch marker, unpredictable prompt marker or pending-reminder marker.

### D2. Compaction

- Automatic threshold/overflow with `willRetry: true`: preserve active state; no continuation increment; final retry settles normally.
- Automatic compaction without retry: preserve active state; enclosing run eventually settles.
- Manual compact: safety-stop to inactive + stored, hide Goal and invalidate runtime. Do not wait for `agent_settled`; manual compact may complete without it.
- `session_compact` never reconstructs Goal. Only session start/switch/tree/reload/restart does.

### D3. Scheduler

Use one `setTimeout(15_000)`, not interval. Inject clock/scheduler for deterministic tests.

Timer callback rechecks:

- session, goal id and run sequence;
- active state and configured/effective tool;
- count `< 20`;
- idle and no pending host message;
- no newer input/command/follow-up;
- feature not disposed.

Eligible callback increments count then calls `sendUserMessage(..., { deliverAs: "followUp" })`. Busy callback sends nothing. After the 20th run, its next settled event persists suspended safety-stop before another timer.

### D4. Timer and compact tests

Use fake clock and focused Pi fixtures. Prove:

- 14,999 ms no send; 15,000 ms one send;
- repeated settled does not duplicate timers;
- stale goal id/run sequence cannot affect new activation;
- auto compact with retry does not strand active Goal;
- manual compact stores Goal and explicit restore works without settled;
- no timer/send after complete, blocked, error, abort or cap;
- synchronous send throw safety-stops;
- mixed tool batch demonstrates terminate hint, not guaranteed batch cancellation.

## 8. Phase E — Composition, status and lifecycle

In `packages/pi-basics/src/index.ts`:

1. create coordinator with Goal mask false;
2. register/create Goal before Loadout inventory discovery;
3. create Ask with coordinator callback;
4. create shared Loadout bridge for lifecycle and exported module paths;
5. load Loadout baseline through coordinator;
6. register Goal lifecycle cleanup and compact handlers;
7. publish additive status only.

Status values:

```text
Goal · waiting
Goal · active
Goal · stored
Goal · stored · blocked
```

Do not replace footer, expose objective/summary/id, add countdown or Settings UI.

Lifecycle tests cover session start/switch/tree/fork/reload, shutdown, manual compact, auto compact, stale old-session callback, all Loadout controller paths and cleanup order. Reconstruction always yields inactive + optional stored slot.

## 9. Verification sequence

Run incrementally after relevant phase:

```bash
bun install --frozen-lockfile
bun test packages/pi-basics/test/runtime/tool-activation.test.ts
bun test packages/pi-basics/test/modules/goal/model.test.ts
bun test packages/pi-basics/test/modules/goal/persistence.test.ts
bun test packages/pi-basics/test/modules/goal/feature.test.ts
bunx biome check <modified-source-and-test-files>
bun run typecheck
```

Run broad `bun test` only after focused tests, targeted Biome and typecheck pass.

## 10. Live smoke gate

1. Ensure Loadout has `goal` configured active; verify inactive mode omits Goal schema.
2. Bare `/goal` -> waiting; next ordinary text, including queued streaming text, becomes objective and same input runs.
3. `/goal <prompt>` starts/replaces; old Goal run aborts only after durable replacement commit.
4. Wait settled + 15 seconds; observe one follow-up and continued work.
5. During wait, submit supplemental input; old timer must not send.
6. Call `goal(blocked)`; mode exits, schema hides, bare `/goal` restores fresh id.
7. Attempt old-id tool call; observe rejection.
8. Call `goal(complete)`; mode exits and bare `/goal` enters waiting instead of restoring.
9. Manual compact active Goal; after compact bare `/goal` restores stored objective.
10. Trigger auto compaction; Goal remains active and later settled can continue.
11. Disable Goal through both Loadout UI paths; safety-stop precedes baseline removal; injected failure rolls back.
12. Exercise mixed tool batch; observe Goal closes but other finalized tools are not falsely claimed cancelled.
13. Exercise abort/provider error and 20-cap with fake clock; no extra timer/send.
14. Switch branch/session with timer pending; old callback cannot send into new context.

Record exact observed events/results. `sendUserMessage` delivery remains best-effort; do not claim provider acknowledgment unavailable from API.

## 11. Review checkpoints

### Review A — dependency, compaction and writers

- Pi 0.80.10 lock and settled/compact probe pass.
- Auto/manual compact semantics are distinct.
- Coordinator is sole `setActiveTools()` writer across all three current paths.
- Loadout disable ordering and rollback are explicit.

### Review B — pure domain

- Durable modes only inactive/active.
- Waiting capture is runtime-only.
- Blocked/complete outcomes exact.
- Persistence replay never auto-runs.
- Fresh goal ids and run sequences reject stale work.

### Review C — runtime

- Command/input/tool ordering fail-closed.
- Mixed batch terminate limitation is tested and documented.
- Exactly one 15-second timer, compact policy and 20-cap proven.
- Goal schema hidden inactive, visible active.

### Review D — final

- Focused tests, targeted Biome, typecheck, broad tests and live smoke evidence.
- No unrelated source/docs changes.
- No placeholders, compatibility aliases or obsolete Goal paths.

## 12. Stop rules

- If updated Pi lacks usable `agent_settled` or compact reason/willRetry semantics, stop automatic continuation implementation.
- If host cannot expose idle/pending state safely, stop automatic dispatch.
- If branch append/replay cannot be selected-branch-local, stop; no disk fallback.
- If any direct active-tool writer remains outside coordinator, stop before Goal runtime wiring.
- If Loadout disable cannot await Goal safety-stop and rollback on failure, return to Review.
- If direct `/goal` command ownership conflicts, resolve ownership before aliases.
- If implementation needs a new dependency, generic event bus, Settings schema, second model tool or task system, return to Review.
