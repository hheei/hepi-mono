# @hheei/hepi-tools

Self-contained HEPI tools bundle for Pi. Its published `dist` entry contains
the included tools and their HEPI dependencies behind one extension entry and
one JIT boundary.

Included modules:

- `pi-ask`
- `pi-goal`
- `pi-sshfs`
- `pi-fff`
- `pi-codex-tool`
- `pi-advisor`
- `pi-todo`
- `@cortexkit/pi-magic-context`
- `pi-web-access`

The Magic Context package is bundled from its published `@cortexkit` package.
The optional upstream submodule remains available for development and is not
loaded automatically by this group.

`pi-fff` keeps `ffi-rs` as a platform runtime dependency because its native
binary cannot be embedded in a portable JavaScript bundle.

Install it with:

```bash
pi install npm:@hheei/hepi-tools
```

Build locally with `bun run build` from this package or
`bun run build:aggregates` from the repository root. Do not install this
package together with `@hheei/hepi-mono`; the unified bundle already contains
these modules.
