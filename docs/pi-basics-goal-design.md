# `pi-basics` Goal 详细设计

> 本文件承接待 Review 的 [`pi-basics-goal-high-level.md`](./pi-basics-goal-high-level.md)。  
> Phase、file map、focused verification 与 Loadout side plan 见 [`pi-basics-goal-implementation.md`](./pi-basics-goal-implementation.md)。

## 1. Design target

```text
/goal command or eligible input
        |
        v
inactive + stored? <------ goal(blocked)/safety-stop
        |                         ^
        +-- /goal <prompt> ------+
        +-- /goal with stored -> active
        +-- /goal no stored -> awaitingObjective -> active

active -- goal(complete) --> inactive + no slot
active -- settled + 15s --> guarded follow-up
branch custom entries <-> Goal reducer
Loadout baseline + Ask runtime mask -> one effective active-tool set
```

Goal is one branch-local objective that keeps making progress until the model records `blocked` or `complete`, or a safety stop preserves the objective for explicit recovery.

Core invariants:

1. Selected branch has at most one resumable objective. No queue, focus list or task graph.
2. Durable/domain mode is exactly `inactive | active`; `awaitingObjective` is runtime-only input capture, not a persisted Goal state.
3. `blocked | complete` are model-written terminal outcomes, not additional running modes.
4. Every active activation gets a fresh opaque `goalId`; every owned run gets a monotonic `runSequence`.
5. Every asynchronous callback checks current session, active state, exact goal id and run sequence before state change or dispatch.
6. Only `goal(status="complete")` clears the resumable objective as completed. User stop, error, abort, cap, Loadout disable and manual compact preserve it.
7. Timer and run ownership are memory-only. Branch replay never auto-dispatches work.
8. Loadout owns configured permission; Goal contributes runtime visibility through one composition-root coordinator.

## 2. Domain model

### 2.1 Public and durable types

```ts
export type GoalMode = "inactive" | "active";

export type StoredGoalStatus = "suspended" | "blocked";

export interface StoredGoal {
  readonly objective: string;
  readonly status: StoredGoalStatus;
  readonly summary?: string;
}

export interface ActiveGoal {
  readonly goalId: string;
  readonly objective: string;
  readonly continuationCount: number;
}

export interface GoalState {
  readonly mode: GoalMode;
  readonly stored?: StoredGoal;
  readonly active?: ActiveGoal;
}
```

State shape rules:

- `inactive`: `active` absent; `stored` optional.
- `active`: `active` present; durable snapshot also exists so a crash/reload can recover objective as stored.
- `awaitingObjective` is not in `GoalState`. It is a runtime flag valid only when mode is inactive and no stored slot exists.
- Objective is trimmed, non-empty user data. Runtime never parses it as command text or trusted policy.
- `StoredGoal.summary` is latest blocked/safety-stop evidence. User toggle-off may omit it.

### 2.2 Runtime-only state

```ts
interface GoalRuntime {
  sessionId?: string;
  awaitingObjective: boolean;
  activeRun?: {
    goalId: string;
    runSequence: number;
  };
  errorCandidate?: {
    goalId: string;
    runSequence: number;
    aborted: boolean;
  };
  timer?: ReturnType<typeof setTimeout>;
  disposed: boolean;
}
```

- Exactly one timer per Goal feature instance.
- `goalId` invalidates every old activation; `runSequence` invalidates an older run inside the same activation.
- A session/tree/reload lifecycle event clears active runtime and reconstructs the durable slot as inactive. No separate branch identity or leaf marker is needed.
- Automatic continuation count belongs to `ActiveGoal` runtime state and is never replayed as active work.

## 3. Reducer transitions

| Current | Event | Next | Durable effect |
|---|---|---|---|
| `inactive`, no stored | bare `/goal` | `inactive + awaitingObjective` | none |
| `inactive`, stored | bare `/goal` | `active` | append active snapshot; fresh goal id |
| `awaitingObjective` | eligible ordinary input | `active` | append active snapshot; objective = input |
| any inactive/active | `/goal <prompt>` | `active` | replace objective; append active snapshot; fresh goal id |
| `awaitingObjective` | bare `/goal` | `inactive` | none |
| `active` | bare `/goal` | `inactive + stored(suspended)` | append suspended snapshot |
| `active` | accepted `goal(blocked)` | `inactive + stored(blocked)` | append blocked snapshot |
| `active` | accepted `goal(complete)` | `inactive`, no stored | append completion record |
| `active` | final error/abort | `inactive + stored(suspended)` | append safety-stop snapshot |
| `active` | continuation cap | `inactive + stored(suspended)` | append safety-stop snapshot |
| `active` | Loadout disable | `inactive + stored(suspended)` | append safety-stop snapshot |
| `active` | manual compact | `inactive + stored(suspended)` | append safety-stop snapshot |
| any | session/tree/reload reconstruction | `inactive` plus replayed slot | no dispatch |

