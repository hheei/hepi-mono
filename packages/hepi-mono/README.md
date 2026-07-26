# @hheei/hepi-mono

Unified HEPI extension loader for Pi. It loads the basics, tools, and skills
groups through one Pi entry, so Pi performs one JIT entry traversal instead of
discovering each HEPI extension separately. It also keeps the existing BTW and
Plan modules in the full profile.

The loader keeps registration order: `pi-basics` first, then `pi-loadout`, the
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

Do not install both `@hheei/hepi-mono` and the same individual HEPI packages in one Pi runtime; duplicate registration can cause duplicate commands, handlers, or status entries.
