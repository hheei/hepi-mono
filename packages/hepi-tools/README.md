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
- `pi-web-access`

Loadout groups are registered at each tool extension boundary, so an aggregate
bundle keeps ownership with the extension that declared each tool. HEPI FFF
replaces the built-in `find`, `read`, and `grep` slots; Loadout keeps those
overrides in the `built-in` group rather than creating an FFF group.
Already-installed external packages use the following fallback names:

- `Web Search`: `web_search`, `fetch_content`, `get_search_content`, `source_check`

Other tools keep Loadout's automatic source-based grouping.

HEPI FFF provides `@path` completion, `find`, `fff_multi_grep`, and FFF-backed
read and grep tools. It composes through Pi's autocomplete-provider chain and
does not install a custom editor, so it remains compatible with Pi Basics
statusbar and `$skill` input behavior. Configure its feature flags with
`/fff-features`. A composition that loads AFT must register FFF with its read
slot disabled, leaving FFF to own `find` and `grep` while AFT owns `read`.
`grep` accepts `timeout` in seconds; it defaults to 30 seconds.

Do not also configure the standalone `pi-fff` package. Pi cannot unregister
extension registrations, and its custom editor conflicts with HEPI FFF's
provider-based integration.

HEPI FFF keeps `ffi-rs` as a platform runtime dependency because its native
binary cannot be embedded in a portable JavaScript bundle. Its adapted upstream
attribution is in `THIRD_PARTY_NOTICES.md`.

Git releases include this bundle through `hepi-mono`:

```bash
pi install git:github.com/hheei/hepi-mono@<tag>
```

Build locally with `bun run build` from this package or
`bun run build:aggregates` from the repository root. Do not install this
package together with `@hheei/hepi-mono`; the unified bundle already contains
these modules.
