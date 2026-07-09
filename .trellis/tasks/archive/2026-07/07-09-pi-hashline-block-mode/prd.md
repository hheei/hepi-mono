# Build block-scoped hashline mode

## Deprecated

This task is deprecated. The block-scoped `bread`/`breplace`/`bgrep` design has been superseded by the file-scoped lazy hashline plan in `docs/lazyhashline.md` and the new `pi-hashline-lazyhashline` Trellis task. Keep this file as historical design context only; do not start implementation from this task.

# Build block-scoped hashline mode

## Goal

Plan a new `pi-hashline` mode where `read` and `grep` return writable blocks instead of file-global hash anchors. A `replace` call targets a block ID plus block-local anchors, while the extension internally knows the file path, block range, snapshot/version, and anchor mapping.

This is a new separate tool family, not a small extension of the current file-global hashline contract. The planned tool names are `bread`, `breplace`, and `bgrep`.

## User Proposal

Output shape example:

```text
AB|01
aK9|line 1 content
p2Q|line 2 content
Zx7|line 3 content
```

Meanings:

- `AB`: 2-character block ID, unique within the active block store.
- `01`: block version, shown in output for orientation/debugging and used internally, but not required as a replace argument.
- `aK9` / `p2Q` / `Zx7`: 3-character anchors that are unique only inside block `AB`.

Replace call should be minimal for the model:

```json
{
  "block_id": "AB",
  "from": "p2Q",
  "to": "p2Q",
  "content_lines": ["new line", "inserted line"]
}
```

The model should not need to pass file path, file ID, file snapshot ID, or block version. `block_id` is the stable handle for the internal file binding and current block state.

## Background Evidence From Current Code

- `packages/pi-hashline/src/read.ts` currently always reads the full text file through `readNormFile()`, computes all file hashes with `lineHashes(normalized, absolutePath)`, then slices output by `offset`/`limit`.
- `packages/pi-hashline/src/replace.ts` currently accepts `path + changes[]`, reads and hashes the full file via `readNormFile()`, resolves `hash_range_inclusive` against the file-global `fileHashes`, applies edits, computes stable result hashes, and writes atomically.
- `packages/pi-hashline/src/hashline/resolve.ts` assumes anchors are file-global: `resAnchor()` scans the full `fileHashes` array and rejects not-found or ambiguous anchors.
- `packages/pi-hashline/src/hashline/apply.ts` contains reusable lower-level edit application logic once line spans are resolved; the block mode would replace anchor resolution, not necessarily all edit application code.
- Current prompt/schema normalization in `replace-normalize.ts` is built around `hash_range_inclusive` and would need a new mode/schema for `block_id/from/to/content_lines`.
- Current strict semantics reject fuzzy relocation and stale anchors. Block mode should preserve strict rejection, but the stale unit becomes a block snapshot/version rather than a file-global hash lookup.

## Proposed New Mode

### Block Creation

`bread` creates one or more writable blocks for the returned visible range. `bgrep` creates blocks for grouped match/context output. Blocks are stored internally with:

- `blockId`: 2-character ID.
- `version`: internal/displayed version that increments after successful block writes.
- `path`: absolute/canonical file path, hidden from the model in replace calls.
- `lifetime`: block records are session-only; block IDs expire when the Pi session ends.
- `fileSnapshot`: internal snapshot data used for stale validation; not a user-facing argument.
- `startLine` / `endLine`: block range in the file at creation time.
- local anchors: 3-character anchors unique inside the block.
- retired anchors: local anchors that were deleted/replaced and should not be reused for that block.

### Replace Contract

`breplace` in block mode should take only:

- `block_id`
- `from`
- `to`
- `content_lines`

The tool internally loads the block, validates current file state against the stored block state, resolves `from`/`to` inside that block, maps the block-local range to the real file range, applies the edit atomically, and updates the block version plus local anchors. The model does not pass version.

### Output After Replace

After successful replace, keep the same `block_id` and increment version internally. Deleted/replaced anchors move to the retired set. Unchanged lines in the block keep their local anchors. Inserted/changed lines receive new local anchors.

By default, `breplace` should mirror the current `replace` user experience: success returns a bounded changed interval / contextual diff, not the whole block. The diff should be block-local: include the block header/version and use local anchors on context, removed, and added rows. Removed anchors shown in the diff are retired and cannot be used for later edits; added/context rows use current live anchors. If the model needs the full current block and all updated anchors, it should call `bread(block_id)`. Errors and warnings may still return actionable block output.

## Initial Invariants

