# Configuration

This page documents the current V3 configuration for `pi-observational-memory`.

V3 keeps the existing `pi-ext-memory` settings namespace, but the setting names changed. Old V2 keys are not aliases; they are ignored. If you are upgrading, read [Migrating from V2](#migrating-from-v2).

## Where settings live

Settings live in HEPI ext-core `ext_settings.json`:

1. Global settings: `~/.pi/agent/ext_settings.json`
2. Project settings: `<project>/.pi/ext_settings.json`
3. Environment override: `PI_OBSERVATIONAL_MEMORY_PASSIVE`

Project settings override global settings. `PI_OBSERVATIONAL_MEMORY_PASSIVE` overrides only `passive` when set to a recognized value.

All extension-owned settings live under:

```json
{
  "pi-ext-memory": {}
}
```

The extension loads config once for its runtime. After changing settings, restart Pi or reload the extension so the new values are picked up.

## Full V3 example

```json
{
  "pi-ext-memory": {
    "observeAfterTokens": 10000,
    "reflectAfterTokens": 20000,
    "observerChunkMaxTokens": 60000,
    "compactAfterTokens": 81000,
    "idleCompactionTtl": "1800s",
    "idleCompactionMinTokens": 75000,
    "observationsPoolMaxTokens": 20000,
    "observationsPoolTargetTokens": 10000,
    "agentMaxTurns": 16,
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    },
    "showWorkerNotifications": true,
    "passive": false,
    "debugLog": false,
    "hindsight": {
      "enabled": false
    }
  }
}
```

You can omit everything. Defaults work for ordinary sessions, and if `model` is unset the memory workers use the current session model.

The `hindsight` block is a separate opt-in feature and is documented in [Hindsight long-term memory](#hindsight-long-term-memory).

## Settings reference

| Setting | Type | Default | What it controls |
| --- | ---: | ---: | --- |
| `observeAfterTokens` | positive integer | `10000` | Raw/source token threshold for observer runs. |
| `reflectAfterTokens` | positive integer | `20000` | Raw/source token threshold for reflector runs; successful reflection creates dropper maintenance opportunities. |
| `observerChunkMaxTokens` | positive integer | derived; minimum `256` | Maximum estimated tokens sent to one observer run. Unset: 20% of the resolved memory model's context window, or `60000` when unknown. |
| `compactAfterTokens` | positive integer | `81000` | Estimated source-entry threshold for proactive auto-compaction, counted after the latest compaction boundary. |
| `idleCompactionTtl` | duration string, number, or boolean | `"1800s"` | Idle duration threshold before triggering background proactive compaction. Numbers and numeric strings are in seconds (e.g. `1800` or `"1800"` = 1800s). Unit strings like `"1800s"`, `"30m"`, `"1h"` are supported. Set to `"never"`, `false`, or `0` to disable. |
| `idleCompactionMinTokens` | positive integer | `75000` | Minimum uncompacted tokens required to qualify for idle compaction. |
| `observationsPoolMaxTokens` | positive integer | `20000` | Normal compaction-projection observation-token pressure that makes compaction do a full fold. |
| `observationsPoolTargetTokens` | positive integer below max | half of `observationsPoolMaxTokens` | Folded active observation target used by post-reflection dropper maintenance, and the observation share of the rendered memory budget. |
| `memoryMaxTokens` | positive integer | derived | Hard upper bound on how many tokens of memory may stay visible. |
| `agentMaxTurns` | positive integer | `16` | Shared nested-agent turn cap for observer, reflector, and dropper. |
| `agentMaxTokens` | positive integer | `32000` | Maximum output tokens requested for memory-agent loops. Clamped to the model's own `maxTokens` when available. Lower it for local servers with a modest context window. |
| `model` | object | unset | Optional model override for observer, reflector, and dropper. |
| `model.provider` | string | unset | Provider name in Pi's model registry. Required when `model` is set. |
| `model.id` | string | unset | Model id in Pi's model registry. Required when `model` is set. |
| `model.thinking` | enum | unset; workers fall back to `low` | Optional reasoning/thinking level for memory workers. |
| `showWorkerNotifications` | boolean | `true` | Shows routine observer, reflector, and dropper progress notifications. |
| `passive` | boolean | `false` | Disables proactive background memory and auto-compaction triggers. |
| `debugLog` | boolean | `false` | Writes best-effort per-session extension debug events to Pi's agent directory. |

Valid `model.thinking` values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Invalid values are ignored. Positive-integer settings must be finite integers greater than zero. `observationsPoolTargetTokens` must also be below `observationsPoolMaxTokens`; if omitted or invalid, it is derived as `Math.floor(observationsPoolMaxTokens / 2)`.

## `observeAfterTokens`

Default: `10000`.

The observer runs from Pi's `turn_end` hook. It counts raw/source tokens after the latest `om.observations.recorded.data.coversUpToId` marker. When the count reaches `observeAfterTokens`, the observer receives source entries after that marker and may append a non-empty `om.observations.recorded` ledger entry.

Lower values create smaller chunks and more frequent model calls. Higher values reduce model-call frequency but let unobserved raw conversation accumulate longer. If the observer deliberately emits no observations, no ledger entry is written; the same range remains uncovered, and the observer retries after another `observeAfterTokens` of source tokens accumulate.

## `observerChunkMaxTokens`

Default: derived as 20% of the resolved memory model's context window, or `60000` when that window is unavailable.

This caps the source-addressed text sent to one observer run. Complete source entries are added oldest-first while they fit; remaining entries stay eligible for later runs. If the oldest entry alone exceeds the budget, the observer receives a clearly marked head/tail excerpt instead of an over-context request. The original session entry is not modified, and observations still cite its original source id so the source remains traceable in the session ledger.

Set an explicit value when a provider exposes a context window that differs from Pi's model metadata. Values below `256` are clamped to `256` so a chunk can always carry a complete source label, omission marker, and useful context. Keep room for the observer system prompt, prior observations/reflections, tool schemas, and output; setting this equal to the full model window will usually fail.

## `reflectAfterTokens`

Default: `20000`.

The reflector uses this raw/source-token threshold. Reflector progress is counted after the latest `om.reflections.recorded.data.coversUpToId` marker.

The dropper no longer uses `reflectAfterTokens` as its own launch threshold. Dropper work is gated by successful reflection: after the reflector records non-empty reflections in a consolidation pass, the dropper may run if the folded active observation ledger is over `observationsPoolTargetTokens`. It can see same-turn new reflections before deciding what to prune.

Lower values distill reflections more often and therefore create more opportunities for post-reflection dropper maintenance. Higher values reduce reflector model calls but leave more observations between reflection and dropper opportunities.

## `compactAfterTokens`

Default: `81000`.

The auto-compaction trigger runs from Pi's `agent_settled` hook, after retries, automatic compaction, and queued continuation finish. It counts estimated source-entry tokens after the latest compaction boundary. The count starts at `firstKeptEntryId` when Pi provides that boundary, so retained source entries remain part of the metric. Memory ledger entries and compaction metadata contribute zero. If the count reaches `compactAfterTokens`, the extension defers with `setTimeout(0)`, checks that Pi is idle, re-checks the same metric, and calls `ctx.compact()`. Pi's provider context usage is not used for this threshold.

This trigger does not wait for observer, reflector, or dropper work. Actual compaction summary creation happens later in `session_before_compact`. A non-empty V3 projection is rendered deterministically and model-free; an empty projection delegates to Pi's native summarizer so prior context is not replaced by an empty summary.

Pi's own window-pressure compaction and manual compaction can still happen independently of this proactive trigger.

## `idleCompactionTtl` and `idleCompactionMinTokens`

Defaults: `idleCompactionTtl = "1800s"` (30 minutes), `idleCompactionMinTokens = 75000`.

Most LLM providers have a Prompt Cache TTL of ~5 minutes. When a user is actively chatting, preserving a longer dialogue history continuously hits the cache. When a user steps away for an extended period (idle for >= 1800 seconds / 30 minutes), the server-side cache has expired (cold cache).

`idleCompactionTtl` acts as a local idle heuristic: when the session is idle for at least this duration, and uncompacted source tokens are at or above `idleCompactionMinTokens`, the extension schedules a quiet background compaction so that when the user returns later, the cold session usually starts with a compact, summarized context. Overdue cold-resume work uses a short startup debounce, and Pi may require a retry if a prompt arrives while compaction is still running.

### Preconditions for idle compaction
Idle compaction triggers only when all of the following conditions are met:
1. `idleCompactionTtl` is enabled (not `"never"`, `false`, or `0`).
2. The agent is idle (`ctx.isIdle() === true`).
3. Uncompacted tokens since last compaction are `>= idleCompactionMinTokens`.
4. There are new source messages strictly after the latest compaction boundary (ledger-derived deduplication).
5. The memory projection (`foldLedger`) contains valid observations or reflections. If empty, idle compaction is skipped to prevent falling back to a slow, costly native LLM summarizer.

If the user submits a new prompt before the idle timer fires, the timer is immediately cancelled to preserve active cache.

## `observationsPoolMaxTokens`

Default: `20000`.

This controls V3's full-fold pressure. During compaction, the extension builds the normal compaction projection: observations whose `coversUpToId` reaches the compaction boundary, with reflection/drop effects held stable from the latest full fold. If there is no previous full fold, normal compaction includes observations only. If that projection's active observation tokens are at or above `observationsPoolMaxTokens`, compaction performs a full fold through the compaction boundary and applies observations, reflections, and drops by coverage marker. Otherwise, it keeps reflection/drop effects stable from the latest full fold and projects only observations through the new boundary.

This is not the active observation dropper target and not a scheduling threshold for the reflector. Use `observationsPoolTargetTokens` for dropper active observation maintenance and `reflectAfterTokens` for reflector cadence.

## `observationsPoolTargetTokens`

Default: half of `observationsPoolMaxTokens`.

This controls the folded active observation target used by the dropper. If folded active observation tokens are at or below this target, the dropper has no maintenance work. If they are over target, the dropper can run only after the reflector records non-empty reflections in the same consolidation pass.

With the defaults, `observationsPoolMaxTokens` is `20000` and `observationsPoolTargetTokens` is `10000`. If the active observation pool reaches about `20000` tokens, the dropper computes a maximum count intended to move it back toward about `10000` tokens, but the model may drop fewer or none.

When the dropper runs, it computes how many tokens are over target, converts that token excess to an approximate observation-count maximum using average active observation size, and passes that maximum to the model as a hard upper bound. The model may drop fewer or none, and code still rejects invalid or duplicate candidates.

Dropper input includes deterministic reflection coverage evidence for every active observation: `none` means no current reflection supports the observation id, `partial` means one reflection supports it, and `strong` means two or more reflections support it. Coverage is evidence for the model, not an automatic drop rule. Relevance is importance/resistance rather than an absolute lock: `critical` observations require the strongest evidence, but older covered/superseded critical observations may leave active memory when semantic safety is clear. Dropping does not delete ledger history; known ids remain recallable.

This target does not affect compaction full-fold pressure. Visible compaction pressure remains based on `observationsPoolMaxTokens`.

It also sets the observation share of the rendered memory budget: at compaction, observations may occupy up to `observationsPoolTargetTokens` of that budget and reflections take the rest, with unused share handed back to each other. See [`memoryMaxTokens`](#memorymaxtokens).

## `memoryMaxTokens`

Default: derived, `min(floor(effective trigger × 0.5), floor(model contextWindow × 0.1))`, never below `4000`.

This is the hard upper bound on how many tokens of memory may stay **visible**, and it is shared by three things:

1. the rendered compaction summary,
2. the observation-pool target the dropper works against,
3. what the observer, reflector, and dropper are given to read.

Without this bound the deterministic summary could grow past the model window. In one real session the summary reached 750,382 characters (about 186k tokens) against an `81000` trigger and a 272,000-token window: compaction could not converge, the next request exceeded the window, and the turn aborted. Memory is now sized from whatever is left of the trigger after Pi's retained tail and the system prompt:

```
softLimit    = min(compactAfterTokens, contextWindow − Pi's reserveTokens)
available    = softLimit − retained tail tokens − system prompt tokens
renderBudget = clamp(available × 0.5, 4000, memoryMaxTokens)
```

Pi reports the retained tail of a compaction (`firstKeptEntryId` onward), and the budget reacts to it: at an `81000` trigger, a session retaining a 44,000-token tail leaves 15,500 tokens for memory, while a session retaining the default 200,000-token-relative tail leaves the full cap. When Pi compacts because the context already overflowed, the render budget is halved again.

Selection inside the budget is deterministic and never a model decision. Observations are kept first when no reflection covers them, then by kind (`decision`/`user`, then `fact`, then `progress`), then by higher relevance, then newer; reflections are kept by the session's first eight entries as anchors, then newest. Trimmed lines are not deleted: they stay in the session ledger and remain recallable by id with the `om_recall_evidence` tool.

The memory agents read the same bounded view, so their prompts stop growing with the session and they stay accountable only for the memory that stays visible. Two exceptions keep the view from becoming the whole truth:

- The dropper reads that view, but its drop budget and pool numbers are computed from the real active pool (readiness is measured on the real pool, and the count of lines it should consider is sized from how far the real pool is over target), so a pool that is over target is never silently left to the deterministic enforcer.
- The reflector reads that view plus a `REFLECTION BUDGET` line: how many tokens of the render budget are left for reflections after observations take their `observationsPoolTargetTokens` share, measured against the whole active reflection pool (with a note when the view hid some of it, since those ids cannot be named in `supersedes`). When the current reflections are over it, the reflector is expected to merge near-duplicates (declaring `supersedes`) before adding new lines.

Reflections can only leave active memory through such a merge: the reflector's `supersedes` ids become one `om.reflections.dropped` tombstone in the same run, and the replaced reflections stay readable in the ledger (`/om view full`, recall) while no longer counting against the cap. Only a valid replacement can retire a reflection: superseding ids are restricted to the reflections the reflector was shown, and a proposal with invalid content produces no tombstone.

Set `memoryMaxTokens` only when the derived cap is wrong for a workload — for example to hold long-lived memory back on a small-window model, or to allow more of it on a large-window model whose trigger is small. Whatever you write is honored, including values below `4000`.

The last render is reported by `/om status` (`── Memory budget ──`) and stored on the compaction entry as `details.budget` (budget, rendered tokens, retained tail, trigger, trimmed counts).

### Pool convergence

Trimmed lines stay in the ledger, so the ledger itself is bounded by a deterministic stage: above `cap × 1.5` active memory, a model-free enforcer reclaims non-critical observations down to `min(observationsPoolTargetTokens, max(0, cap - reflectionTokens))` and writes one `om.observations.dropped` entry. It never runs while the pool is under that watermark, never removes `critical` observations, and is idempotent. `/om status` shows `Over watermark:` while it is pending and `Reflections leave under the observation target:` when reflections leave less than `observationsPoolTargetTokens` of room under the cap — with reflections over the cap the observation target is zero and every non-critical observation is reclaimed from active memory (still recallable by id).

## `agentMaxTurns`

Default: `16`.

This is the shared nested-agent turn cap for the observer, reflector, and dropper. A turn is one assistant/model response cycle inside Pi's agent loop. The cap is not a token budget and not a literal tool-call counter.

Use lower values to bound background memory-worker cost. Too low can reduce observation coverage or reflection/drop quality.

## `agentMaxTokens`

Default: `32000`.

This is the maximum number of output tokens the extension requests for each memory-agent loop (observer, reflector, dropper). It is always clamped to the model's own `maxTokens` when the model advertises one.

Lower it when the memory model is a local server with a modest context window (for example, a llama.cpp server with a 64K slot). Slot KV is shared between the main session's retained cache and concurrent sub-agent requests, so a request whose combined input and response budget exceeds the window fails with `500 "Context size has been exceeded."` and the affected memory run aborts. Pairing a smaller `agentMaxTokens` (e.g. `8192`) with a low `observerChunkMaxTokens` keeps sub-agent requests inside the window.

## `model`

Default: unset, meaning memory workers use the session model.

Set `model` when you want the observer, reflector, and dropper to use a cheaper or faster model than the main coding agent:

```json
{
  "pi-ext-memory": {
    "model": {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it",
      "thinking": "low"
    }
  }
}
```

`provider` and `id` must both be non-empty strings. `thinking` is optional. If the configured model cannot be resolved, the runtime attempts to fall back to the current session model and notifies once. Memory workers accept either an API key or OAuth-style auth headers (e.g. `Authorization: Bearer …`), so OAuth-authenticated providers work without an API key. If no usable model or credentials are available, the relevant background worker skips/fails safely rather than inventing memory.

Workers stream through Pi's composed provider runtime, not `@earendil-works/pi-ai/compat` alone. Session models whose `api` id comes from `pi.registerProvider` (`cursor-sdk`, CLIProxyAPI, commandcode, and other custom APIs) work without a second built-in provider. `model` remains optional: set it only when you want cheaper/faster workers than the coding agent. Leaving it unset is the Cursor-only setup.

## `showWorkerNotifications`

Default: `true`.

When `false`, the extension hides routine observer, reflector, and dropper progress notifications (including deliberate-empty observer info messages) and the end-of-run summary line. Model fallback/unavailability, worker failures (including observer stream errors), compaction notifications, the pool enforcer's reclaim notice, and explicit `/om` subcommand output remain visible.

With notifications on, a run that recorded something ends with a single delta line, for example `consolidation complete (+3 obs, +1 refl, -2 dropped) · $0.0038`. A run that changed nothing stays silent, because each stage already explains its own skip.

The cost shown there is provider-reported (`usage.cost.total`, summed over the run) and is never persisted: it is per-session run-time telemetry, so it does not survive `/reload` and does not roll back on a `/tree` switch.

## `passive`

Default: `false`.

When `true`, the extension does not proactively run the observer, reflector/dropper lane, or auto-compaction trigger. Manual/Pi compaction hooks, `/om status`, `/om view`, `/om consolidate`, `/om compact`, and `recall` remain available.

This is a configuration value, so it applies to every session. For a single session, use the gate instead:

```text
/om off     # memory is not read, written, or recalled in this session
/om on      # re-enable it
```

The gate is stored as an `om.gate` ledger entry on the current branch, so `/tree` and `/resume` restore the state that branch recorded; a branch that never recorded one counts as on. While the gate is off, all memory hooks return immediately, idle compaction timers are dropped, and the `recall` tool answers with a disabled notice.

Environment override:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=true pi
```

Truthy values: `1`, `true`, `yes`, `on`.

Falsy values: `0`, `false`, `no`, `off`.

Unrecognized values are ignored.

## `debugLog`

Default: `false`.

When enabled, the extension writes best-effort NDJSON debug events under Pi's agent directory. Normal Pi sessions write to a per-session file:

```txt
observational-memory/debug/<session-id>.ndjson
```

Contexts without a usable session id fall back to the legacy global file:

```txt
observational-memory/debug.ndjson
```

Each row includes event metadata such as `sessionId`, `sessionFile`, `runId`, `cwd`, and event-specific `data`. `runId` identifies one consolidation pipeline inside a session file, so you can filter a session log to a single observer/reflector/dropper pass.

Dropper diagnostics are especially useful when the active observation pool is over target but no drops are appended. For example:

```bash
grep '"event":"dropper' ~/.pi/agent/observational-memory/debug/<session-id>.ndjson | tail -n 50
```

Look for `dropper.result`: `no_tool_call` means the model chose not to drop anything, `all_filtered` means proposed ids were unusable, and `selected_nonempty` means usable drops were selected before append handling.

Debug logs are opt-in local debugging artifacts. By default, diagnostic events should record aggregate counts, token totals, ids, file paths, errors, and project details rather than observation/reflection content, prompts, model responses, or raw model-proposed drop ids. Treat debug files as sensitive local artifacts.

Debug-log write failures do not change memory behavior.

## Migrating from V2

V3 is not backwards compatible with V2 settings. Old keys are silently ignored and do not act as aliases.

| V2 setting | V3 setting | Migration note |
| --- | --- | --- |
| `observationThresholdTokens` | `observeAfterTokens` | Rename. Same rough observer-cadence role. |
| `compactionThresholdTokens` | `compactAfterTokens` | Rename. Same rough proactive-compaction role. |
| `reflectionThresholdTokens` | `reflectAfterTokens`, `observationsPoolMaxTokens`, and/or `observationsPoolTargetTokens` | Split. Use `reflectAfterTokens` for reflector cadence, `observationsPoolMaxTokens` for compaction full-fold pressure, and `observationsPoolTargetTokens` for dropper active observation maintenance. |
| `compactionModel` | `model` | Move `{ provider, id }` under `model`. |
| `thinkingLevel` | `model.thinking` | Move under `model`. |
| `observerMaxTurnsPerRun` | `agentMaxTurns` | Replace with one shared cap. |
| `reflectorMaxTurnsPerPass` | `agentMaxTurns` | Replace with one shared cap. |
| `prunerMaxTurnsPerPass` | `agentMaxTurns` | Replace with one shared cap; V3 calls the role the dropper. |
| `compactionMaxToolCalls` | none | Remove. No V3 replacement. |
| `passive` | `passive` | Keep if desired. |
| `debugLog` | `debugLog` | Keep if desired. |

Old V2 memory entries and old V2 compaction details are ignored by V3. Start a new clean Pi session after upgrading to V3 so old visible summaries and old memory formats do not confuse the transition.

## Tuning recipes

### Lower background cost

```json
{
  "pi-ext-memory": {
    "observeAfterTokens": 20000,
    "reflectAfterTokens": 50000,
    "agentMaxTurns": 8,
    "model": { "provider": "openrouter", "id": "a-cheaper-model", "thinking": "off" }
  }
}
```

Tradeoff: fewer background model calls, but memory updates lag longer, observation chunks are larger, and reflection/drop cleanup happens less often.

### More responsive memory

```json
{
  "pi-ext-memory": {
    "observeAfterTokens": 750,
    "reflectAfterTokens": 3000,
    "agentMaxTurns": 16,
    "model": { "provider": "openrouter", "id": "a-fast-model", "thinking": "low" }
  }
}
```

Tradeoff: more background model calls.

### Disable proactive work temporarily

```json
{
  "pi-ext-memory": {
    "passive": true
  }
}
```

Or for one shell:

```bash
PI_OBSERVATIONAL_MEMORY_PASSIVE=1 pi
```

## See also

- [concepts.md](concepts.md) — vocabulary and mental model.
- [how-it-works.md](how-it-works.md) — lifecycle and data shapes.
- [../README.md](../README.md) — quick start, Hindsight long-term memory, and V2 migration summary.

## Hindsight long-term memory

The `hindsight` section is a separate, **opt-in** feature: cross-session repository memory served by a Hindsight deployment. It is disabled unless `enabled` is literally `true`, and while disabled it registers no agent tools, reads no Hindsight config file, and makes no request.

```json
{
  "pi-ext-memory": {
    "hindsight": {
      "enabled": false,
      "apiUrl": "https://api.hindsight.vectorize.io",
      "apiToken": "",
      "bankId": "",
      "autoRecall": true,
      "retainSessions": true,
      "reflectBudget": "high",
      "reflectToolTimeoutMs": 45000,
      "readTimeoutMs": 15000,
      "maxMemoryChars": 8000,
      "configPath": "~/.hindsight/coding-agent.json"
    }
  }
}
```

| Setting | Type | Default | What it controls |
| --- | --- | ---: | --- |
| `enabled` | boolean | `false` | Turns the feature on. Only `true` enables it; it is never read from the environment. |
| `apiUrl` | string | cloud API URL | Hindsight endpoint. |
| `apiToken` | string | unset | Bearer token. Never printed by `hindsight_diagnose`. |
| `bankId` | string | derived | Pins the bank instead of deriving it from the repository. Setting it makes the bank shared. |
| `autoRecall` | boolean | `true` | Runs a knowledge-page search for each prompt and injects the hits inside a `<memory>` container. Retrieval only — `hindsight_reflect` is never automatic. |
| `retainSessions` | boolean | `true` | Writes the run's turns back to Hindsight at turn end. |
| `reflectBudget` | `low`/`mid`/`high` | `high` | Reasoning budget for `hindsight_reflect`. |
| `reflectToolTimeoutMs` | positive integer | `45000` | Deadline for one reflect call. |
| `readTimeoutMs` | positive integer | `15000` | Deadline for page, search, retain, and status calls. |
| `maxMemoryChars` | positive integer | `8000` | Hard cap on injected memory per turn; the rest is truncated with an explicit marker. |
| `configPath` | string | `~/.hindsight/coding-agent.json` | Fallback config file, read only when the feature is enabled. `~` is expanded. |

Values come from the project settings, the global settings, the `HINDSIGHT_*` environment variables, then the fallback file, then these defaults — each layer overriding the ones below it. A missing or malformed fallback file is ignored rather than fatal.

Invalid values fall back to their default. `bankId` is chosen by `hindsight.bankId`, then the fallback file's `mapPathToBank` (longest matching path prefix), then its `bankIdTemplate` with `{gitProject}` substituted, then its `bankId`, then `coding-agent::{gitProject}` from the git root. Banks derived per repository are dedicated; every other bank is shared, and retained turns then carry a `repo:<name>` tag plus the bank's `retainTags` and `retainMetadata`.
