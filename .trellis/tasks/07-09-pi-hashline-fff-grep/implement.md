# Implementation Plan

## Scope

Implement in a branch inside the `packages/pi-hashline` submodule. Do not implement in the parent repo as normal tracked files.

## Ordered Steps

1. Create a feature branch in `packages/pi-hashline` for the hashline-aware FFF grep work.
2. Add `@ff-labs/fff-node` as a normal dependency of the branch.
3. Extend the hash-store contract with optional file snapshot metadata:
   - keep backward compatibility with existing `{ content, hashes }` snapshots;
   - save current `fileSnap()` metadata whenever `lineHashes(content, path)` writes a complete snapshot;
   - add a helper that returns stored hashes only when current `fileSnap().snapshotId` matches stored metadata;
   - add tests for old snapshots, fresh metadata hits, and stale metadata misses.
4. Add displayed-line-window and prefix-read helpers for grep:
   - use FFF `byteOffset` plus requested before/after context to read only displayed lines on cache hits;
   - for true cold files with no snapshot, read from file start through the last displayed context line and compute pure prefix hashes without writing the hash-store; default prefix eligibility is at most `min(32 MiB, 50% of file size)`, tunable by env/config;
   - normalize line endings consistently with read output;
   - apply the same explicit truncation marker used by grep rows;
   - fall back to full-file load if the window/prefix cannot be read or validated safely.
5. Port or rewrite the minimal FFF query helpers from the reference `packages/pi-fff/src/query.ts`.
6. Add a narrow FFF finder lifecycle module:
   - one finder per active cwd;
   - single-flight `FileFinder.create()`;
   - destroy on session shutdown;
   - root scan disabled unless explicitly enabled.
7. Add a grep module that registers `grep` and reuses the existing hashline helpers:
   - call FFF `grep()`;
   - collect displayed results by file;
   - for each displayed file, first try fresh stat-validated stored hashes;
   - on cache hit, avoid full-file load and read only displayed line windows for row text;
   - when no snapshot exists, use the default prefix-hash path if the required prefix is bounded and validation passes;
   - on stale snapshot, metadata-less snapshot, prefix ineligibility, or validation uncertainty, load displayed files as normalized text and call `lineHashes(normalized, absolutePath)` on the full normalized content;
   - map FFF `lineNumber`/context offsets to anchors;
   - format pure `HASH│content` rows plus `hit: HASH` metadata.
8. Wire `regGrep(pi)` from `index.ts` alongside `regRead()` and `regReplace()`.
9. Add tests for formatting, mapping, no-line-number output, non-text handling, pagination notices, stat-cache hits, stale-cache fallback, no-snapshot prefix hashing, and prefix-to-full hash equivalence.
10. Run validation inside `packages/pi-hashline`.
11. Update the parent repo submodule pointer only after the submodule branch commit is ready.

## Validation Commands

Run inside `packages/pi-hashline`:

```bash
npm install
npm run typecheck
npm test
```

If FFF native install or tests require platform-specific setup, document the exact failure and run the narrower unit tests that do not require native indexing.

## Risk Points

- `@ff-labs/fff-node` is a native dependency; install behavior may differ from the existing lightweight pi-hashline dependency set.
- FFF result fixtures may be easier to unit test than full native integration. Keep mapping/formatting logic testable without a live FFF index.
- `lineHashes(content, path)` updates persistent hash-store snapshots. Tests should isolate `HOME` using existing test helpers and cover snapshot metadata migrations.
- Avoid outputting normal line numbers anywhere in text rows, including context rows and error examples.
- Do not mark match rows by prefixing the hashline rows; use `hit: HASH` metadata to keep code rows copyable.
- Stat-cache optimization is in v1 scope: cache hits must reuse hashes only when `fileSnap().snapshotId` matches stored metadata, otherwise fall back to full-file `lineHashes(content, path)`.
- Cold-cache prefix hashing is in v1 scope by default only for files with no existing hash-store snapshot. Stale snapshots, metadata-less snapshots, or uncertain validation must fall back to full-file `lineHashes(content, path)`.