Transition rules:

1. `appendEntry()` is synchronous `void`; prepare fresh goal id, append durable snapshot, then commit in-memory state.
2. If append throws, previous committed state remains and no abort/delivery occurs.
3. After a successful replacement/stop, invalidate old goal id/run ownership, update status, then abort only the old Goal-owned streaming run.
4. For restore/direct kickoff, await `ctx.waitForIdle()` before dispatch and recheck session, mode and fresh goal id.
5. Tool terminal append failure returns error and keeps active state; model must not receive success.
6. Duplicate terminal tool calls for a closed activation return stale/not-active and cannot append a second terminal record.

## 4. Branch persistence

Use Pi session custom entries; no project-global file or Settings storage. Pi entry headers already carry id, parentId and timestamp.

```ts
type GoalEntryPayload =
  | {
      version: 1;
      kind: "snapshot";
      objective: string;
      status: "active" | "suspended" | "blocked";
      summary?: string;
    }
  | {
      version: 1;
      kind: "complete";
      objective: string;
      summary: string;
    };
```

Replay rules:

- Walk only current branch entries in order. Ignore malformed, unknown-version and unrelated custom entries.
- Latest valid `snapshot` replaces the resumable slot. Persisted `active` normalizes to inactive + stored(suspended) on reconstruction.
- Latest valid `complete` removes the resumable slot.
- Completion entry remains inspectable branch history but does not become a resumable slot.
- `goalId`, run sequence, timer, awaitingObjective and active run never persist.
- `clear` command and clear payload do not exist in V1; completion is the only model terminal clear signal.
- Branch switch, tree navigation, session reload and extension restart reconstruct before command/input handling and never auto-run.

## 5. Public `/goal` command

Register exactly one direct command named `goal`.

### 5.1 Grammar

```text
/goal             toggle/restore/wait
/goal <prompt>    start or replace with literal prompt
```

- Trim outer whitespace only. Keep internal text, newlines and punctuation literal.
- No parser for `start`, `show`, `pause`, `resume`, `clear`, `status` or `edit`; those words are valid objective text after `/goal`.
- Empty args are a bare toggle.

### 5.2 Bare toggle

- `inactive + stored`: append active snapshot, commit fresh activation and request kickoff.
- `inactive + no stored`: set `awaitingObjective = true`; do not call model.
- `awaitingObjective`: clear flag; remain inactive.
- `active`: append suspended snapshot, commit inactive and abort current Goal-owned run if streaming.

### 5.3 Direct prompt

`/goal <prompt>` from any mode:

1. validate non-empty objective and Loadout capability;
2. append new active snapshot;
3. commit fresh goal id/state; invalidate old run ownership;
4. cancel the prior timer and abort only an old Goal-owned streaming run;
5. await `ctx.waitForIdle()` for kickoff, recheck session/mode/fresh goal id, then best-effort call `sendUserMessage()`.

`ExtensionAPI.sendUserMessage()` returns `void`; success means request issued, not provider delivery acknowledged. If dispatch throws after commit, preserve objective as inactive + stored and notify.

## 6. Runtime objective capture

When `awaitingObjective` is true, the `input` handler captures only:

- source `interactive` or `rpc`;
- non-empty text after trim;
- at least text content; images-only input is not an objective;
- not source `extension`.

Streaming input is allowed. Its existing `steer/followUp` behavior remains Pi's responsibility; Goal does not reject it solely because `streamingBehavior` is set.

On eligible input, append active snapshot, commit fresh activation, and return the original input unchanged. It does not call `sendUserMessage`; capture persistence failure exits waiting mode and requires `/goal` to retry.

While active, ordinary user input:

- cancels pending timer;
- remains supplemental instruction;
- does not replace objective or goal id;
- lets the next `before_agent_start` inject current Goal context.

## 7. Model tool contract

Register once:

