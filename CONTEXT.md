# HEPI Extension Composition

HEPI extension composition describes how independently installed Pi extensions expose and manage
optional features within one Pi runtime.

## Migration

**Behavioral parity**:
A replacement preserves materially equivalent user-visible outcomes without preserving package APIs,
command names, configuration keys, storage formats, or persisted state.
_Avoid_: backward compatibility, source compatibility

**Context pipeline**:
The parent-session process that turns eligible history into compartments and injects deterministic
rendered context; it excludes memory, notes, search, Dreamer, embeddings, commands, and UI.
_Avoid_: full MCTX stack, child compaction

**Context store**:
The MCTX-owned SQLite compartment graph that is canonical for a parent session's rendered context;
the Pi session branch remains the source transcript, not the context-store summary.
_Avoid_: Pi compaction entry, process cache

**Context partition**:
One context-store region keyed by stable project identity and Pi session identity; its compartments
are readable only by that parent session even when multiple processes share the database.
_Avoid_: cross-session context, per-worktree context

**Project identity**:
`git:<root-commit>` when Git is available, otherwise `dir:<SHA-256(realpath)>`; a transient failure may
reuse a process-local known Git identity, while permission denial rejects pipeline activation.
_Avoid_: remote URL, worktree path identity

**Context revision**:
The monotonic version of one context partition, compared transactionally before a writer publishes
new compartments so a stale renderer must reread and recompute rather than overwrite newer state.
_Avoid_: last writer wins, global database revision

**Compartment run**:
An asynchronous parent turn-end attempt that snapshots eligible history and publishes one context
compartment; it never rewrites an active turn or blocks a prompt.
_Avoid_: host compaction, pre-prompt rewrite

**Context block**:
The cache-stable rendered history from one context partition, inserted into transformed parent model
messages while the source Pi session branch remains unchanged.
_Avoid_: system-prompt adjunct, compaction entry, synthetic conversation message

**Parent historian**:
The explicitly configured model-backed MCTX completion that turns a parent history snapshot into a
compartment; it is not a child agent and does not silently reuse the parent agent's model.
_Avoid_: child historian, parent-model fallback

**MCTX completion admission**:
The `pi-mctx` lifecycle configures or reuses core's shared `maxActiveTurns: 2` coordinator before
pipeline activation; a different live cap is an activation diagnostic, not a direct Pi-AI fallback.
_Avoid_: direct completion, hidden core default

**Context-store failure**:
An inability to open, migrate, or validate the canonical context store after the pipeline is enabled;
it blocks parent turns by default and is distinct from an unavailable optional historian model.
_Avoid_: historian unavailable, silent native fallback

**MCTX configuration**:
The user-trusted historian and activation configuration plus field-scoped project overrides. A project
may disable or delay an already user-enabled pipeline, but cannot select its model, lower its trigger,
or change fail-closed and SQLite policy.
_Avoid_: blanket project override, implicit historian model

**Pipeline activation**:
The explicit enabled MCTX configuration that opens the context store and registers the parent transform;
it defaults to disabled and requires an explicitly configured parent historian to provide value.
_Avoid_: install-time activation, inferred activation

**Invalid pipeline configuration**:
An enabled pipeline without a valid parent historian configuration; activation is refused and Pi runs
natively after a diagnostic rather than opening the store or registering a no-op transform.
_Avoid_: context-store failure, partially active pipeline

**Reserved MCTX configuration**:
An upstream-shaped MCTX configuration field preserved during migration but inactive until its feature
is implemented. It is opaque JSON, not an active setting or compatibility promise; only an activated
feature validates its own fields.
_Avoid_: speculative full validator, silently active setting

**Compartment trigger budget**:
The model-aware percentage threshold plus absolute-token fallback and guard used with hysteresis to
schedule a parent compartment run after turn end.
_Avoid_: fixed token limit, context-window-only trigger

**MCTX trigger policy**:
A pure decision over usage, an optional context window, an optional absolute token threshold, and
cooling state. The default percentage is `65` and valid percentages are `20..80`; a known window uses
the greater of its rounded-up percentage threshold and absolute threshold, while an unknown window
uses absolute only. Trigger enters cooling. Cooling re-arms only at ten percentage points below the
percentage threshold and, when present, at or below 90% of the absolute threshold. It does not
register lifecycle hooks or read configuration.
_Avoid_: turn-end registration, config mutation, single-threshold cooldown

