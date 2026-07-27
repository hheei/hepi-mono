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

Loadout groups are registered explicitly for the bundled external tools:

- `Magic Context`: `ctx_search`, `ctx_memory`, `ctx_note`
- `Web Search`: `web_search`, `fetch_content`, `get_search_content`, `source_check`
- `FFF`: `find`, `grep`, `multi_grep`, `fffind`, `ffgrep`, `fff-multi-grep`,
  `find_files`, `resolve_file`, `related_files`, `fff_grep`, `fff_multi_grep`

Other tools keep Loadout's automatic source-based grouping.

The Magic Context package is bundled from its published `@cortexkit` package.
When `pi-fff`, `pi-web-access`, or `@cortexkit/pi-magic-context` is already
listed in the global Pi package settings, this group reuses that separately
installed extension and skips its bundled copy so the same tools are not
registered twice.

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
