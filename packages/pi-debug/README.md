# @hheei/pi-debug

Development diagnostics for Pi extensions.

## Tools

### Prompt cache debugger

Hash-only provider payload diagnostics correlated with `cacheRead` and `cacheWrite`. The Pi extension exposes `/cache-debug` and writes JSONL without prompt or response text.

See [Cache Debugging Guide](./CACHE_DEBUG.md).

### TUI replay

Deterministic component replay with input, key, resize, wait, and optional real-model actions. The library captures ANSI frames and can write plain text, ANSI, metadata, and SVG artifacts.

See [TUI Replay Guide](./TUI_REPLAY.md).

## Package entry points

```text
@hheei/pi-debug                 Pi extension and cache probe API
@hheei/pi-debug/tui-replay      TUI replay library
pi-tui-replay                   Automatic replay and shell snapshot CLI
replay                          Incremental action-journal CLI
```

## Development

```bash
bun test packages/pi-debug/test
bun run typecheck
```