**M0/M1 context tiers**:
The stable cacheable `m[0]` history tier and newer materialized `m[1]` tier rendered before the
compartment boundary's live tail; together they replace old model history from the source transcript.
_Avoid_: rolling summary, raw transcript cache

**Fork inheritance**:
The creation of a new context partition by copying only ancestor compartments that remain valid for
the forked Pi branch; a failed copy leaves the child to rebuild without sharing its parent's partition.
_Avoid_: shared partition, unfiltered clone

**Historian publication fence**:
The structural, coverage, boundary, and graph-invariant validation that a parent historian output must
pass before atomic publication; one repair completion follows its first validation failure.
_Avoid_: nonempty-output publish, partial context publish

**Historian transient retry**:
At most two cancellable jittered retries for a transient parent historian provider failure; it excludes
abort, authentication or 400 errors, configuration errors, and validation failures.
_Avoid_: validation repair, unlimited retry

**Protected live tail**:
The token-budgeted recent complete parent turn groups kept verbatim after the compartment boundary;
user input, its assistant response, and related tool/results are never split by that boundary.
_Avoid_: fixed message window, summary-eligible head

**Branch divergence**:
A current Pi session branch whose source-range fingerprint no longer validates stored compartments;
the partition atomically drops divergent state, keeps validated ancestors, and rebuilds from raw history.
_Avoid_: shared fork partition, stale summary reuse

**Compartment lease**:
A finite SQLite per-partition single-flight lease for one historian run, renewed while active and
released on abort or shutdown so another process can take over after TTL expiry.
_Avoid_: process-local in-flight flag, publish revision

**Context retention**:
The first pipeline milestone preserves context partitions without automatic semantic deletion; future
retention requires an explicit data-management design rather than TTL or shutdown loss.
_Avoid_: implicit TTL prune, shutdown deletion

**Pipeline diagnostic**:
A model-invisible Pi native notification plus structured log explaining invalid configuration,
context-store failure, or a cooldown-eligible historian failure without creating MCTX UI surfaces.
_Avoid_: model message, statusbar, ctx command

## Loadout

**Loadout**:
The feature that owns the selectable inventory and activation policy for tools made available to a
Pi runtime.
_Avoid_: tool registry, active-tool manager

**Loadout contract**:
The public `@hheei/pi-ext-core` API through which independent extensions register Loadout inventory
items or managed tools without importing `pi-loadout`.
_Avoid_: private Loadout bridge, extension-to-extension API

**Inventory registration**:
A declaration that an existing native or extension tool is selectable and groupable by Loadout;
it does not create an executable Pi tool. Managed tool registration creates its own inventory item
and must not be registered separately.
_Avoid_: tool registration, tool installation

**Tool inventory item**:
The single Loadout policy record for one tool, containing its display group, priority, conflict
sets and default activation regardless of whether the tool is inventory-only or managed. A runtime
accepts exactly one registration for the item's tool ID; duplicates fail fast.
_Avoid_: tool definition, managed registration

**Managed tool registration**:
A registration through which a Tool contributor supplies an executable tool to core, which creates
the Pi tool and owns its registration lifecycle. When present, Loadout owns the tool's inventory
and activation policy.
_Avoid_: inventory registration, external tool registration

**Static managed registration**:
A managed tool registration made during extension initialization; it remains until the next full
Pi reload and cannot be individually removed.
_Avoid_: dynamic managed registration, lifecycle inventory registration

**Fallback registration**:
The core's direct Pi registration of a managed tool when `pi-loadout` is absent. It retains Pi's
default active behavior and does not interpret Loadout policy metadata. Core is always the Pi tool
registrar, whether or not Loadout is present.
_Avoid_: fallback activation policy, deferred managed registration

**Tool contributor**:
An independently loaded extension that submits a tool declaration to core without directly
registering that tool with Pi. Every HEPI-owned non-native executable tool is a Tool contributor
and must use Managed tool registration.
_Avoid_: tool owner, tool provider

**Display group**:
A named presentation category used to organize Loadout inventory items. Each item belongs to
exactly one display group; the group has no activation or conflict semantics.
_Avoid_: conflict group, policy group

**Loadout priority**:
A stable non-negative rank where smaller values are more primary. It orders inventory presentation
and resolves automatic activation-policy conflicts; it does not schedule Pi tool execution. Default
active candidates in one conflict set must not share a priority.
_Avoid_: execution priority, registration order

