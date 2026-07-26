# TUI Replay Guide

`@hheei/hepi-debug/tui-replay` runs Pi TUI components against deterministic actions and records every render frame. It is intended for extension development, layout regression tests, narrow-terminal checks, and artifact generation.

## Import

```ts
import {
  createTextReplayFrame,
  createTuiReplaySession,
  formatReplay,
  replayTui,
  scrollbackLines,
  stripAnsi,
  viewFrame,
  writeReplayArtifacts,
  writeReplaySnapshot,
} from "@hheei/hepi-debug/tui-replay";
```

## Basic replay

```ts
const result = await replayTui({
  columns: 50,
  rows: 10,
  create: (host) => {
    let draft = "";
    return {
      render: () => [`> ${draft}`],
      handleInput(input) {
        draft += input;
        host.requestRender();
      },
    };
  },
  actions: [
    { type: "text", text: "hello" },
    { type: "resize", columns: 30 },
  ],
});

console.log(viewFrame(result.last).join("\n"));
```

Defaults are 50 columns and 35 rows. Each action captures a new frame after it completes. The initial render is frame zero.

## Actions

A replay accepts these action types:

- `input`: pass an exact string to `handleInput`
- `key`: pass a named terminal key such as `enter`, `escape`, `up`, or `page-down`
- `text`: pass text to `handleInput` without key translation
- `resize`: change columns, rows, or both
- `wait`: wait for asynchronous component state before capturing
- `model`: invoke Pi in JSON print mode and pass the result to `handleModelResult`

Actions can include a `label`. Unlabelled actions receive a generated frame label.

## Model actions

A model action defaults to `cx/gpt-5.6-luna` with `low` thinking:

```ts
const result = await replayTui({
  create: () => ({
    render: () => ["waiting"],
    handleModelResult(response) {
      console.log(response.text);
    },
  }),
  actions: [
    {
      type: "model",
      prompt: "Return three concise menu items",
      model: "cx/gpt-5.6-luna",
      thinking: "low",
    },
  ],
});
```

The default runner starts `pi -p --mode json` with sessions, tools, extensions, skills, and context files disabled. Tests should inject `runModel` when they need deterministic responses or must avoid provider calls.

## Frames and viewport

`result.frames` contains the full ANSI-preserving output from every `component.render(width)` call. `result.last` is the final frame.

Use:

- `viewFrame(frame)`: visible bottom-following viewport
- `viewFrame(frame, { scrollOffset })`: viewport scrolled above the bottom
- `scrollbackLines(frame)`: lines above the current viewport
- `stripAnsi(text)`: plain text suitable for assertions
- `formatReplay(result)`: labelled multi-frame timeline

The harness preserves full component output before viewport clipping. It does not mutate or wrap component lines.

## Artifacts

```ts
const artifacts = await writeReplayArtifacts(result, {
  rootDir: "outputs/my-feature",
});
```

Each invocation creates the next numbered directory in `rootDir`:

```text
replay-0001
replay-0002
replay-0003
```

The highest existing numeric replay ID is incremented. Names use at least four digits, so `replay-9999` is followed by `replay-10000`. Timestamp-style and unrelated directory names are ignored. Concurrent writers use atomic directory creation and cannot overwrite one another.

Artifact outputs are written into a hidden UUID directory first and published as `replay-NNNN` only after every requested file succeeds. Concurrent snapshot and bundle writers share a short numbering lock, so incomplete output never appears under a public replay ID. A process killed during writes may leave a hidden `.replay-*.tmp` directory, which is not treated as an artifact.

Each replay directory contains:

- `replay.txt`: plain multi-frame timeline
- `replay.ans`: ANSI multi-frame timeline
- `final.txt`: plain final viewport
- `final.ans`: ANSI final viewport
- `final.svg`: terminal-style screenshot
- `metadata.json`: dimensions, frame labels, render counts, and model calls

ANSI artifacts keep SGR styling while removing cursor movement, hyperlinks, OSC markers, and string controls. The SVG renderer supports standard, indexed, and true-color foreground SGR sequences.

## Automatic CLI

The automatic entry runs entirely from arguments and creates the next `replay-NNNN` directory.

Capture shell output as an ANSI file:

```bash
pi-tui-replay \
  --command "bun test packages/hepi-debug/test" \
  --format ans
```

Capture shell output as an SVG screenshot:

```bash
pi-tui-replay \
  --command "git status --short" \
  --format svg \
  --columns 80 \
  --rows 24
```

Capture literal text without running a shell:

```bash
pi-tui-replay \
  --text "first line" \
  --text "second line" \
  --format svg
```

`--format` accepts `svg` or `ans` and defaults to `svg`. Without explicit dimensions, shell/text capture derives width and height from the content. With explicit dimensions, long lines are truncated and the viewport follows the bottom.

