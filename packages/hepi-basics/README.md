# @hheei/hepi-basics

Self-contained foundational HEPI bundle for Pi. Its published `dist` entry
contains the implementation of `pi-basics`, Loadout, and the remaining
foundational runtime modules behind one extension entry and one JIT boundary.

Included modules:

- `pi-basics`
- `pi-loadout`
- `pi-rtk`
- `pi-dollar-skill`
- `pi-fix`
- `pi-t2s`
- `pi-auto-title`

Install it with:

```bash
pi install npm:@hheei/hepi-basics
```

Build locally with `bun run build` from this package or
`bun run build:aggregates` from the repository root.

Do not install it together with `@hheei/hepi-mono`; the unified bundle already
includes it.