1. Anchor uniqueness is block-local, not file-global.
2. Live anchors must not duplicate inside one block.
3. Retired anchors should not be reused within the same block lifetime.
4. Unchanged lines inside a block keep their local anchors after block-local edits.
5. Replaced/deleted anchors enter the retired set.
6. Newly inserted lines receive fresh local anchors.
7. Replace can only target anchors from returned/stored blocks.
8. `from` and `to` anchors must belong to the same continuous block segment.
9. Successful replace keeps the same `block_id` and increments the block version.
10. If the block snapshot/version does not match the current file state, reject and require refreshing the block.
11. The model should not pass file path, file ID, or file snapshot ID for block replace; `block_id` is sufficient.
12. Tool errors, not prompt wording, should enforce maximum block size and unsupported ranges.
13. `bread(block_id)` should refresh/re-read the same logical block after modification and return updated block output. If the block can be exactly relocated, refresh should preserve local anchors for unchanged lines by diffing old block content against current block content; changed/new lines receive fresh anchors and removed anchors are retired.
14. Spatially adjacent `read` blocks may be merged internally to reduce boundary-edit mistakes.
15. `grep` and `read` should not automatically share block IDs because their workflows differ, but `grep` may merge nearby matches into larger balanced blocks.
16. Block records are session-only and should be garbage-collected with an LRU policy when the active block store exceeds its memory/count budget. Block IDs are not reused within the same session; if the 2-character ID space is exhausted, the tool returns an explicit error.

## Design Questions To Resolve

### 1. Stale Validation Granularity

The simplest strict model validates the whole file snapshot before applying a block edit. Any file change makes the block stale. This is safer and simpler, but more conservative than current file-global stable anchors.

A more advanced model validates only the block's original byte/line range, maybe with surrounding boundary context. This would survive unrelated edits elsewhere in the file but requires relocation or range reconciliation logic.

Decision: v1 should use block-range validation instead of whole-file snapshot validation. The block stores its original range content plus boundary context and validates that the targeted block segment still matches before applying a replace. This allows unrelated edits elsewhere in the file to coexist with block-local edits.

Decision: if content before the block shifts the original byte/line offset, v1 should attempt exact relocation by searching for the stored block content plus boundary context. Relocation succeeds only when there is exactly one unambiguous match. Zero matches or multiple matches are stale/ambiguous errors and require a fresh read. Fuzzy relocation remains out of scope.

### 2. Block Size And Anchor Capacity

A 3-character local anchor has `64^3 = 262,144` possible values, so capacity is not tight. Still, block output should be bounded for model context and tool safety. Do not rely on prompt instructions only; enforce a tool-side maximum.

Decision: a single read/grep block creation request may return at most 2000 lines. Adjacent block merging may create a larger logical block over time, bounded by the 3-character local anchor capacity and retired-anchor pressure rather than the per-request 2000-line limit. If a new request exceeds the per-request limit, the tool returns a clear error and suggests reading a smaller range.

### 3. Cross-Block Replace

Allowing a replace from anchors in two different blocks can support larger edits but weakens safety and complicates overlap/ordering validation.

Decision: v1 rejects cross-block replace. A replace call may only use `from` and `to` anchors from the same block. If a workflow needs a larger range, the model should refresh/read/merge into a single block first. Cross-block replace can be reconsidered after block relocation and merge semantics are proven safe.

### 4. Block Merging

Adjacent `read` blocks can be merged internally to reduce boundary edit errors. `grep` may also merge nearby match/context ranges in one file into a larger block, but should not merge with unrelated `read` blocks automatically.

Decision: v1 auto-merges only same-file, same-source blocks that overlap or are directly adjacent. It does not merge across gaps. `read` blocks merge with `read` blocks, and `grep` blocks merge with `grep` blocks; read/grep block records remain distinct unless explicitly refreshed by a later operation.

### 5. Line Numbers In Grep Output

Original hashline-aware grep planning avoided normal line numbers. In block mode, grep may need line numbers if the model must understand global location. But if block replace uses only block-local anchors and block refresh, normal line numbers are optional metadata, not edit locators.

Decision: `read` block rows should not include line numbers. `grep` may include start line or line range metadata in each block/interval header, for example `AB|01 L120-L128`, while preserving pure `anchor|content` rows. Line numbers are navigation metadata only, not edit locators.

## Requirements

