# @hheei/hepi-mono

> **Deprecated.** Do not use this package for new installations. HEPI is moving
> to independently installable extensions backed by `@hheei/pi-ext-core`.

Self-contained unified HEPI bundle for Pi. Its published `dist` entry contains
the basics, tools, skills, BTW, and Plan implementations, so Pi performs one
JIT entry traversal instead of discovering each HEPI extension separately.

The bundle keeps registration order: `pi-basics` first, then `pi-loadout`, the
remaining basics, tools, skills, BTW, and Plan modules. `hepi-debug` is excluded.
It receives no new features.
