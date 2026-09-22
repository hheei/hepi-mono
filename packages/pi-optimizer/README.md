# @hheei/pi-optimizer

Traditional-to-Simplified input conversion, Caveman/Ponytail prompt modes, and opt-in RTK command optimization for Pi `>=0.87.0`.

```bash
pi install npm:@hheei/pi-optimizer
```

Settings are stored as the top-level `t2s`, `caveman`, `ponytail`, and `rtk` groups in global `ext_settings.json`. This package does not import OMP configuration or install RTK.

## Usage

Open `/optimizer` for the native settings menu. The optional `@hheei/pi-settings` extension also exposes the same settings provider. Changes apply after a successful save: input/command changes affect subsequent calls, and prompt changes affect the next turn.

```text
/optimizer status
/optimizer t2s t2s
/optimizer t2s off
/optimizer caveman full
/optimizer ponytail lite
/optimizer rtk on
/optimizer rtk-path /absolute/path/to/rtk
/optimizer rtk-path
```

Caveman: `off | lite | full | ultra | micro`. Ponytail: `off | lite | full | ultra`.
An empty `rtk-path` resets lookup to `PATH`. Paths containing spaces are accepted without shell quoting.

T2S defaults on and preserves inline/fenced code. Both prompt modes and RTK default off. Only interactive input is converted; RPC/extension input, model output, history, and files are not converted.

## Realtime info

Every actual T2S conversion, prompt injection, and RTK rewrite appears immediately as an `info · optimizer` entry in the conversation. Successful settings saves and errors use the same stream. Unchanged input and disabled prompt modes produce no injection entry.

Entries use Pi's native `appendEntry` / `registerEntryRenderer`, not a steering message or transient notification. They survive session resume without entering model context or triggering another turn. The compact summary identifies the operation; use Pi's expansion toggle (`Ctrl+O`) for the complete original/transformed text, injected prompt, command rewrite, or settings payload.

## RTK boundary

RTK must already be installed. Optimizer owns the one rewrite hook; `pi-ext-tools` continues to own its Bash tool and execution infrastructure. Optimizer also works with Pi's native Bash tool and does not depend on another concrete extension.

Only local foreground Bash calls are eligible. SSH Targets, PTY, async calls, and already-RTK commands are skipped. Rewrites use the official `rtk rewrite` query plus conservative `bun test` / `find` corrections; overlays do not guess whether a Bun flag consumes a following argument. Query failures (including empty successful output) are recorded before the original command runs; an already-executed command is never automatically rerun. Native info entries preserve the original and execution commands.

`output://` recovery preserves the executed subprocess output, which is already RTK-filtered. It cannot recover text discarded by RTK. Turn RTK off **before execution** when unfiltered output is needed.

No edit/apply_patch guard, sudo policy, or tool-result warning filter is included.

## Headless operation

The parameter commands work without a TUI and publish native `entry_appended` events without starting a model turn. Use Pi's structured output for status/results:

```bash
pi --mode json --print '/optimizer status'
```

Pi's plain-text print renderer does not display custom entries; JSON/RPC consumers should read `entry_appended` events whose `entry.customType` is `optimizer-info`. Interactive `/optimizer` uses Pi's native dialogs and closes on Escape; RPC without arguments reports status rather than opening a terminal menu.

## Source

Prompt content and RTK corrections are adapted from [`hheei/oh-my-pi`, `packages/hepi/omp-optimizer`](https://github.com/hheei/oh-my-pi/tree/5d30ef8e55d54788afa3f316bf67348f6920987d/packages/hepi/omp-optimizer) under the included MIT license. T2S and the Pi RTK execution boundary reuse the existing HEPI implementations.

See [the optimizer design](../../docs/optimizer/README.md) for ownership, persistence, and lifecycle contracts.
