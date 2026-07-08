# Implementation Plan: pi-proxy extension proxy package

## Checklist

1. Create `packages/pi-proxy` using the existing extension package conventions.
2. Add a minimal package manifest with `@hheei/pi-proxy`, TypeScript source entry, Pi
   extension metadata, and workspace-compatible dependencies/peer dependencies.
3. Implement a generic `createExtensionProxy()` helper with adapter chaining for
   `registerTool`, `registerCommand`, `registerFlag`, `on`, and `getFlag`.
4. Implement a hashline grep rewrite helper that parses `pi-fff` grep text output,
   computes line hashes with `pi-hashline`, and emits `HASH│content` rows.
5. Implement the `pi-fff` adapter:
   - force `fff-mode` to `override` through the proxy;
   - wrap only the `grep` tool;
   - call upstream `execute` first;
   - rewrite text content with the hashline helper;
   - preserve upstream metadata while adding hashline metadata.
6. Wire `src/index.ts` to invoke the upstream `pi-fff` extension through the proxied API.
7. Add focused tests for:
   - tool registration wrapping/renaming/dropping behavior;
   - grep output rewrite with match and context rows;
   - `fff-mode` override behavior.
8. Run validation from the root:
   - `bun test packages/pi-proxy/test`
   - `bun run typecheck`
   - `bun run check` if the focused checks pass.

## Risk Points

- `pi-fff` grep text format is not a formal structured API. Keep parsing isolated and
  tested.
- Tool name collision with built-in `grep` depends on Pi registration behavior. Using
  `pi-fff` override mode matches upstream's intended replacement path.
- Importing local untracked packages may require package names/exports to be aligned
  carefully with Bun workspace resolution.
- `lineHashes` initialization is async through `initHasher`; tests and runtime wrapper
  must initialize before hashing.

## Review Gate Before Start

- Confirm whether `pi-proxy` should expose public proxy helper exports in v1, or keep them
  internal until a second adapter needs them.
- Confirm the first output format should omit line numbers entirely and use only
  `HASH│content` rows under file headers.