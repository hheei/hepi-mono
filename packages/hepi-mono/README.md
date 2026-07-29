# @hheei/hepi-mono

Self-contained unified HEPI bundle for Pi. Its published `dist` entry contains
the basics, tools, skills, BTW, and Plan implementations, so Pi performs one
JIT entry traversal instead of discovering each HEPI extension separately.

The bundle keeps registration order: `pi-basics` first, then `pi-loadout`, the
remaining basics, tools, skills, BTW, and Plan modules. `hepi-debug` is excluded. The aggregate bundles are the supported runtime
installation units; top-level `pi-*` feature packages are deprecated.

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

The full bundle keeps `ffi-rs` as a platform runtime dependency for `pi-fff`;
its native binary cannot be embedded in a portable JavaScript bundle.

Included themes:

- `catppuccin-latte`
- `catppuccin-mocha`

Do not install both `@hheei/hepi-mono` and a group package in one Pi runtime;
duplicate registration can cause duplicate commands, handlers, or status entries.
