# @hheei/pi-cache-debug

Hash-only prompt cache diagnostics for Pi provider requests.

The extension records each final provider payload as module hashes, then correlates it with the assistant response's `cacheRead` and `cacheWrite` usage. Prompt text, tool arguments, and tool output are never written to the log.

## Usage

Load this extension after extensions that rewrite `before_provider_request`, so it observes their final payload:

```json
{
  "packages": [
    "...other packages...",
    "npm:@hheei/pi-cache-debug"
  ]
}
```

The default log is:

```text
/tmp/pi/cache-debug/<session-id>.jsonl
```

Override it with an exact path. `{sessionId}` is replaced with the sanitized session id:

```bash
PI_CACHE_DEBUG_LOG="$HOME/.pi/agent/logs/cache-debug/{sessionId}.jsonl" pi
```

Use `/cache-debug` to show the current log path and the [complete debugging guide](./DEBUGGING.md).

The guide documents every field, cache-miss decision patterns, Magic Context drop analysis, `jq` queries, limits, and privacy considerations.

## Records

Each provider call produces:

- `request`: payload, envelope, tools, system, Magic Context m[0]/m[1], and conversation hashes
- `http-response`: HTTP status when the provider exposes it
- `usage`: `input`, `output`, `cacheRead`, `cacheWrite`, and stop reason

Request records compare adjacent payloads and include:

- `commonPrefixItems`
- `appendOnly`
- `firstChangedItem` with hash, byte length, and item kind only
- `changedModules`

Inspect cache misses:

```bash
jq -c 'select(.type == "request" or .type == "usage")' /tmp/pi/cache-debug/*.jsonl
```

See [Prompt Cache Debugging Guide](./DEBUGGING.md) for interpretation and investigation workflows.

This extension does not modify provider payloads. Logging uses synchronous append before request dispatch so every record is durable if Pi or the provider fails immediately afterward.

## Development

```bash
bun test packages/pi-cache-debug/test
bun run typecheck
```
