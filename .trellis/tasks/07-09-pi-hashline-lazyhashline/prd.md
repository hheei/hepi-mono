# Build lazy hashline mode

## Goal

Implement the file-scoped lazy hashline algorithm described in `docs/lazyhashline.md` for `pi-hashline`. The new design supersedes the previous block-scoped hashline and standalone hashline-aware FFF grep plans.

The model-facing tool family is:

```text
read, grep, insert, edit
```

The core value is stable short anchors for observed/created lines without hashing the whole file upfront.

## Source Of Truth

- `docs/lazyhashline.md` is the primary design document for this task.
- Archived task `07-09-pi-hashline-block-mode` is deprecated and historical only.
- Archived task `07-09-pi-hashline-fff-grep` is deprecated and historical only.

## Background

Current `pi-hashline` eagerly hashes full files for hashline-aware editing. That gives strong file-wide anchors, but it is expensive for large files and sparse access patterns.

The lazy design changes the invariant:

```text
Only lines that have been observed by read/grep or created by insert/edit receive hashlines.
```

A hashline is a stable handle for an observed line in a specific canonical file. It is not a promise that every line in the file already has an anchor.

## Requirements

- Provide the model-facing tools `read`, `grep`, `insert`, and `edit`.
- Keep output rows as pure `HASH|content` / `HASH│content` style hashline rows with no block ID or visible version ID.
- Scope anchors to the canonical file path. User/display paths may vary, but internal lazy state must be keyed by canonical path so symlinks and relative paths do not create duplicate states.
- Preserve the original `pi-hashline` 3-character anchor length and 64-character 6-bit alphabet: `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_`.
- Reuse the original `pi-hashline` duplicate-avoidance idea: deterministic hash/probe retry on collision. Lazy mode changes only the uniqueness set to live anchors plus retired anchors for the canonical file.
- Maintain `lineToHash` and `hashToLine` as the authoritative inverse live-anchor mappings. `cacheSections` is a derived interval index and must remain consistent with those mappings.
- Never emit duplicate live hashlines within one canonical file state.
- Never reuse retired hashlines within one canonical file state.
- Reuse existing hashlines when the same observed canonical file line is later returned by `read` or `grep` while the file state remains valid.
- `read(file, startLine, length)` should hash only the requested range plus uncached observed lines needed for the output, not the whole file.
- `grep` must use FFF as backend. Fuzzy behavior is user-configurable; the algorithm must not restrict short queries or reinterpret fuzzy risk. It only marks returned lines correctly and preserves hashline state.
- `insert(file, beforeHashline, content)` inserts complete content lines at the start of the target line. `insert(file, -1, content)` inserts at EOF.
- `edit(file, changes[])` may support multiple changes in one call. All changes resolve against the initial file state, not intermediate states from earlier changes in the same call.
- Multi-edit must reject overlapping initial ranges. Non-overlapping byte spans must be applied from the end of the file toward the start.
- Edit ranges may cross unseen lines. Unseen lines have no hashline bookkeeping; the tool only retires known live hashlines in affected ranges.
- Replacement and inserted lines receive fresh hashlines.
- Unchanged observed lines keep their hashlines and move by the cumulative line-count deltas of prior edits.
- For `read` and `grep`, stale `fileSerial` invalidates the old lazy state and may build a fresh state from current file content.
- For `edit` and `insert` by hashline, stale `fileSerial` must reject the operation and require fresh `read` or `grep` output.
- Optional stronger safety may verify cached-section or edit-boundary checksums, but the design must not require full-file checksum work on every operation.
- Persisted state, if enabled, must store only lazy bookkeeping: canonical path, serial, cache sections, live mappings, retired hashes, salt/allocId, and optional section checksums. It must not store the original full-file `content + hashes` snapshot shape.
- Use a per-canonical-file lock for `read`, `grep`, `insert`, `edit`, and persisted state load/save so same-file state cannot race.
- State mutation should be prepared in memory first. The file content is written atomically, then the implementation refreshes `fileSerial`, commits the new lazy state, and persists it.
- If file write or persistence fails, the implementation must not leave persisted lazy state claiming to describe content that was not successfully written.

## Out Of Scope

- Reviving the block-scoped `bread`/`breplace`/`bgrep` tool family.
- Implementing standalone hashline-aware FFF grep separate from lazy hashline state.
- Fuzzy result safety policy, short-query restrictions, or model behavior controls. Those are prompt/settings concerns, not core algorithm responsibilities.
- Exact relocation or diff refresh after external file modification in v1. Stale serial clears state for read/grep and rejects hashline-based edit/insert.
- Full-file hash snapshot persistence for lazy state.

## Acceptance Criteria

- [x] The old hashline rewrite tasks are archived/deprecated and no longer active planning children.
- [x] `docs/lazyhashline.md` remains the authoritative design reference for this task.
- [x] PRD defines the model-facing tool family as `read`, `grep`, `insert`, and `edit`.
- [x] PRD records that lazy anchors are canonical-file scoped and only assigned to observed or newly created lines.
- [x] PRD records that hash allocation reuses the original pi-hashline 3-character 6-bit alphabet and deterministic duplicate-avoidance strategy, with uniqueness checked against live plus retired anchors for the canonical file.
- [x] PRD defines `read` and `grep` lazy state extension behavior, including FFF-backed grep with user-configurable fuzzy behavior.
- [x] PRD defines `insert` semantics: target hashline means insert at target line start, and `-1` means EOF.
- [x] PRD defines `edit` multi-change semantics: resolve all changes against the initial file state, reject overlap, apply non-overlapping spans from end to start.
- [x] PRD records stale serial policy: read/grep can discard and rebuild state; edit/insert-by-hash reject and require fresh anchors.
- [x] PRD records canonical path keying, per-file locking, semi-persistent lazy bookkeeping, and atomic write/state commit order.
- [x] Implementation plan, before `task.py start`, includes focused validation for duplicate-anchor prevention, retired-anchor non-reuse, multi-edit shifting, stale serial handling, canonical path aliases, and same-file concurrency.
