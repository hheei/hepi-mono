# Pi Source Design

This reference captures the engineering taste visible in the pinned Pi `v0.82.1` source at `references/pi`. It is evidence for designing an extension or integration, not a replacement for the public API documentation, installed declarations, `AGENTS.md`, or the project's root [`DESIGN.md`](../../../../DESIGN.md).

Pi source is a pragmatic TypeScript codebase. It prefers small named contracts, explicit owners, direct composition, and behavior-oriented tests. It does not turn every local choice into a framework. When the installed Pi version differs from the pin, inspect that version's declarations and implementation before applying any conclusion here.

## 1. Compose layers around ownership

Pi separates responsibility by package rather than allowing the interactive application to own every concern:

- `pi-ai` owns provider transports, model catalogs, authentication, schemas, and streaming helpers.
- `pi-agent-core` owns provider-neutral agent state, the agent loop, tool lifecycle, and message events.
- `pi-tui` owns terminal components, focus/input, ANSI-safe rendering, and screen updates.
- `pi-coding-agent` composes those layers into resources, extensions, sessions, compaction, built-in tools, and CLI modes.

The composition root wires dependencies and lifecycle. Parsing, storage policy, rendering algorithms, and feature state machines live behind it in focused modules. A feature should depend on the narrowest layer that owns the capability rather than reaching through the coding-agent application into a sibling's private state.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the source map and public/private boundary before making a cross-package decision.

## 2. Make the contract visible in the shape of the code

Pi commonly uses exported `type`/`interface` contracts plus a factory, controller, or class that owns mutable implementation state. This keeps callers coupled to behavior rather than maps, caches, transport details, or component internals.

Use that shape when it removes a real boundary:

- Export the data and capability contract a consumer actually needs.
- Keep caches, registries, queues, parser state, and mutable maps local to one owner.
- Use a function for a pure transform or one-shot action.
- Use a class or stateful object when it owns a lifecycle, subscription set, queue, or cache.
- Inject a collaborator only when testing, optionality, or alternate ownership requires substitution.

Do not create an interface/factory/adapter stack for a single local implementation. Conversely, do not export a mutable container just because a consumer might someday need it.

## 3. Treat the host as the state owner

Pi keeps persistent session entries, active tree leaf, model context, transcript reconstruction, tool execution, and interactive component composition in the host. Extensions contribute through public contexts, events, commands, tools, renderers, and resource manifests.

That leads to three practical rules:

1. Use the documented `ExtensionAPI`, extension contexts, session actions, and tool contracts before considering a compatibility bridge.
2. Do not edit session JSONL, mutate the chat/editor container, or import from `core/`/`modes/interactive/` merely because the current implementation makes it convenient.
3. If a task explicitly accepts private coupling, isolate the bridge, pin the Pi version it relies on, test the fallback behavior, and never represent it as a public contract.

Pi sessions are append-only JSONL trees. A tree navigation changes the active leaf and rebuilds effective context/transcript; hiding a row or changing a low-level branch alone is not equivalent to a host-level transition. Compaction and branch summaries are also separate host operations.

## 4. Keep resources declarative and package-scoped

Pi discovers extensions, skills, prompts, themes, context files, and package resources through settings and manifests. `DefaultResourceLoader` is the runtime boundary that resolves, trusts, diagnoses, and reloads those resources.

Prefer the declarative resource surface:

- publish static skills through `pi.skills`;
- publish themes/prompts through their manifest fields;
- register dynamic behavior from a package's extension entry;
- let settings and project trust decide whether a local resource is loaded.

Do not recreate resource discovery with a custom registry or inject private resource-loader maps. For HEPI-specific aggregate package and Loadout rules, follow `AGENTS.md` and the owning package documentation; they are project policy, not Pi source style.

## 5. Give async work an owner and a terminal path

Pi's runtime is event-driven, but its async operations still have a concrete owner: an agent run, session, tool execution, resource reload, or interactive component. Match that discipline:

