# Implementation Plan

## Scope

Implement in a branch inside the `packages/pi-hashline` submodule. Do not implement in the parent repo as normal tracked files.

## Ordered Steps

1. Create a feature branch in `packages/pi-hashline` for the hashline-aware FFF grep work.
2. Add `@ff-labs/fff-node` as a normal dependency of the branch.
3. Port or rewrite the minimal FFF query helpers from the reference `packages/pi-fff/src/query.ts`.
4. Add a narrow FFF finder lifecycle module:
   - one finder per active cwd;
   - single-flight `FileFinder.create()`;
   - destroy on session shutdown;
   - root scan disabled unless explicitly enabled.
5. Add a grep module that registers `grep` and reuses the existing hashline helpers:
   - call FFF `grep()`;
   - collect displayed results by file;
   - load displayed files as normalized text;
   - call `lineHashes(normalized, absolutePath)`;
   - map FFF `lineNumber`/context offsets to anchors;
   - format pure `HASH│content` rows plus `hit: HASH` metadata.
6. Wire `regGrep(pi)` from `index.ts` alongside `regRead()` and `regReplace()`.
7. Add tests for formatting, mapping, no-line-number output, non-text handling, and pagination notices.
8. Run validation inside `packages/pi-hashline`.
9. Update the parent repo submodule pointer only after the submodule branch commit is ready.

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
- `lineHashes(content, path)` updates persistent hash-store snapshots. Tests should isolate `HOME` using existing test helpers.
- Avoid outputting normal line numbers anywhere in text rows, including context rows and error examples.
- Do not mark match rows by prefixing the hashline rows; use `hit: HASH` metadata to keep code rows copyable.