**Conflict set**:
A named set of tools in which at most one item may be active; a tool may belong to multiple sets.
_Avoid_: display group, tool dependency

**Explicit selection**:
A user-authored activation choice that overrides automatic priority resolution within its conflict
sets until the user changes it.
_Avoid_: default activation, execution priority

**Activation update**:
An atomic change to the effective Loadout active set. Selecting a tool enables it and disables all
members of its conflict sets in the same update.
_Avoid_: deferred conflict repair, partial activation

**Preserved baseline**:
The active Pi tools not registered with Loadout at session start. Loadout retains them unchanged
while applying policy only to its registered inventory.
_Avoid_: Loadout inventory, authoritative active set

**Native tool catalog**:
The explicit set of Pi native tools that `pi-loadout` registers as inventory items. Native tools
outside this catalog remain part of the Preserved baseline.
_Avoid_: automatic host tool discovery, authoritative native tool list

**Scoped activation override**:
A persisted global or project activation choice for one Tool inventory item, with project taking
precedence. An explicit selection writes its enabled target and disabled conflict members to the
same scope atomically. The new `pi-loadout` state starts empty and does not migrate legacy
`pi-basics-loadout` entries.
_Avoid_: default activation, transient conflict result

**Extension page router**:
A core-owned global terminal navigation surface that registers extension pages and coordinates
their tabs, lifecycle, theme, layout, focus, key routing and render host. Each page contributor
owns its visible content, actions, state and policy. The active page handles Left/Right before the
router switches tabs; Escape closes the router.
_Avoid_: individual page content, schema-driven page

**Loadout settings tab**:
The Loadout-owned content surface opened as a tab within Settings through the Extension page router.
_Avoid_: standalone Loadout route, core-owned page content

**Settings host**:
The `pi-settings` extension that owns the single `/ext-settings [page-id]` command and opens the
global Extension page router; page contributors such as Loadout only register tabs.
_Avoid_: Loadout router host, core extension entry

**Page registration**:
A lifecycle-bound declaration of one Extension page router tab. Registrations may dynamically add
or remove tabs; removing the active tab atomically selects the next tab or closes an empty router.
Tabs sort by smaller non-negative order, then stable page ID. A runtime accepts exactly one
registration for a page ID; duplicates fail fast.
_Avoid_: static page list, command registration

**Page view**:
A contributor-owned page controller and component, created lazily on first selection and cached
only while the router is open. It is cleaned up when the router closes or its page registration is
removed. It receives the active Pi theme, rebuilds theme-dependent content on notification, and
reports whether it consumed an input before the router handles tab navigation. A failed creation
leaves the router usable and retries when the user selects that page again.
_Avoid_: eagerly initialized tab, persistent router state

**Subagent handle**:
A root-session-scoped, cancellable record for one subagent operation. It owns stable identity,
terminal result, status and cleanup regardless of whether its caller awaits, receives a delivery,
or subscribes to events.
_Avoid_: raw child session, background job

**Completion**:
A lightweight, no-tools, single model response. It has no child AgentSession, transcript or
interactive input channel.
_Avoid_: bounded task, one-agent conversation

**Task**:
A bounded, tool-capable, multi-turn subagent operation that reaches one terminal result. A caller
does not await it through a main-agent tool; every task declares a finite soft request cap and a
mandatory terminal delivery sink. Core steers once at the cap, permits five grace turns, then aborts
at the hard ceiling.
_Avoid_: awaited task, background mode, scheduled job

**Conversation**:
A durable, root-session-scoped child AgentSession. It accepts ordered messages and may publish
selected outbound events to explicit subscribers; it is not a transport protocol or a terminal
task notification. Creation includes its first message and explicit reply consumption; it declares
one finite maximum turn count for each message reply. It becomes idle after a natural reply; a
reply reaching its limit is not itself the durable handle's terminal result.
_Avoid_: IRC transport, task with a steer button

**Queued message**:
A FIFO conversation input that starts only after the current child response reaches a boundary.
It is the default conversation send mode.
_Avoid_: steer, interruption

**Steer message**:
An explicit host or human conversation input that redirects an active child after its current tool
execution. It has priority over queued input but never discards it; queue and steer each retain FIFO
order. It is never inferred from send timing and is not exposed to the model-facing `agent` tool.
_Avoid_: normal chat message, implicit queue clearing, model-initiated interruption

