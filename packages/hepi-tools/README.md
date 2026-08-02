# @hheei/hepi-tools

Self-contained HEPI tools bundle for Pi. Its published `dist` entry contains
the included tools and their HEPI dependencies behind one extension entry and
one JIT boundary.

Included modules:

- `pi-ask`
- `pi-goal`
- `pi-sshfs`
- `pi-codex-tool`
- `pi-advisor`
- `pi-todo`
- `pi-web-access`

Already-installed external packages use the following fallback names:

- `Web Search`: `web_search`, `fetch_content`, `get_search_content`, `source_check`

Other tools keep Loadout's automatic source-based grouping.

FFF-backed path completion and search are provided by `@hheei/pi-ext-tools`.

Install it with:

```bash
pi install npm:@hheei/hepi-tools
```

Build locally with `bun run build` from this package or
`bun run build:aggregates` from the repository root. Do not install this
package together with `@hheei/hepi-mono`; the unified bundle already contains
these modules.
