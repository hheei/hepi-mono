# @hheei/hepi-mono

Unified HEPI package for Pi. Its published `dist` entry contains the Basics,
Tools, Skills, BTW, and Plan implementations, and composes the AFT, Magic
Context, and Subagents package entries at runtime.

The bundle keeps registration order: `pi-basics` first, then `pi-loadout`, the
remaining Basics and Tools modules, AFT, Magic Context, Subagents, Skills, BTW,
and Plan. This includes `agent`, `get_subagent_result`, and `steer_subagent`.
`hepi-debug` is excluded.

Install the unified package:

```bash
pi install npm:@hheei/hepi-mono
```

For local development:

```bash
pi install -l ./packages/hepi-mono
```

Build first with `bun run build` from this package or
`bun run build:aggregates` from the repository root.

The package installs `@hheei/hepi-aft`, `@hheei/hepi-mctx`, and
`@hheei/hepi-subagents` as runtime dependencies. It also keeps `ffi-rs` as a
platform runtime dependency for `pi-fff`; its native binary cannot be embedded
in a portable JavaScript bundle.

Included themes:

- `catppuccin-latte`
- `catppuccin-mocha`

Do not install both `@hheei/hepi-mono` and a group package in one Pi runtime;
duplicate registration can cause duplicate commands, handlers, or status entries.
