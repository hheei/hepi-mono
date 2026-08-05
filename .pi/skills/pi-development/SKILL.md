---
name: pi-development
description: Use this project-only skill whenever a task involves developing, debugging, reviewing, or explaining Pi extensions, skills, packages, TUI components, tool renderers, session trees, lifecycle events, or the Pi SDK in this repository. Consult the pinned Pi source and versioned docs before relying on an upstream API, especially for streaming tools, reload behavior, extension context, or tree navigation.
compatibility: Requires the HEPI repository, Bun, and the local Pi source reference at references/pi (Pi v0.82.1).
---

# Pi Development

Use this skill for Pi implementation work inside `hepi-mono`. It is a project knowledge map, not a replacement for reading the relevant upstream contract. Pi is extensible without modifying its source, so prefer public APIs and a small HEPI adapter; use a compatibility bridge only when the task explicitly accepts private runtime coupling and document the version boundary.

## Establish the runtime first

Before making an API claim:

1. Read `package.json`, the affected package manifest, and `AGENTS.md`.
2. Check the runtime actually used by the task with `pi --version` and inspect the installed package declarations under `node_modules/@earendil-works/pi-coding-agent`.
3. Use `references/pi` for source-level evidence. It is pinned to Pi `v0.82.1` at commit `b4f293684bba718d59cc1157679bcf6157b3a7f5`.
4. If the installed version differs from the pin, treat the installed declarations and implementation as authoritative, record the difference, and avoid presenting the pinned source as current behavior.

The local source is read-only reference material. Do not edit it, vendor it under `packages/`, or import from it at runtime.

## Route the investigation

Read [DOCS_ROUTING.md](references/DOCS_ROUTING.md) first. It routes every Pi `coding-agent/docs/` document by problem type and names the matching source entry points and HEPI overlays. Then read the selected upstream document completely before inspecting the smallest source locations that implement its contract.

For HEPI behavior, then read the owning module under `packages/hepi-basics/src`, `packages/pi-ext-tools/src`, `packages/pi-mctx/src`, `packages/pi-ponytail/src`, `packages/pi-caveman/src`, or `packages/hepi-mono/src`. Shared contracts belong in Basics `core`; feature state machines and parsers stay in their feature module.

Read [ARCHITECTURE.md](references/ARCHITECTURE.md) when the task needs an overall Pi model, crosses package boundaries, or depends on whether a behavior is public API versus interactive-mode implementation detail.

## Contract rules

- Keep the Pi host as the owner of session state, agent state, transcript reconstruction, and tool execution. Extensions should coordinate through public `ExtensionAPI`/context contracts.
- Treat event registration as persistent across reload when Pi exposes no unregister API. HEPI lifecycle registration must use a stable key and runtime-scoped current-owner state so stale handlers become inert.
- Keep runtime state session-scoped and cleanup idempotent. A timer, process, UI component, watcher, or handler must have an owner and a cleanup path.
- Validate JSON, file, environment, extension payload, and third-party data at the boundary with `unknown` narrowing or the repository TypeBox contracts.
- Keep package boundaries intact: independent extensions publish their own `dist/extension.js`; static skills and themes are package resources, not runtime imports.

## Tool and TUI work

Distinguish the two Pi streaming paths:

- `renderCall(..., { argsComplete: false })` previews a tool argument prefix while the model is still producing it.
- `execute(..., onUpdate, ...)` publishes execution partial results, which Pi renders through `renderResult(..., { isPartial: true })` in the same tool row.

Argument previews are proposals, not results. They must not execute the tool, read target files, mutate disk, or enter session/model context. Scope transient parser state to the renderer context, reset it on argument replacement, and bound retained input and derived output. Narrow `context.state` from `unknown`; do not use an unbounded process-global cache.

For HEPI TUI changes:

- Follow `DESIGN.md` for visual roles, dimensions, ANSI safety, top/tail rails, and narrow layouts.
- Follow [Pi Source Design](references/DESIGN.md) for Pi's code-level design taste, state ownership, lifecycle, streaming, and integration boundaries. The repository-root `DESIGN.md` remains the HEPI TUI policy.
- Reuse `packages/hepi-basics/src/core/ui/` primitives before adding local geometry or formatting helpers.
- Test narrow and wide terminal dimensions, first render, selection changes, reload/session replacement, and cleanup.
- Use `packages/hepi-debug/TUI_REPLAY.md` and `pi-tui-replay` for deterministic component output, but verify host-dependent behavior in the real Pi host or a PTY before claiming a shortcut, event, streaming, or lifecycle feature works.

## Skills and Loadout

Project skills under `.pi/skills/` are local to this repository and are discovered after the project is trusted. Package skills under `pi.skills` are different: they are published resources and appear as `skill:<name>` entries.

When changing a skill:

1. Keep `SKILL.md` under 500 lines and put detailed contracts in `references/`.
2. Keep frontmatter `name` lowercase and hyphenated; make `description` state both capability and trigger context.
3. Use relative paths from the skill directory.
4. Do not assume a disabled Loadout skill disappears from explicit `/skill:<name>` invocation; disabled means excluded from automatic model prompt injection and HEPI `$skill` handling.
5. For external skill adaptations, preserve license and exact revision attribution.

## Verification and report

Prefer focused checks first, then the read-only checks for the affected scope:

```bash
bun test <focused-test-path>
bun run typecheck
bun run check
```

When reporting Pi findings, include:

- the installed Pi version and pinned source revision;
- the exact upstream and HEPI file/symbol locations inspected;
- the public contract versus any private compatibility assumption;
- lifecycle/cleanup and TUI-host verification status;
- tests run and any failures caused by unrelated existing worktree changes.
