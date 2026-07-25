# @hheei/hepi-mono

Unified HEPI extension loader for Pi. It loads the current runtime extensions through one Pi entry, so Pi performs one JIT entry traversal instead of discovering each HEPI extension separately.

The loader keeps registration order: `pi-basics` first, then `pi-loadout`, followed by the remaining runtime modules. Development-only `pi-debug` is excluded. Individual `@hheei/pi-*` packages remain available for selective installs.

Install the unified package globally:

```bash
pi install npm:@hheei/hepi-mono
```

For local development:

```bash
pi install -l ./packages/hepi-mono
```

Do not install both `@hheei/hepi-mono` and the same individual HEPI packages in one Pi runtime; duplicate registration can cause duplicate commands, handlers, or status entries.
