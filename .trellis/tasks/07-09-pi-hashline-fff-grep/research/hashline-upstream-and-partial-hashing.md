# pi-hashline upstream update and partial hashing research

## Upstream status

Checked `packages/pi-hashline` against upstream `origin/master` from `https://github.com/YuGiMob/pi-hashline-edit-pro`.

- Local submodule HEAD: `83f4145dd1271929c9c81beae508a4b616c5232d`
- Upstream `origin/master`: `83f4145dd1271929c9c81beae508a4b616c5232d`
- Result: already up to date; no submodule pointer change required.

## Recent hash-related upstream changes

The recent relevant upstream commits do not make hashes independently computable from a single line or snippet. They strengthen stable hashing for duplicate lines:

- `5b76e77 FIX: use hash-aware matching in mapStableHashes to disambiguate duplicate lines`
  - `lineHashes(previous)` now accepts `removedHashes?: Set<string>`.
  - `mapStableHashes()` maps old hashes to new positions by content, preferring old occurrences whose hash was not targeted by the edit.
  - This fixes cases where two byte-identical lines, such as repeated `}`, need distinct stable anchors after edits.
- `9c833dc FIX: fix(hashline): collect all hashes in edit range stable hash disambiguation`
  - `replace.ts` now collects every hash in the replaced range, not just the start/end boundary hashes.
  - This fixes interior duplicate-line cases where a duplicate line inside the removed region previously could be confused with a surviving duplicate line.

The README still states that runtime precomputes the full per-line hash array via `lineHashes(content, path)` and that per-line recomputation can disagree with what the model saw.

## Current hash-store shape

`src/hash-store.ts` stores per-path snapshots as:

```ts
interface FileSnapshot {
  content: string;
  hashes: string[];
}
```

It does not currently store file stat metadata such as canonical path, `mtimeMs`, or byte size. `src/snapshot.ts` can compute a separate `fileSnap()` using canonical path, mtime, and size, but that value is not part of the hash-store snapshot.

## FFF grep metadata

`@ff-labs/fff-node@0.9.6` `GrepMatch` includes more than line numbers:

- `lineNumber`: 1-based match line number
- `col`: 0-based byte column first match start
- `byteOffset`: absolute byte offset of the matched line start
- `lineContent`: matched line text, may be truncated
- `matchRanges`: byte ranges within `lineContent`
- `contextBefore` / `contextAfter`: context line text arrays
- file metadata: `size`, `modified`, `isBinary`, git/frecency fields

This metadata helps locate the match and can support optimization, but it still does not directly provide hashline anchors.

## Can grep avoid reading the full file?

### Strict v1 answer: no, not safely with the current hash contract

For v1, grep should still read the full displayed file and call `lineHashes(fullContent, absolutePath)` before formatting anchors.

Reasons:

- Hashes are per-file unique, not pure per-line IDs. `_lineHashesPure()` assigns each line while tracking an `assigned` set so duplicate or colliding lines get distinct anchors.
- `lineHashes(content, path)` may return stored stable hashes that differ from a fresh pure recomputation, because hashes are preserved across edits for unchanged lines.
- Current hash-store snapshots do not include stat metadata, so grep cannot safely know that a stored `content + hashes` snapshot still matches the current file without checking content.
- A snippet-only hash can collide with previous lines or duplicate content and produce an anchor different from `read` / `replace`.

### Possible optimization: prefix hashing when no stable snapshot is involved

A theoretical optimization can read from file start through the last displayed context line rather than the entire file. For fresh pure hashing, a line's collision-resolved hash depends only on prior assigned hashes, not future lines. Therefore, for a match at line N with after-context K, reading and hashing lines `1..N+K` can produce the same pure hashes for displayed rows as full-file `_lineHashesPure(fullContent)`.

Limits:

- This does not preserve existing stable hashes from hash-store snapshots.
- It does not update the persistent hash-store with a complete file snapshot.
- If a valid stable snapshot exists, prefix pure hashes may not match the anchors `read` / `replace` would use.
- A late-file match still requires reading almost the whole file.
- It would need a new helper that computes prefix hashes without writing partial snapshots to the existing hash-store.

### Possible optimization: hash-store snapshot metadata

A future v2 could extend `HashStore` snapshots with `fileSnap()` metadata, for example canonical path, size, and mtime. Then grep could:

1. stat the matched file without reading it;
2. if hash-store snapshot metadata matches current stat, use `snapshot.hashes[lineNumber - 1]` and context offsets directly;
3. otherwise fall back to full-file read or prefix hashing.

Limits:

- Requires hash-store schema migration.
- FFF's `modified` is Unix seconds, while `fileSnap()` uses `mtimeMs`; local stat is still needed for precision.
- Size+mtime are practical cache validation, but not cryptographic proof of unchanged content.
- Existing snapshots without metadata still need fallback behavior.

## Recommendation

Keep v1 full-file for displayed files. It is the only path that exactly matches current `read` / `replace` semantics and updates the persistent hash-store normally.

Record prefix hashing and stat-validated snapshot lookup as future optimizations, not v1 requirements. They are useful if profiling shows full-file reads are too expensive, but they require careful hash-store/API design to avoid stale or mismatched anchors.
