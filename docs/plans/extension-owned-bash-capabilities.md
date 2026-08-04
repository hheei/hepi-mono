# Extension-Owned Bash Capability Design

## Status

Async-job phase implemented. PTY remains a separate proposed phase. This supersedes only the rejected
Brush migration in `omp-bash-migration.md`; Pi host remains the default `bash` backend.

## Core intuition and goal

Keep one `bash` tool name and Pi host execution for ordinary calls. Add explicit `async` and `pty`
opt-ins owned by `@hheei/pi-ext-tools`; never silently choose a different shell backend.

```text
{ command, timeout? }                    -> Pi host original Bash
{ command, timeout?, async: true }       -> pi-ext-tools background job
{ command, timeout?, pty: true }         -> pi-ext-tools interactive terminal surface
```

This gives model-visible opt-in capability without reintroducing Brush or copying OMP's coding-agent
runtime.

## Boundary mapping

| Owner | Responsibility | Fallback / cleanup |
| --- | --- | --- |
| Pi host | Default Bash schema/execute, local shell selection, streaming, truncation, abort, history and original renderer | Default path is always delegated unchanged. |
| `pi-ext-tools` | Augmented schema, route validation, job registry, job tools/commands, PTY policy and UI component | Registry is session-scoped; lifecycle disposal kills all owned jobs and surfaces idempotently. |
| `pi-ext-bridge` | Future `PtySession` N-API boundary only | No Shell or Brush API. Every PTY session owns its writer, reader, child group and teardown. |
| ext-core | Lifecycle resource ownership and custom surface transport | Does not own a process, job state, terminal buffer or Bash policy. |
| Surface | One focused `ui.custom()` PTY overlay | `Esc`, abort, timeout, UI dispose and session shutdown all kill the same PTY session. |

Concurrency rules:

- Default Bash calls retain Pi host semantics.
- Each async job has a separate system-shell process group and `AbortController`; no cwd/env/job state is
  shared between jobs.
- At most one PTY surface runs per Pi session. A second PTY call fails with an actionable error.
- `async: true` and `pty: true` are mutually exclusive and rejected before process creation.

## Public definition seam

`packages/pi-ext-tools/src/bash.ts` becomes an extension-owned `ToolDefinition`, built around an
upstream template:

```ts
const host = createBashToolDefinition(context.cwd);
```

Its TypeBox schema is a strict superset:

```ts
{
  command: string;
  timeout?: number;
  async?: boolean;
  pty?: boolean;
}
```

The definition strips extension-only keys before passing a default call to the host template. It reuses
host call/result renderer for default results and the existing expanded-output selection wrapper. Async
and PTY results use a discriminated `BashDetails` union so renderers never infer state from text.

```text
validate params
├─ async && pty      -> ToolError: mutually exclusive
├─ neither           -> host.execute(host params)
├─ async             -> jobs.start(); return { state: "running", jobId }
└─ pty               -> ptySurface.run(); await final result
```

The template's current `executionMode` remains the default; the custom definition must not claim global
parallel safety merely because an async start returns quickly.

## Background jobs

Async jobs require an explicit control surface, otherwise a returned id is unusable. Add extension-owned
tools rather than depending on unavailable Pi host job APIs:

```ts
bash_job({ action: "status" | "logs" | "stop", id: string, tail?: number })
```

`bash({ async: true })` does only start and returns an opaque ID. The registry owns:

```text
id -> process group, AbortController, cwd, command label,
      bounded stdout/stderr tail, optional full-output file,
      running | completed | failed | cancelled result
```

Implementation uses a system shell, not `createLocalBashOperations()`: that public host API resolves only
when its child exits and exposes no child/process-group handle. Async shell selection therefore becomes a
new explicit `pi-ext-tools` setting, defaulting to `process.env.SHELL` on POSIX and a platform fallback.
It must be documented as independent from Pi host's private Bash setting.

On shutdown/reload:

```text
abort session -> SIGTERM each group -> bounded grace -> SIGKILL -> close streams -> clear registry
```

