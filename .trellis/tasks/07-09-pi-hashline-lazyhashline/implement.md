# Lazy hashline implementation plan

## Branch

Work inside the independent `packages/pi-hashline` git repository.

```bash
git -C packages/pi-hashline checkout -b feat/lazyhashline
```

Do not create a root repo branch for this task unless explicitly requested; the root worktree has unrelated Trellis planning changes.

## Ordered Steps

1. Baseline inspection
   - Confirm `packages/pi-hashline` status is clean.
   - Run or inspect the current test suite shape.
   - Identify current registration flow in `index.ts`, `src/read.ts`, `src/replace.ts`, `src/config.ts`, `src/hash-store.ts`, and `src/hashline/*`.

2. Lazy state primitives
   - Add lazy state types and interval helpers.
   - Add canonical path state lookup using `resolveTarget()`.
   - Add per-canonical-file lock/queue.
   - Add serial helpers using stat metadata.
   - Add invariant checks/rebuild for `lineToHash`, `hashToLine`, and `cacheSections`.

3. Hash allocator
   - Reuse the pi-hashline 3-character 6-bit alphabet and deterministic retry logic from `src/hashline/hash.ts`.
   - Expose a focused allocator function that checks candidates against `hashToLine` plus `retiredHashes`.
   - Add tests for repeated identical lines, live collision avoidance, and retired non-reuse.

4. Lazy read
   - Update `read` to extend lazy state for the requested range only.
   - Preserve file-kind validation and binary/image behavior.
   - Preserve pagination/truncation behavior where compatible.
   - Add tests that a partial read does not allocate full-file hashes and repeated reads reuse anchors.

5. Lazy insert
   - Add/register `insert` tool.
   - Implement insert before hashline and EOF insert.
   - Reject stale serial for hashline insert.
   - Shift observed mappings at/after insertion point.
   - Add tests for EOF insert, before-line insert, fresh hashes, and shifted unchanged anchors.

6. Lazy edit
   - Add/register `edit` tool or migrate the existing replace pipeline to the new model-facing name.
   - Resolve all changes against initial `hashToLine`.
   - Reject overlaps before applying.
   - Apply byte spans from end to start.
   - Retire known hashes in affected ranges and allocate fresh replacement hashes.
   - Rebuild derived `cacheSections` from live mappings.
   - Add tests for multi-edit shifting, unseen gap replacement, overlapping reject, and stale serial reject.

7. Lazy persistence
   - Add a lazy store shape distinct from existing full-file `content + hashes` snapshots.
   - Persist only lazy bookkeeping.
   - Use atomic write for lazy store if persisted.
   - Add tests or focused assertions that persisted lazy state does not include full file content.

8. FFF-backed grep
   - Add `@ff-labs/fff-node` dependency if not already present.
   - Reuse/adapt `packages/pi-fff/src/query.ts` path/exclude normalization.
   - Initialize `FileFinder` with the same root-scan safety behavior as `pi-fff`.
   - Implement `grep` output as pure hashline rows for returned match/context windows.
   - Preserve user-configurable fuzzy behavior without algorithm-side short-query restrictions.
   - Add tests using mocks where native FFF is not appropriate in unit tests.

9. Prompts and tool registration
   - Ensure built-in conflicting tools are disabled or overridden consistently.
   - Update prompt snippets/guidelines to use `read`, `grep`, `insert`, and `edit`.
   - Keep strict errors actionable and avoid verbose success text.

10. Full validation
   - Run targeted tests while iterating.
   - Run package typecheck and full package tests before reporting completion.

## Validation Commands

From `packages/pi-hashline`:

```bash
npm test
npm run typecheck
```

Focused runs while iterating:

```bash
npm test -- test/core
npm test -- test/tools
npm test -- test/integration
```

## Required Test Matrix Before Task Start Acceptance

Implementation plan explicitly includes validation for:

- duplicate-anchor prevention;
- retired-anchor non-reuse;
- multi-edit shifting and initial-state semantics;
- stale serial handling for read/grep vs edit/insert;
- canonical path aliases sharing one state;
- same-file concurrency/locking.

## Risk Points

- Existing `lineHashes()` is full-file and persistent-snapshot oriented. Do not rely on it for lazy read/grep state extension except for reusing constants/allocator concepts.
- Existing `replace` pipeline assumes a full hash array. Lazy edit must resolve against sparse `hashToLine` instead.
- FFF native dependency may complicate deterministic unit tests; isolate grep backend behind a small adapter so tests can mock returned windows.
- Persistence failure after file write must not leave disk state falsely describing the new content.