**Conversation reply consumption**:
The explicit result path selected for one conversation send. `wait` binds to that send's message
sequence and uses its observer AbortSignal to return the reply or terminal outcome; `delivery`
returns an acceptance and lets the parent delivery adapter publish the reply later.
_Avoid_: task terminal delivery, arbitrary next reply

**Wait abort fallback**:
When a parent turn aborts while waiting for a conversation reply, only its wait observer ends. The
child continues that message; its eventual reply is delivered through the parent queue.
_Avoid_: silent reply loss, implicit conversation cancellation

**Soft request cap**:
The finite `maxTurns` or `maxTurnsPerReply` threshold where core sends one wrap-up steer. A reply
that finishes in the fixed five-turn grace remains a normal terminal result with `softLimitReached`;
only the subsequent hard abort produces `limit_reached` and retains partial output.
_Avoid_: immediate hard turn limit, unlimited grace

**Terminal delivery sink**:
The caller-owned, mandatory delivery callback for a Task result. A sink failure marks
delivery failed without changing the task result; core catches both synchronous throws and rejected
promises, and never retries it automatically. The sink receives a cancellation signal and must not
write parent state after it aborts.
_Avoid_: core notification, exactly-once delivery

**Delivery anchor**:
The `pi-subagents` adapter's required parent-context wrapper for a Task or Conversation delivery. It
identifies the originating operation and its purpose, terminal outcome and partial-output state,
then asks the parent to assess relevance before reporting. Core receives only the delivery sink and
does not define this prompt format.
_Avoid_: raw delayed result, core-owned parent injection

**Parent delivery mode**:
The `pi-subagents` adapter's explicit terminal-result policy: queue is the default Pi follow-up;
steer is a human or host-only parent-turn redirection. The model-facing `agent` tool uses queue.
Core receives only the resulting sink, not this policy.
_Avoid_: model-selected steer, child conversation send mode, core follow-up API

**Task delivery group**:
A `pi-subagents`-owned barrier that collects a declared set of Task terminal results and delivers
one complete aggregate only after every member reaches a terminal state. It has no partial timeout.
_Avoid_: core coordinator, task execution mode

**Root subagent coordinator**:
The single parent-session owner of a shared active-turn concurrency cap, all handles, cancellation
and shutdown cleanup. Child sessions cannot create subagents.
_Avoid_: per-extension pool, durable supervisor

**Root subagent coordinator configuration**:
The one live session-lifecycle owner that supplies the positive integer active-turn cap for a Pi
runtime. `pi-subagents` owns it. A second live owner is a collision error; lifecycle abort releases
the configuration, so `/reload` configures a new coordinator during its next session start.
_Avoid_: cap per task, hidden core default, load-order replacement

**Subagent event subscription**:
A subscriber-owned, fixed-cap snapshot stream for selected child output. Text, tool activity and
turn state may coalesce; terminal state evicts the oldest coalescible entry and is never dropped.
The stream preserves delivered-event order, not every intermediate state or a lossless event log.
_Avoid_: unbounded event queue, blocking callback
# HEPI Terminal Interaction

This context defines shared terminal interaction vocabulary for HEPI extensions. It distinguishes terminal input transport from page-owned interaction semantics.

## Language

**MouseRegion**:
A page-owned, current-layout terminal-cell region that may receive normalized mouse events.
_Avoid_: MouseComponent, clickable component

**Mouse dispatcher**:
A session-scoped service that normalizes terminal mouse input and routes it to registered MouseRegions.
_Avoid_: mouse component tree, global mouse handler

**Mouse tracking lease**:
The active lifetime created by registered MouseRegions during which the dispatcher enables terminal mouse reporting and consumes recognized mouse sequences.
_Avoid_: permanent mouse mode, raw mouse passthrough

**Mouse capture**:
The temporary routing of a selection gesture's drag and up events to the MouseRegion that received its down event.
_Avoid_: cross-region selection, retargeted drag

**Selection gesture**:
A normalized sequence of unmodified primary-button down, drag, and up events within a MouseRegion.
_Avoid_: click, hover

**Selection content model**:
The page-owned logical text representation from which selected text is derived, independent of ANSI-rendered borders and styles.
_Avoid_: rendered selection, terminal string selection

**TextPosition**:
A zero-based position in a selection content model, expressed as a line and grapheme offset.
_Avoid_: UTF-16 offset, terminal cell coordinate

**TextRange**:
A half-open interval between two TextPositions in one selection content model.
_Avoid_: inclusive selection range
