# @hheei/hepi-skills

Self-contained HEPI skills bundle for Pi. Its published `dist` entry contains
Ponytail and Caveman behind one extension entry and one JIT boundary, and
includes Ponytail's skills for Pi resource discovery.

Included modules:

- `pi-ponytail`
- `pi-caveman`

Install it with:

```bash
pi install npm:@hheei/hepi-skills
```

Build locally with `bun run build` from this package or
`bun run build:aggregates` from the repository root. Do not install this
package together with `@hheei/hepi-mono`; the unified bundle already contains
these modules.