- Add block-scoped hashline as a new tool family, not as a replacement for existing file-global `read`/`replace`. Use tool names `bread`, `breplace`, and `bgrep`.
- Use 2-character block IDs and 3-character block-local anchors.
- Keep file path, file snapshot details, and block version internal; model-facing replace should use `block_id + from/to + content_lines`.
- Support `bread(block_id)` or equivalent block refresh to get updated output for a previously returned block. Refresh should preserve unchanged local anchors where possible, using block-local diffing rather than file-global hashing.
- Enforce block size/capacity limits in tool validation, not only prompt text: max 2000 lines per block creation request; merged blocks may exceed this but cannot exceed local-anchor allocation capacity.
- Preserve strict semantics: stale or mismatched blocks must fail clearly rather than fuzzy-relocating edits. Block-range validation and exact relocation are in scope; relocation may only succeed on one deterministic match.
- Keep `read` and `grep` block workflows distinct. Auto-merge only same-file, same-source blocks that overlap or are directly adjacent; `grep` block headers may include line range metadata while row anchors remain block-local edit locators.
- Reject cross-block replace in v1; both `from` and `to` must belong to the same block.
- Store block records in memory for the current session only; block IDs are not stable across sessions. Use LRU GC for inactive block records when store limits are reached, but do not reuse block IDs within the same session.

## Acceptance Criteria

- [x] PRD defines the block mode wire format for output and replace input, and records tool names `bread`, `breplace`, and `bgrep`.
- [x] PRD records that `fileSnapshotId`, file path, and block version are internal, not model-facing replace arguments.
- [x] PRD defines stale validation strategy for v1: block-range validation with exact relocation on a unique block/boundary match.
- [x] PRD defines cross-block replace as out of scope for v1; replace must target a single block.
- [x] PRD defines block size/capacity limits as tool-enforced behavior: max 2000 lines per new block creation request; merged blocks bounded by local-anchor capacity.
- [x] PRD defines read refresh behavior by block ID: exact relocation plus block-local diff preserving unchanged anchors where possible.
- [x] PRD defines block merging behavior: same-file, same-source overlap/adjacent blocks may merge; no small-gap merge in v1.
- [x] PRD defines line-number policy: read rows omit line numbers; grep may include line range metadata in block headers only.
- [x] PRD records how block mode relates to the existing file-global hashline mode: separate tools, no change to existing read/replace behavior.
- [x] PRD records block store lifetime: session-only, not persisted to disk, with LRU GC for inactive block records and no block ID reuse within a session.

## Out Of Scope For Initial Brainstorm

- Implementing block mode immediately.
- Removing or changing the existing file-global hashline `read`/`replace` mode.
- Committing to cross-block replace before stale/range validation is fully designed.

## Session Addendum: Lazy File-Scoped Hashline Brainstorm

The session also captured a related but distinct design direction in `docs/lazyhashline.md`: a file-scoped lazy hashline algorithm with model-facing tools `read`, `grep`, `insert`, and `edit`. This is not the same as the block-scoped `bread`/`breplace`/`bgrep` plan above.

Confirmed decisions for the lazy design:

- The algorithm's responsibility is internal correctness: stable hashlines for observed/created lines, correct output, consistent state transitions, and clear stale-state failure. Model or user choices around fuzzy search, relaxed safety, or edits across unseen gaps are policy risks controlled by prompts/settings, not core algorithm defects.
- `insert` replaces the earlier `append` naming. `insert(file, beforeHashline, content)` inserts at the target line start; `insert(file, -1, content)` inserts at EOF.
- `grep` uses FFF as backend and exposes user-configurable fuzzy behavior. The algorithm does not restrict short queries or second-guess fuzzy result risk; it only marks returned lines correctly and preserves hashline state.
- `edit` may support multiple changes in one call. All changes resolve against the initial file state, overlap is rejected, and non-overlapping byte spans are applied from the end of the file toward the start.
- Lazy state is keyed by canonical path. Display/input paths may vary, but they must not create duplicate file states for the same target file.
- Concurrency should use a per-canonical-file lock so `read`, `grep`, `insert`, `edit`, and persisted state writes cannot race for one file.
- External modification handling for v1 should be simple: if file serial is stale, clear the affected file state and require fresh `read` or `grep`; do not implement relocation/diff refresh initially.
- Persistence may be semi-persistent to disk, but should store lazy bookkeeping only (`cacheSections`, live mappings, retired hashes, salt/allocId, serial, optional section checksums), not the original pi-hashline full-file `content + hashes` snapshot shape.
- Hash allocation should directly reuse the original pi-hashline duplicate-avoidance idea: 3-character anchors over the 64-character 6-bit alphabet, deterministic retry/probe on collision, with uniqueness checked against lazy live anchors plus retired anchors for that canonical file.
