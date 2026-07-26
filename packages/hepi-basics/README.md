# @hheei/hepi-basics

Single-entry foundational HEPI group for Pi. It loads `pi-basics` first, then
Loadout and the remaining foundational runtime modules through one extension
entry and one JIT boundary.

Included packages:

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

Do not install it together with the same individual packages or with a full
HEPI aggregate that already includes it.