```ts
{
  name: "goal",
  label: "Goal",
  description: "Record the active Goal as blocked or complete.",
  parameters: Type.Object({
    goal_id: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("blocked"), Type.Literal("complete")]),
    summary: Type.String({ minLength: 1 }),
  }),
  // no promptSnippet
  // no promptGuidelines
}
```

Validation order:

1. feature/session is current;
2. mode is active and Goal is configured/effective;
3. `goal_id` exact string match;
4. status is an accepted enum value;
5. summary trimmed non-empty;
6. append terminal durable entry;
7. commit inactive state and hide tool;
8. return result with `terminate: true` as an early-termination hint.

Terminal semantics:

- `blocked`: store same objective with blocked status and normalized summary.
- `complete`: append completion evidence and clear resumable slot.
- `terminate: true` cannot guarantee termination of a mixed tool batch. Pi terminates early only when every finalized result in that batch has the hint. The Goal contract only guarantees durable Goal closure and no later Goal continuation.
- Prompt asks model to call `goal` as the final and preferably only tool call. This is guidance, not enforcement.
- Tool does not decide whether evidence is truthful; it records model assertion with exact activation ownership.

## 8. Prompt trust boundary

`before_agent_start` adds one extension context block only for current active identity:

```text
<goal-context goal_id="...">
Continue implementing and verifying this objective.
Call goal as the final tool call when complete or genuinely blocked.
Do not stop at a plan or summary while executable work remains.

Objective (untrusted user data):
...
</goal-context>
```

- Escape marker delimiters in objective and mark it untrusted.
- Do not interpolate summary, provider error or compact summary into higher-priority instructions.
- Context uses exact current goal id and never trusts model-provided identity.
- Omit the whole context unless the current session has an active Goal and `goal` remains configured and effective.

## 9. Run ownership and event flow

### 9.1 `before_agent_start`

- Cancel stale timer.
- If active, increment/bind monotonic `runSequence` for current `goalId`.
- Inject escaped Goal context.

All runs started while Goal is active are Goal-owned unless the feature has already been closed. No separate marker string or branch identity is required.

### 9.2 `agent_end`

If event belongs to current active goal/run and its final outcome is `error` or `aborted`, retain matching `errorCandidate`. Do not safety-stop here: retriable error/overflow may start another run. Successful run has no candidate and waits for `agent_settled`.

- stale/unowned event: no-op;
- a new `before_agent_start` clears the previous candidate for the new run.

### 9.3 `agent_settled`

On exact current active run:

1. recheck current active goal/session and no pending Goal reminder;
2. if matching `errorCandidate` exists, append suspended safety-stop, close Goal, notify and return;
3. if continuation count is already 20, append suspended safety-stop, close Goal, notify and return;
4. otherwise the settled run is non-error and starts one 15,000 ms abortable timer.

`agent_settled` is required because Pi drains retry, automatic compaction and queued messages before emitting it. `agent_end` alone is insufficient.

### 9.4 Compaction policy

- Automatic threshold/overflow compaction with `willRetry: true`: keep active; do not increment continuation count or reconstruct state. Final retry settles normally.
- Automatic compaction without retry: keep active; its enclosing run eventually emits settled and may arm the timer.
- Manual compact: treat as explicit safety stop. Persist suspended slot and invalidate active runtime before/within compact lifecycle. Manual compact does not promise a later `agent_settled`; user restores after compact with bare `/goal`.
- `session_compact` is not a generic reconstruction event. Only session start/switch/tree/reload/restart reconstructs inactive + stored.

### 9.5 Timer callback

At expiry require:

- same session, active goal id and run sequence;
- active mode and not disposed;
- Goal configured active and effective tool visible;
- continuation count below 20;
- `ctx.isIdle()` true;
- no host pending user/extension message;
- no newer ordinary input or Goal command;
- no existing follow-up queued by Goal.

If busy, send nothing. Later owned settled work may schedule a fresh timer. If eligible, increment count and call:

```ts
pi.sendUserMessage(markedReminder, { deliverAs: "followUp" });
```

At count 20, the 20th follow-up may run with Goal visible so it can call `goal`; its next settled event persists suspended safety-stop before any timer, preventing a 21st send.

## 10. Timer cancellation matrix

Cancel timer on:

- ordinary user input;
- bare toggle or direct replacement;
- accepted blocked/complete tool call;
- new `before_agent_start`;
- provider final error or abort;
- Loadout disable;
- session start/switch/fork/tree/reload/shutdown;
- manual compact;
- feature dispose;
- continuation cap.

