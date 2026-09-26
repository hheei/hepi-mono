# @hheei/pi-ext-tools

Canonical owner for Pi `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`,
`list_tasks`, `wait_tasks`, `stop_tasks`, strict Codex V4A `apply_patch`,
opt-in `eval`, and `todo`.
Todo includes `/todos`, task scheduling, reminders, and the editor widget.
`apply_patch` matches and rewrites text in pure
JavaScript with jsdiff; it never requires a user-managed executable or a package-owned
native addon. `@hheei/pi-ext-core` is a production dependency, not a separately loaded
Pi extension. Install `@hheei/pi-settings` separately for the Settings and Loadout UI.

FFF runtime, commands, autocomplete, and enhancement settings are included;
`fff_multi_grep` is not registered as a model tool.

## apply_patch

`createApplyPatchTool()` still owns `APPLY_PATCH_PARAMETERS`, `parseV4aPatch()`, and
streaming call preview. Input remains one Codex V4A envelope:

- first line `*** Begin Patch`, last line `*** End Patch`
- files are `*** Add File` / `*** Update File` / `*** Delete File` sections in that
  same string, with optional `*** Move to` and `*** End of File`
- extra Begin/End markers stay ignored; markdown fences around the envelope are stripped

The tool does not accept unified diff as a second model input, does not invent Git
patches from surrounding prose, and does not let jsdiff headers choose paths. Paths
come only from the parsed V4A operation. jsdiff consumes an internally compiled
single-file, single-hunk unified diff whose path is the fixed staging name
`__apply_patch_target__`.

Successful hunks in an Update may Publish; failed hunks are reported separately.
Confirmed paths are never rolled back. There is no request-wide dry-apply
transaction. Absolute paths, relative paths, and out-of-workspace write warnings
keep the existing `PatchFs` / `assertPatchPath()` / `resolvePatchPath()` / Publish
rules; this is not a workspace sandbox.

Matching is strict by default (`applyPatch.fuzzFactor: 0` in `ext_settings.json`). A global setting
may set `fuzzFactor` to the integer `2`. Project extension settings may only lower
that value, never raise it above global (missing global is 0). `fuzzFactor` is
jsdiff's line-edit context tolerance, not a similarity score and not a maximum
line offset. jsdiff still searches for an offset at `fuzzFactor: 0`; deleted lines
must match, and context immediately around insertions stays exact. Duplicate exact
candidates are always rejected, including when fuzzy is on. Fuzzy uses jsdiff
first-fit and does not promise fuzzy ambiguity detection.

Each Update runs in one short-lived worker thread for all of that file's hunks.
The worker is memory-only: no staging directory, no native process, no retry pool.
Cancellation `terminate()`s that worker. Files stay capped at 32 MiB.

SSH Targets still read bytes locally through `createSftpPatchFs()`, compute on
this host, and Publish through the existing transport. The remote host does not
need Node or jsdiff.

Old `minSimilarity`, `maxConcurrentWorkers`, and `maxQueueDepth` keys are
unsupported and must be removed; they are not mapped to `fuzzFactor`.

## bash

`bash` runs one shell command or short pipeline. It keeps ordinary foreground
execution and the existing local `async: true` job path. Remote `target` is an
authorized SSH host; omit `async`. Working directory on SSH is the remote home.
`output` remains unsupported.

Third-party native packages such as `@ff-labs/fff-node` are unrelated to this
patch/bash runtime.
