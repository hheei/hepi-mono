# @hheei/pi-debug

Development diagnostics, prompt cache analysis, and TUI replay tools for Pi extensions.

```bash
pi install npm:@hheei/pi-debug
```

## Features

### Prompt cache debugger

Hash-only provider payload diagnostics correlated with `cacheRead` and `cacheWrite`. The Pi extension exposes `/cache-debug` and records structured JSONL traces without storing sensitive prompt or response text.

- Command: `/cache-debug` in Pi TUI mode.
- See the [Cache Debugging Guide](./CACHE_DEBUG.md) for detailed trace interpretation.

### Deterministic TUI Replay

Headless component replay with input, keystrokes, resize events, artificial wait timers, and optional real-model responses. Captures clean ANSI terminal frames and exports plain text, ANSI, SVG, or metadata artifacts for documentation and snapshot testing.

- See the [TUI Replay Guide](./TUI_REPLAY.md) for replay scripting and CLI parameters.

## Package entry points

```text
@hheei/pi-debug                 Pi extension and cache probe API
@hheei/pi-debug/tui-replay      Deterministic TUI replay library
pi-tui-replay                   Automatic replay and shell snapshot CLI
replay                          Incremental action-journal CLI
```

## Development

```bash
pnpm test -- packages/pi-debug/test
pnpm run test:integration
pnpm run typecheck
```