Job metadata may be appended as non-LLM custom session entries for audit/history. Live process handles are
never persisted or restored across a Pi restart.

## PTY surface

PTY is a foreground interactive surface, not a detached terminal and not an async job. It is available
only when `ctx.hasUI === true`, `ctx.ui` exists and `PI_NO_PTY !== "1"`; otherwise `pty: true` fails.

```text
bash({ pty: true })
-> ext-core surface lifetime
-> Pi host ui.custom({ overlay: true })
-> PtySession.start(command, cwd, env, timeout, cols, rows)
-> user keys -> write(bytes)
-> layout resize -> resize(cols, rows)
-> output bytes -> xterm state + bounded final capture
-> completion / Esc / abort -> kill -> drain -> final tool result
```

The surface follows `DESIGN.md`: one full-width shell frame, `bashMode` command header, `muted` output,
one active focus, visible `Esc` hint, stable rows and ANSI/cell-width-safe clipping. Xterm state loads
lazily only when a PTY starts.

PTY shell selection uses the same new extension setting as async jobs. It is intentionally independent
from the host Bash default until the Pi host publishes its shell configuration API.

## Upstream reuse map

Reference: `can1357/oh-my-pi@01c1f91ff529c6af3fc27724a8ba429d83d41aed`.

| Upstream source | Reuse | Do not carry |
| --- | --- | --- |
| `tools/bash-pty-selection.ts` | Capability gate shape; replace `$env` with local environment/settings guard | OMP-specific context type. |
| `tools/bash-interactive.ts` | Kitty input normalization, capture normalization, bounded xterm write queue, overlay lifecycle shape | OMP Settings, Theme, OutputSink, artifact manager and private renderer APIs. |
| `crates/pi-natives/src/pty.rs` | PtySession API shape, portable-pty process loop, UTF-8 reader, write/resize/kill control channel, group TERM/KILL and output drain algorithm | Whole `pi-natives` crate; copy only minimal local helpers for cancellation/process groups. |
| `tools/bash.ts` | Strict route validation, structured async/PTY result-state ideas and notice formatting | OMP `AgentSession`, asyncJobManager, ACP client bridge, policy/prompt/runtime code. |
| `exec/bash-executor.ts` | Pure command/argument helpers only if a feature needs them | Persistent Brush Shell, minimizer, snapshot, direnv, OMP settings, output/artifact orchestration. |

Copied Rust/TypeScript must retain MIT attribution, exact revision, source list and dependency notices in
`references/README.md` and `packages/pi-ext-tools/THIRD_PARTY_NOTICES.md`. No upstream snapshot belongs
under `packages/`.

## Implementation phases

1. **Definition contract:** update `docs/ext-tools/README.md`, add strict TypeBox schema and route-only unit
   tests; default calls prove byte-for-byte host delegation.
2. **Async jobs:** implement registry, `bash_job`, shell setting, cancellation and lifecycle cleanup; test
   start/status/logs/stop, non-zero completion, group kill and session shutdown.
3. **Native PTY:** add minimal HEPI-owned bridge PTY module plus focused native write/resize/timeout/group-kill
   tests. Build and smoke-test it outside the tool UI.
4. **PTY surface:** add lazy xterm overlay; test narrow/wide layout, input, arrow keys, resize, Esc, timeout and
   disposal. Live-test an interactive command before exposing `pty: true`.
5. **Finalize:** add renderer details for async/PTY states, run focused package checks, update notices and commit
   each cohesive phase.

## Decisions needing agreement

Agreed on 2026-08-04:

1. `bash_job({ action: "status" | "logs" | "stop" })` is the management surface.
2. One `pi-ext-tools` shell-path setting is acceptable, even when it differs from Pi host Bash settings.
3. Async output stays in the live session only; no artifact file is written.
4. Implement async jobs first. PTY remains a later, separate phase.

Before implementation, update current high-level docs and run `/grilling` on these decisions.