For `--command`, stdout is captured first and stderr is appended. The selected snapshot is written before the CLI exits with the shell command's exit code. Shell/text capture writes only `final.svg` or `final.ans` inside its replay directory.

The automatic entry can also run the built-in component replay:

```bash
pi-tui-replay
```

Run one or more real model rounds:

```bash
pi-tui-replay \
  --prompt "First prompt" \
  --prompt "Second prompt" \
  --model cx/gpt-5.6-luna \
  --thinking low \
  --columns 50 \
  --rows 35
```

Component replay writes the complete six-file artifact bundle.

Repository command:

```bash
bun run tui:replay -- --command "git status --short" --format svg
```

## Incremental session CLI

The `replay` entry applies one command per process while preserving an action journal across shell invocations:

```bash
replay key down
replay send "hello"
replay wait
replay show
replay save
```

No REPL or background daemon stays running. Each action is appended to the current journal, then the component is recreated and all recorded actions are replayed. The command prints the resulting frame.

The built-in component starts automatically on the first action. Start explicitly to configure a custom component or dimensions:

```bash
replay start \
  --module ./scenario.ts \
  --columns 50 \
  --rows 20 \
  --root outputs/my-feature
```

Commands:

```text
start                    create a configured journal
key <name>               send up, down, enter, escape, or another named key
send <text>              send text assembled from shell arguments
input <JSON string>      send exact input bytes
resize <columns> [rows]  resize the replay viewport
wait [ms]                wait before capture; default 100ms
show                     replay and print the current frame
save [root]              write the next replay-NNNN artifact bundle
status                   print journal path and configuration
reset                    replace the journal with a new-generation reset tombstone
```

Use `--` before `send` or `input` content beginning with a dash. Every `save` call creates a new numbered artifact directory.

Journals are isolated by current working directory and the optional session name:

```bash
replay --session menu start --module ./menu.ts
replay --session menu key down
replay --session menu save outputs/menu
```

The session CLI currently requires POSIX filesystem ownership and mode semantics.

The default journal location is `~/.pi/agent/replay-sessions`. Override it with `PI_TUI_REPLAY_STATE_DIR`; relative overrides are resolved against the current working directory, and blank values are rejected. The final state directory must be a real directory, not a symlink, owned by the current user, with mode `0700`. Its canonical ancestor chain is checked before locking: mutable sticky parents are accepted only when owned by the current user or root, and other group/world-writable parents are rejected. Existing directories are validated and never chmodded implicitly.

`status` prints the exact state file, active/reset state, and random session generation. Short state read, revision comparison, and commit operations use a cross-process lock. Trusted module import, component creation, action replay, waits, rendering, and temporary artifact writes run outside the lock. The first mutation reserves a generation with a reset tombstone. If another command commits first within the same generation, an action command replays against the newer snapshot and retries its compare-and-commit. `show` rechecks the generation after rendering; `save` performs only its final hidden-directory publication while holding the generation lock. `reset` writes a new-generation tombstone and `start` creates another new generation, causing older in-flight commands to stop instead of crossing the session boundary.

Repository command:

```bash
bun run tui:replay:session -- key down
```

Use a custom component by default-exporting a replay factory:

```ts
// scenario.ts
import type { ReplayHost } from "@hheei/hepi-debug/tui-replay";

export default function createScenario(host: ReplayHost) {
  let selected = 0;
  return {
    render: () => [`selected: ${selected}`],
    handleInput(data: string) {
      if (data === "\u001b[B") selected++;
      host.requestRender();
    },
  };
}
```

```bash
replay start --module ./scenario.ts
replay key down
replay key down
replay save
```

`--module` uses dynamic import and executes the module's top-level code before validating the default factory and returned component shape. Load only trusted local modules. Shape validation is not a sandbox or security boundary.

Journal mode requires deterministic replay. Every invocation reruns all prior actions, including prior waits, against a new component instance. Do not use it for model calls, network side effects, random state, or behavior that cannot be reproduced from the action sequence. Use the automatic single-process API or CLI for those cases.

Printed session frames preserve valid SGR styling but remove all other C0/C1 controls, cursor movement, OSC, DCS, and incomplete terminal sequences before writing to stdout. Reflected CLI errors use the same printable-text allowlist before writing to stderr.

## Scope and limits

TUI replay calls a component's public render and input methods. It does not emulate Pi's full interactive host, terminal cursor state, transcript lifecycle, focus routing, notification coalescing, or provider streaming.

Use component replay for deterministic UI behavior. Use a native Pi TUI smoke test when validating host-level ordering, focus, editor integration, transcript placement, or notifications.

## Development checks

```bash
bun test packages/hepi-debug/test/tui-replay.test.ts
bun test packages/hepi-debug/test/tui-replay-session.test.ts
bun run typecheck
```