- accept and propagate cancellation when the host gives an `AbortSignal`;
- ensure a replacement, shutdown, or disposal path owns late-result suppression and cleanup;
- keep timers, watchers, child processes, and subscriptions scoped to the feature/session that created them;
- handle expected abort separately from an operational failure;
- carry errors through the event or tool protocol that owns the operation instead of inventing a side channel.

Pi `0.82.x` does not expose public unregister APIs for most extension registrations. Reload-safe extension code therefore makes stale callbacks inert through an explicit current-owner/lifecycle gate. Never assume `/reload` removes an old handler just because a new extension factory ran.

## 6. Model streaming as two distinct protocols

Pi has two useful but different transient tool-rendering moments:

1. While a model generates tool arguments, `renderCall(..., { argsComplete: false })` receives an incomplete argument prefix. This is a proposal preview.
2. While a tool executes, `execute(..., onUpdate, ...)` can publish partial results. Pi renders these through `renderResult(..., { isPartial: true })` in the same tool row.

An argument preview must be tolerant and side-effect free. It must not execute the tool, read target files, mutate disk, or claim an observed result. Keep parser state tied to the renderer/tool call, reset it when arguments are replaced, and bound retained input and derived output.

Execution partial results are likewise transient presentation state; the final tool result remains the durable protocol result. The interactive tool component and its event wiring are implementation details. Depend on documented tool/renderer callback types, then verify the installed host behavior when a feature needs timing or state-reuse assumptions.

## 7. Build terminal UI as small, invalidatable components

Pi TUI components own width-bounded ANSI-safe rendering, focus/input behavior, and cache invalidation. Interactive mode owns the editor, chat, footer, overlays, and routing of session events into those components.

The source style is terminal-native:

- render from current state and available width, not fixed pixel assumptions;
- preserve component state across updates only when the component owns that state;
- invalidate after a relevant state or theme change rather than redrawing unrelated surfaces continuously;
- use a focused timer only while an animation or elapsed display is active, then dispose it;
- use deterministic component tests for formatting and a real host/PTY test for input ownership, shortcuts, streaming timing, and lifecycle behavior.

Pi source establishes host integration mechanics. The root [`DESIGN.md`](../../../../DESIGN.md) defines HEPI's visual language, semantic colors, rails, selector geometry, and width behavior. Do not use upstream aesthetics to override the project's deliberate TUI choices.

## 8. Prefer behavior-oriented verification

Pi code is most safely extended by testing observable contracts: a parsed resource, emitted event, tool result, session transition, rendered line, or cleanup outcome. Tests should make asynchronous ordering explicit with deferred promises, controlled fakes, and deterministic clocks where timing is material.

Avoid assertions that only prove a private helper, map, or class was used. For an extension feature, also check the host boundary that unit tests cannot prove: real session replacement, reload, terminal input, streaming, tree navigation, or resource discovery as appropriate.

## 9. Translate the taste; do not copy every upstream detail

This is a design reference, not an exception to repository constraints. HEPI deliberately strengthens several choices through `AGENTS.md`, including strict compiler options, `unknown` at untrusted boundaries, no explicit `any`, no production non-null assertions, explicit public return types, immutable shared data, and TypeBox for complex shared validation.

Apply Pi's preference for direct composition, explicit ownership, declarative resources, narrow contracts, and behavior-first tests within those stricter project rules. Do not copy upstream internal imports, broad compatibility types, or implementation shortcuts into HEPI solely because they appear in the source.

## Evidence Targets

When a conclusion here affects an implementation, read the corresponding pinned source and installed declaration:

- `pi/packages/coding-agent/src/core/resource-loader.ts`
- `pi/packages/coding-agent/src/core/extensions/types.ts`
- `pi/packages/coding-agent/src/core/extensions/runner.ts`
- `pi/packages/coding-agent/src/core/agent-session.ts`
- `pi/packages/coding-agent/src/core/session-manager.ts`
- `pi/packages/coding-agent/src/core/compaction/`
- `pi/packages/agent/src/agent-loop.ts` and `pi/packages/agent/src/types.ts`
- `pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `pi/packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
- `pi/packages/tui/src/`
