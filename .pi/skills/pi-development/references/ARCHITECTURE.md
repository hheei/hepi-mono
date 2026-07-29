# Pi v0.82.1 Architecture Conclusion

This is a code-level orientation for Pi `v0.82.1`. It is not a substitute for the exact document and declaration selected by [DOCS_ROUTING.md](DOCS_ROUTING.md).

## Overall model

Pi is a layered terminal coding harness:

```text
pi-coding-agent
  application policy, resource discovery, extensions, sessions, CLI/run modes
        |
        +-- pi-agent-core
        |     provider-neutral agent state, agent loop, tool lifecycle, events
        |
        +-- pi-ai
        |     provider transports, model catalog, auth, tool schema, streaming
        |
        +-- pi-tui
              component tree, terminal input/focus, ANSI and differential rendering
```

`pi-coding-agent` is the integration layer. It creates resources, binds extensions, builds system prompts, persists sessions, and hosts interactive/print/RPC modes. `pi-agent-core` should remain provider-neutral; `pi-ai` owns provider-specific transport and credentials; `pi-tui` should not own agent or session policy.

The source layout is intentional:

| Package | Owns | Primary paths |
| --- | --- | --- |
| `@earendil-works/pi-ai` | Provider APIs, model catalog, auth, compatibility streaming helpers | `packages/ai/src/` |
| `@earendil-works/pi-agent-core` | Agent state, agent loop, message/tool event protocol, harness prompt assembly | `packages/agent/src/` |
| `@earendil-works/pi-tui` | Component primitives, focus/input, width-safe terminal rendering, differential screen updates | `packages/tui/src/` |
| `@earendil-works/pi-coding-agent` | Resource/package loading, extensions, sessions, compaction, built-in tools, CLI and modes | `packages/coding-agent/src/` |
| `@earendil-works/pi-server` | Experimental server integration | `packages/server/src/` |
| `@earendil-works/pi-evals` | Evaluation support, not interactive runtime ownership | `packages/evals/` |

## Runtime composition

The normal startup chain is:

```text
Settings + project trust + package manager
  -> DefaultResourceLoader
  -> extensions / skills / prompts / themes / context files
  -> ModelRuntime + SessionManager + AgentSession services
  -> AgentSession
  -> interactive, print, RPC, or SDK caller
```

`DefaultResourceLoader` is the resource boundary. It resolves package and local resources, honors disable flags, tracks diagnostics and source metadata, and reloads extensions, skills, prompts, themes, context files, and system prompt inputs. Project-local resources are trust-gated. Its public `ResourceLoader` interface is the right seam for an SDK/custom runtime; its maps and cache fields are not.

`AgentSession` is shared by interactive, print, and RPC modes. It owns agent wiring, persistent session entries, model and thinking state, tool registry, compaction/retry state, bash execution, and extension binding. `AgentSessionRuntime` owns replacing a session/runtime when creating, resuming, switching, forking, or importing. Do not treat an `AgentSession` subscription as surviving session replacement.

## Extension model

Extensions are loaded into an `ExtensionRunner`. The runner aggregates registration and dispatches lifecycle events, tool interception, context transforms, provider hooks, renderers, and command handling. Async extension factories complete before session startup and resource discovery are finished.

Use the public exports and documented `ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`, event, tool, and renderer types. They are the intended integration seam. In particular:

- The host owns agent/session/transcript consistency. Use documented context actions rather than direct session-file edits or runner internals.
- The command context exposes a richer interactive action set than general event contexts. Do not assume a callback has command-only actions.
- Pi does not expose public unregister APIs for most extension registrations. Reload-safe HEPI code therefore uses a runtime-scoped current-owner/lifecycle gate so old callbacks become inert.
- Provider registration is special because an unregister capability is exposed; use it only through the documented registration path.
- `core/extensions/runner.ts`, `core/resource-loader.ts`, and interactive components are implementation evidence, not stable imports for HEPI production code.

## Sessions, tree, and compaction

Session files are append-only JSONL trees. Entries have `id` and `parentId`; navigating a tree changes the active leaf and rebuilds the effective agent context/transcript. Abandoned paths remain in JSONL even when they are no longer on the active branch.

Compaction and branch summaries are distinct host operations. Compaction records a summary plus a retained-entry boundary and reconstructs model context from that state. Branch summaries preserve context across a tree move. Extensions may participate only through the documented events and session APIs; hiding a row or mutating a low-level branch alone does not give a consistent agent, transcript, and session state.

## Tool execution and rendering

The provider/agent path and TUI path are separate:

```text
provider stream -> Agent message_update events -> interactive tool-call component args
tool.execute(id, args, signal, onUpdate) -> agent tool_execution_update -> same component partial result
final tool result -> persisted result + final renderer
```

There are two transient UI opportunities:

1. During assistant argument streaming, the interactive tool component updates its current arguments and invokes `renderCall` with incomplete arguments. This is for tolerant previews of proposed input only.
2. During execution, `onUpdate` emits a partial result. Pi forwards it as `tool_execution_update`; interactive mode updates the existing tool component and invokes `renderResult` with `isPartial: true`.

Argument previews must be side-effect free: no tool invocation, target-file read, disk mutation, or claim that work completed. Store preview state in the renderer context, reset it when arguments are replaced, and bound retained input. Execution partial results are also transient UI state; the final tool result remains the durable protocol result.

`ToolExecutionComponent` and the exact interactive event-to-component wiring are private implementation. The public contract is the tool definition and renderer callback types; verify an implementation detail against the installed Pi version before depending on it.

## TUI conclusion

Pi TUI is a component tree. Components render width-bounded ANSI-safe lines, can receive focus/input, and must invalidate cached output when the theme or state changes. Interactive mode owns editor/chat/footer/overlay composition and maps session events onto components.

For HEPI, `DESIGN.md` and shared Basics primitives govern visual policy. Pi's component API governs host integration. A replay artifact proves deterministic component rendering; actual host/PTY verification is still required for terminal input ownership, shortcuts, streaming timing, session lifecycle, and hardware cursor behavior.

## Safe dependency decisions

| Need | Prefer | Avoid |
| --- | --- | --- |
| Agent behavior | Public `AgentSession`, extension APIs, SDK types | Directly patching agent/session private state |
| Session branch change | Public command/session tree APIs | Editing JSONL or calling an unexposed runner callback |
| Tool UI | Documented tool definition/render callbacks | Constructing interactive `ToolExecutionComponent` |
| Custom UI | `ctx.ui`, public `Component`, `pi-tui` exports | Mutating interactive chat/editor containers |
| Resources | Package manifest, settings, `ResourceLoader` contracts | Manually injecting resource-loader maps |
| Provider/auth | `pi-ai` public APIs and provider registration | Reusing private provider transport internals |
| Reload-safe behavior | Runtime-scoped lifecycle gate and idempotent cleanup | Assuming reload unregisters old handlers |

## Verification targets

When this conclusion needs revalidation, inspect these exact source points in the pinned source and the currently installed package:

- `packages/coding-agent/src/core/resource-loader.ts`
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/agent-session-runtime.ts`
- `packages/coding-agent/src/core/session-manager.ts`
- `packages/coding-agent/src/core/compaction/`
- `packages/agent/src/agent-loop.ts` and `packages/agent/src/types.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
- `packages/tui/src/`

If the installed Pi version is not `0.82.1`, use its declarations and implementation as the primary evidence and update this conclusion only after confirming the changed contract.