Automatic compaction does not itself close Goal or permanently invalidate the continuation path. Callback checks current goal id/run sequence even after cancellation.

## 11. Loadout and tool visibility

### 11.1 Prompt metadata

`promptSnippet` and `promptGuidelines` are omitted. This removes extra custom-tool text from default system-prompt sections, but active schema still occupies context.

### 11.2 Effective tool contract

One coordinator is sole owner of `pi.setActiveTools()` inside `pi-basics`:

```text
effective = Loadout configured active tools
          minus `ask` when Ask is not interactive
```

- The Ask runtime mask can only remove its baseline tool; Goal exposure follows the Loadout baseline and does not change with Goal mode.
- Loadout refresh updates baseline, then recomputes effective tools.
- Goal activation fails closed when baseline excludes `goal`.
- Loadout disable sequence is awaitable: detect baseline change → commit the new baseline → await Goal safety-stop → persist slot/abort. Any failure propagates so Loadout's existing rollback restores the prior baseline and active Goal runtime.
- Both `packages/pi-basics/src/index.ts` and exported `modules/loadout/index.ts` use the same bridge; neither writes `pi.setActiveTools()` directly.
- Ask uses the same bridge callback; no last-writer-wins behavior remains.
- Coordinator stays local and explicit; no generic plugin bus, owner map or priority framework.

## 12. Status and UI

Goal publishes additive status through existing extension status map:

```text
Goal · waiting
Goal · active
Goal · stored
Goal · stored · blocked
```

- Keep one line, normalized text and theme styling.
- Do not show objective, summary, goal id, timer countdown or token/cost values in footer.
- Existing footer remains owner of placement, width and truncation.

## 13. Error behavior

- Validation errors: stable tool/command error; no mutation.
- Objective capture append failure: exit waiting mode, notify, and require explicit `/goal` retry; do not capture a later ordinary prompt.
- Terminal tool append failure: keep active and return error; model cannot assume commit.
- Safety-stop persistence failure: stop runtime in memory, expose non-durable error, never auto-resume.
- Provider final error/abort: inactive + stored, no timer.
- Manual compact: inactive + stored, no timer; explicit restore required.
- Reminder synchronous send throw: inactive + stored and notify; asynchronous delivery remains unobservable.
- Malformed replay entry: ignore entry, preserve latest valid slot.

No broad catch converts errors into completion or silently drops objective/evidence.

## 14. Required source seams

Planned production shape:

```text
packages/pi-basics/src/modules/goal/
  model.ts
  persistence.ts
  feature.ts
  index.ts

packages/pi-basics/src/runtime/
  tool-activation.ts
```

Composition root creates coordinator, registers Goal tool before Loadout inventory is loaded, wires all three Loadout/Ask paths to the bridge, then starts lifecycle features. Goal module does not import sibling packages or own footer.

## 15. Verification invariants

Tests must prove observable contracts:

1. inactive/active transitions and runtime awaitingObjective capture;
2. stored restore uses fresh goal id and stale tool/run fails;
3. blocked preserves objective; complete clears slot;
4. active snapshot reconstructs inactive + stored without dispatch;
5. ordinary interactive/rpc input capture, including queued streaming input;
6. active supplemental input cancels timer without replacing objective;
7. exact 15-second schedule only after eligible settled event;
8. auto compaction with and without retry does not strand active Goal;
9. manual compact safety-stops and explicit restore works without settled event;
10. no timer after error/abort/cap;
11. exactly 20 auto continuations max per activation;
12. mixed tool batch proves `terminate` is only a hint and other tools may still execute;
13. all three active-tool writers compose without clobbering;
14. Loadout disable failure rolls back baseline and preserves recoverable objective;
15. session/tree/reload/dispose invalidates callbacks;
16. live smoke covers kickoff, continuation, blocked restore, complete clear and stale rejection.

## 16. Non-goals and upgrade triggers

V1 has no queue, budgets, cost ledger, configurable timer, Settings, disk pool, Goal tab, task ownership, questionnaire, auditor, extra model tool or footer ownership.

Reopen design only when evidence requires:

- multiple simultaneous objectives;
- configurable continuation policy;
- host-confirmed asynchronous message delivery;
- richer provider blocker/recovery signals;
- another real runtime tool mask beyond Loadout/Ask/Goal that justifies extracting a broader coordinator.
