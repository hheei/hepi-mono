# @hheei/hepi-mono

Self-contained unified HEPI bundle for Pi. Its published `dist` entry contains
the basics, tools, skills, BTW, and Plan implementations, so Pi performs one
JIT entry traversal instead of discovering each HEPI extension separately.

The bundle keeps registration order: `pi-basics` first, then `pi-loadout`, the
remaining basics, tools, skills, BTW, and Plan modules. Development-only
`pi-debug` is excluded. Individual `@hheei/pi-*` packages and the three group
packages remain available for selective installs.

Install the unified package globally:

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

Do not install both `@hheei/hepi-mono` and the same individual HEPI packages in one Pi runtime; duplicate registration can cause duplicate commands, handlers, or status entries.
