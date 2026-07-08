# Design: pi-proxy extension proxy package

## Architecture

`pi-proxy` should be a normal Pi extension package plus a small reusable proxy library.
The default extension entry composes adapters and invokes upstream extensions through a
proxied `ExtensionAPI`.

Initial shape:

```text
packages/pi-proxy/
  package.json
  src/index.ts              default Pi extension entry
  src/proxy.ts              generic ExtensionAPI proxy builder
  src/adapters/pi-fff.ts    pi-fff + hashline grep adapter
  src/hashline-grep.ts      grep text-output rewrite helpers
  test/                     bun:test coverage
```

## Proxy Boundary

The stable boundary is `ExtensionAPI`, not upstream internals. The proxy intercepts calls
made by an upstream extension during registration:

- `registerTool(tool)` can drop, rename, wrap `execute`, and rewrite descriptions or
  prompt guidance.
- `registerCommand(name, command)` can drop, rename, or wrap commands.
- `registerFlag(name, flag)` can expose or suppress flags.
- `on(eventName, handler)` can wrap event handlers and proxy `ctx` before upstream code
  sees it.
- `getFlag(name)` can return adapter-controlled values such as `fff-mode=override`.

The proxy should not attempt to mutate closure-local state inside upstream extensions.
Where deeper control is needed, adapters should control upstream inputs, registration
outputs, and runtime event/tool boundaries.

## Adapter Contract

Use composable adapter functions instead of one giant proxy switch. A conservative first
contract can be internal to `pi-proxy`:

```ts
interface ExtensionProxyAdapter {
	getFlag?(name: string, next: () => unknown): unknown;
	registerTool?(tool: unknown, next: (tool: unknown) => unknown): unknown;
	registerCommand?(name: string, command: unknown, next: (name: string, command: unknown) => unknown): unknown;
	registerFlag?(name: string, flag: unknown, next: (name: string, flag: unknown) => unknown): unknown;
	on?(eventName: string, handler: unknown, next: (eventName: string, handler: unknown) => unknown): unknown;
}
```

Adapters run in order and call `next` to continue. Returning without calling `next` drops
the registration. This mirrors middleware and makes future adapters explicit.

## pi-fff + pi-hashline Data Flow

1. `pi-proxy` default extension creates a proxied `ExtensionAPI` with the `pi-fff` adapter.
2. The adapter returns `"override"` for `getFlag("fff-mode")` so `pi-fff` registers `grep`.
3. When `pi-fff` calls `registerTool({ name: "grep", ... })`, the adapter wraps the tool.
4. The wrapped `execute` calls upstream `grep` unchanged.
5. After upstream returns text output, the wrapper parses file headers and grep line rows.
6. For each referenced file, the wrapper reads the active cwd file, normalizes line endings,
   computes `lineHashes`, and rewrites grep rows to `HASH│content`.
7. The wrapped result preserves upstream `details` and adds hashline metadata.

## Grep Output Contract

Primary output should align with hashline read output:

```text
path/to/file.ts
abc│const before = 1;
def│const result = callThing();
```

Line numbers are not part of the primary edit contract. Tests should assert only the
hashline output shape, not a human-debug line-number prefix.

## Compatibility Notes

- The first version may parse current `pi-fff` text output because `pi-fff` currently
  returns only aggregate `details` for grep results.
- Parser coupling should be isolated in `hashline-grep.ts` so an upstream structured
  `details.matches` API can replace text parsing later.
- The adapter should use `pi-hashline`'s exported `HASH_SEP`, not a hard-coded ASCII pipe.
- File read failures for a single grep result should not crash the whole tool if upstream
  output remains useful; the wrapper can leave unhashable rows unchanged and include
  warning metadata.

## Rollback

The package is additive. If the proxy causes tool conflicts, users can remove
`pi-proxy` from Pi package/extension configuration and keep using `pi-fff` and
`pi-hashline` directly.