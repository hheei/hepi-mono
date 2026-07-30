# HEPI Extension Composition

HEPI extension composition describes how independently installed Pi extensions expose and manage
optional features within one Pi runtime.

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
may await it; every task declares a finite maximum turn count, and a detached task must declare a
terminal delivery sink.
_Avoid_: background mode, scheduled job

**Conversation**:
A durable, root-session-scoped child AgentSession. It accepts ordered messages and may publish
selected outbound events to explicit subscribers; it is not a transport protocol or a terminal
task notification.
_Avoid_: IRC transport, task with a steer button

**Queued message**:
A FIFO conversation input that starts only after the current child response reaches a boundary.
It is the default conversation send mode.
_Avoid_: steer, interruption

**Steer message**:
An explicit conversation input that redirects an active child after its current tool execution.
It is never inferred from send timing.
_Avoid_: normal chat message, cancellation

**Terminal delivery sink**:
The caller-owned, mandatory delivery callback for a detached Task result. A sink failure marks
delivery failed without changing the task result; core never retries it automatically. The sink
receives a cancellation signal and must not write parent state after it aborts.
_Avoid_: core notification, exactly-once delivery

**Root subagent coordinator**:
The single parent-session owner of a shared active-turn concurrency cap, all handles, cancellation
and shutdown cleanup. Child sessions cannot create subagents.
_Avoid_: per-extension pool, durable supervisor

**Subagent event subscription**:
A subscriber-owned, fixed-cap snapshot stream for selected child output. Text, tool activity and
turn state may coalesce; terminal state evicts coalescible entries and is never dropped. The stream
preserves only delivered-event order, not every intermediate state.
_Avoid_: lossless event log, blocking callback
