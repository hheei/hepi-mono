# @hheei/hepi-aft

HEPI-owned Pi adapter for [Agent File Tools](https://github.com/cortexkit/aft).
It uses the public `@cortexkit/aft-bridge` transport and registers AFT's Pi
tool surface:

- `read`, `write`, `edit`, and `bash`: AFT-backed replacements for Pi's
  built-in tools.
- `apply_patch`: AFT's multi-file patch protocol.
- `aft_safety`: AFT backup, undo, history, and named checkpoints.
- `aft_outline`: structural source and document outlines.
- `aft_zoom`: symbol and document-section inspection.
- `aft_callgraph`: callers, call trees, impact, and data-flow traces.
- `aft_refactor`: workspace symbol moves, extraction, and inlining.
- `aft_import`: language-aware import add, remove, and organization.
- `aft_inspect`: codebase health and structural analysis snapshot.

Install it as a separate Pi package:

```bash
pi install npm:@hheei/hepi-aft
```

On session start, the adapter resolves AFT `0.49.0`, migrates AFT storage when
needed, and starts an AFT bridge pool. A startup failure leaves the tools
registered but unavailable with an actionable tool error.

This package owns the same-name Pi slots. Do not combine it with the Codex
apply-patch tool: Pi has no tool unregister API, and registration order
otherwise decides the executor. `grep`, `find`, and `ls` remain outside AFT's
surface; AFT grep integration is deferred.

Tool parameters follow AFT, not Pi's legacy compatibility surface. In
particular, `read` keeps Pi's `path`, `offset`, and `limit`, and uses FFF path
resolution before calling AFT. A unique fuzzy path match is read automatically;
an ambiguous match returns candidates. `edit` uses AFT batch edits, bash
`timeout` is milliseconds, and `apply_patch` accepts:

```json
{"patchText":"*** Begin Patch\n...\n*** End Patch"}
```

`apply_patch` previews affected paths in the Pi tool row before applying. AFT
commits successful files or hunks independently; an incomplete result can leave
earlier changes on disk. HEPI records that result as a tool error, so the model
must read affected paths before retrying. Use AFT's safety/backup workflow to
undo those changes when backups are enabled.

`aft_safety` uses AFT's session-scoped backup store:

- `undo` reverts the latest AFT tool call; pass `path` to pop one file's latest snapshot.
- `history` lists snapshots for `path`.
- `checkpoint` and `restore` save or recover a named file set.
- `list` lists named checkpoints.

Undo has no redo operation. Per-file history is capped at 20 snapshots. `restore`
and whole-operation undo preview their affected paths before mutating files.

AFT reads its normal CortexKit `aft.jsonc` configuration tiers. The HEPI
adapter exposes `read`, `write`, `edit`, `apply_patch`, and `bash`; settings
which change registration ownership take effect on `/reload`. When composed
with HEPI FFF, FFF must skip its `read` registration so AFT remains the sole
owner of that slot.

Loadout keeps the Pi replacement slots `read`, `write`, `edit`, and `bash` in
the `built-in` group. AFT-only tools, including background bash controls,
`apply_patch`, `aft_safety`, and `aft_*` structural tools appear in `AFT`.

Do not install it together with an external `@cortexkit/aft-pi` extension: both
register overlapping tools.
