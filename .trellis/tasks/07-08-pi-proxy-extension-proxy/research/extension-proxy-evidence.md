# Extension Proxy Evidence

## Pi Extension API

Source inspected: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.

Relevant facts:

- Pi extensions are TypeScript modules that export a default function receiving `ExtensionAPI`.
- Extensions can register tools through `pi.registerTool()`.
- Extensions can register commands through `pi.registerCommand()`.
- Extensions can register flags through `pi.registerFlag()`.
- Extensions can subscribe to lifecycle and runtime events through `pi.on()`.
- `tool_call` handlers can mutate `event.input` before tool execution.
- `tool_result` handlers can return patched `content`, `details`, or `isError`.
- `before_agent_start`, `context`, and provider hooks can rewrite model context or provider payloads.
- Event and tool hooks are sufficient for non-invasive wrapper behavior; private closure state remains inaccessible unless upstream exposes it.

## pi-fff Facts

Source inspected: `packages/pi-fff/src/index.ts` and `packages/pi-fff/package.json`.

Relevant facts:

- Package name is `@ff-labs/pi-fff`.
- Pi entry is `./src/index.ts`.
- The extension resolves mode from `pi.getFlag("fff-mode")`, then `PI_FFF_MODE`, then default `tools-and-ui`.
- Valid modes are `tools-and-ui`, `tools-only`, and `override`.
- In `override` mode, `resolveToolNames()` maps grep to `grep` and find to `find`.
- `pi-fff` grep output is currently text-oriented. Its returned details include aggregate counts such as `totalMatched` and `totalFiles`, not structured match rows.
- Grep text output groups rows under file headers. Match/context rows use line-number prefixes such as ` 11:` and ` 10-`.

## pi-hashline Facts

Source inspected: `packages/pi-hashline/src/hashline/index.ts` and `packages/pi-hashline/index.ts`.

Relevant facts:

- `pi-hashline` exports `initHasher`, `lineHashes`, and `HASH_SEP` from `src/hashline`.
- Existing read output uses the `HASH│content` format.
- Existing replace input accepts `hash_range_inclusive` anchors and `content_lines`.
- Aligning grep output with `HASH│content` lets grep results become direct replace anchors.

## Workspace Facts

Source inspected: `package.json` and `.trellis/spec/guides/hepi-mono-project-conventions.md`.

Relevant facts:

- The repository is a Bun workspace using `packages/*`.
- Publishable HEPI packages use the `@hheei/pi-*` name pattern.
- Extension package manifests should use `type: "module"`, `main: "src/index.ts"`, and `pi.extensions` entries pointing at TypeScript source.
- Root validation command is `bun run check`; focused tests use `bun:test` under package `test/` directories.
