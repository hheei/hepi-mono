# @hheei/hepi-tools

Self-contained HEPI tools bundle for Pi. Its published `dist` entry contains
the included tools and their HEPI dependencies behind one extension entry and
one JIT boundary.

Included modules:

- `pi-ask`
- `pi-goal`
- `pi-sshfs`
- HEPI FFF
- `pi-advisor`
- `pi-todo`
- `pi-web-access`

When `@hheei/hepi-subagents` creates a child session, Tools automatically
disables `ask`, `goal`, `todo`, and Advisor. SSHFS, FFF search, and Web Access
remain available so a child can still inspect, research, and modify its task.

Loadout groups are registered at each tool extension boundary, so an aggregate
bundle keeps ownership with the extension that declared each tool. HEPI FFF
replaces the built-in `find` and `grep` slots; Loadout keeps those
overrides in the `built-in` group rather than creating an FFF group.
Already-installed external packages use the following fallback names:

- `Web Search`: `web_search`, `fetch_content`, `get_search_content`, `source_check`

Other tools keep Loadout's automatic source-based grouping.

HEPI FFF provides `@path` completion, `find`, `fff_multi_grep`, and FFF-backed
grep. It composes through Pi's autocomplete-provider chain and
does not install a custom editor, so it remains compatible with Pi Basics
statusbar and `$skill` input behavior. Configure its feature flags with
`/fff-features`. AFT owns `read`; FFF owns `find` and `grep`.
`grep` accepts `timeout` in seconds; it defaults to 30 seconds.
FFF initializes and scans on its first search or autocomplete request, not on
every Pi session start.

`sshfs` is required before reading or writing files on a remote SSH host; it
mounts the remote root under `~/.cache/sshfs-addon/`. Use `read`, then
`edit`, `write`, or `apply_patch` when available on the returned mount path.
`find` and `grep` are project-indexed, so search a mounted host through its SSH
shell instead, for example `ssh host -- find ...` or `ssh host -- grep ...`.

Do not also configure the standalone `pi-fff` package. Pi cannot unregister
extension registrations, and its custom editor conflicts with HEPI FFF's
provider-based integration.

HEPI FFF keeps `ffi-rs` as a platform runtime dependency because its native
binary cannot be embedded in a portable JavaScript bundle. Its adapted upstream
attribution is in `THIRD_PARTY_NOTICES.md`.

Install this bundle directly:

```bash
pi install npm:@hheei/hepi-tools
```

Build locally with `bun run build` from this package or
`bun run build:aggregates` from the repository root. Do not install this
package together with `@hheei/hepi-mono`; the unified bundle already contains
these modules.
