# Type Safety

## Tool Result Types

- Use `AgentToolResult<SshToolDetails>` for tool results.
- Keep result detail values JSON-like and structured.
- Narrow content items to `TextContent` before rendering result text.

## Settings Types

- Use `SshExtensionSettings` for runtime settings.
- Parse numeric settings with `clampInt()`.
- Parse disabled hosts from either arrays or newline-separated strings.

## UI Types

- Host panel helpers should accept minimal host/theme callback shapes where possible.
- Avoid using `any`; use `Record<string, unknown>` or specific tool result types.

## Forbidden Patterns

- Do not assume every result content item is text.
- Do not pass untyped params into tool executors without validation.
- Do not expose process internals in public result details.

## Examples

- `packages/pi-ssh/src/index.ts#SshToolResult`
- `packages/pi-ssh/src/index.ts#renderCollapsedResult`
- `packages/pi-ssh/src/ssh-exec.ts#SshExecResult`
