# @hheei/hepi-tools

Self-contained HEPI tools bundle for Pi. Its published `dist` entry contains
the included tools and their HEPI dependencies behind one extension entry and
one JIT boundary.

Included modules:

- `pi-ask`
- `pi-goal`
- `pi-sshfs`
- HEPI FFF
- `pi-codex-tool`
- `pi-advisor`
- `pi-todo`
- `@cortexkit/pi-magic-context`
- `pi-web-access`

Loadout groups are registered at each tool extension boundary, so an aggregate
bundle keeps ownership with the extension that declared each tool. HEPI FFF
declares `find_files` and `fff_multi_grep`; its optional built-in overrides are
also retained in the FFF Loadout group. Already-installed external packages use
the following fallback names:

- `Magic Context`: `ctx_search`, `ctx_expand`, `ctx_memory`, `ctx_note`,
  `ctx_reduce`, `todowrite`
- `Web Search`: `web_search`, `fetch_content`, `get_search_content`, `source_check`

Other tools keep Loadout's automatic source-based grouping.

The Magic Context package is bundled from its published `@cortexkit` package.
When `pi-web-access` or `@cortexkit/pi-magic-context` is already listed in the
global Pi package settings, this group reuses that separately installed
extension and skips its bundled copy so the same tools are not registered
twice.

HEPI FFF provides `@path` completion, `find_files`, `fff_multi_grep`, and FFF
enhancements for Pi's built-in read and grep tools. Loadout places the related
built-in `find` beside those four tools, though HEPI FFF does not replace its
execution. It composes through Pi's autocomplete-provider chain and does not
install a custom editor, so it remains compatible with Pi Basics statusbar and
`$skill` input behavior. Configure its feature flags with `/fff-features`.

Do not also configure the standalone `pi-fff` package. Pi cannot unregister
extension registrations, and its custom editor conflicts with HEPI FFF's
provider-based integration.

HEPI FFF keeps `ffi-rs` as a platform runtime dependency because its native
binary cannot be embedded in a portable JavaScript bundle. Its adapted upstream
attribution is in `THIRD_PARTY_NOTICES.md`.

Install it with:

```bash
pi install npm:@hheei/hepi-tools
```

Build locally with `bun run build` from this package or
`bun run build:aggregates` from the repository root. Do not install this
package together with `@hheei/hepi-mono`; the unified bundle already contains
these modules.
