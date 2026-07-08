# Grep performance optimization options

## Problem

FFF already reads candidate file contents internally to search. A hashline-aware grep can add another expensive path when it reads displayed files again only to compute anchors. For large files, the worst case is:

1. FFF reads/searches the file;
2. hashline grep reads the full displayed file and computes all per-line hashes;
3. the model later calls `read`, which reads/hashes again unless the hash-store cache avoids recomputation.

The design should minimize this extra work without weakening the `HASH│content` anchor contract.

## Existing code facts

- `lineHashes(content, path)` is the only source of truth for anchors.
- `lineHashes()` currently stores `{ content, hashes }` per path in `hash-store.json`.
- A cache hit currently requires passing the full `content` to `lineHashes()` so it can compare `snapshot.content === content`.
- `src/snapshot.ts` already exposes `fileSnap(absolutePath)` with canonical path, `mtimeMs`, and `size` through `snapshotId`.
- `readNormFile()` combines full file load, text validation, LF normalization, and `lineHashes()`.
- `loadFileKindAndText()` validates full files for directories, images, null bytes, UTF-8 decode errors, and `MAX_BYTES`.
- FFF `GrepMatch` exposes `byteOffset`, `lineNumber`, `lineContent`, context arrays, `isBinary`, `size`, and `modified`.

## Safe v1 optimization: stat-validated hash snapshot cache

Extend hash-store snapshots with file stat metadata:

```ts
interface FileSnapshotV2 {
  content: string;
  hashes: string[];
  snap?: {
    snapshotId: string;
    mtimeMs: number;
    size: number;
  };
}
```

Then add helpers:

- `getFreshHashSnapshot(path): Promise<string[] | null>`
  - calls `fileSnap(path)`;
  - loads hash-store;
  - returns `hashes` only if stored `snap.snapshotId` matches current `fileSnap().snapshotId`;
  - otherwise returns `null`.
- `saveHashSnapshot(path, content, hashes)`
  - stores existing content+hashes plus current `fileSnap()` metadata.

Grep flow:

1. For each displayed file, check fresh hash snapshot by stat.
2. If fresh, do not read/hash the whole file.
3. Use stored `hashes[lineNumber - 1]` for match and context anchors.
4. For displayed text, read only the needed line windows around each `byteOffset`, or use FFF snippets only with explicit bounded/truncated markers.
5. If no fresh snapshot exists, fall back to full file load + `lineHashes(fullContent, path)` and save the snapshot metadata.

This preserves strict semantics because cache hits are allowed only when stat says the stored hash array belongs to the current file snapshot. It also means any prior `read` or `replace` makes later grep on that file cheap.

## Display text on cache hit

The safer cache-hit display path is a small line-window reader:

- seek around `match.byteOffset`;
- read the match line plus requested before/after context;
- normalize CRLF/BOM consistently with `read`;
- apply the same explicit display truncation marker as the cold path.

This avoids trusting FFF's `lineContent`, which its type definition says may already be truncated. FFF snippets remain useful as a fallback or for tests, but exact local line-window reads keep output honest.

## Cold-cache prefix hashing option

When no hash-store snapshot exists for the path, a prefix-hashing fast path can be correct for displayed rows:

- read from file start through the last displayed context line;
- compute pure hashes for that prefix only;
- use those hashes for displayed rows.

Why this can be correct: pure collision resolution for line N depends only on hashes assigned to lines `1..N-1`; future lines cannot change earlier assigned hashes.

Limits:

- It does not update the complete hash-store snapshot.
- If a stale snapshot exists, prefix hashing can be wrong when the file content is unchanged but stat changed; `lineHashes(fullContent, path)` would return the preserved stored hashes after content comparison.
- Full-file text validation is weakened unless the implementation still scans the whole file for null bytes / UTF-8 errors.
- It requires a new helper that computes prefix hashes without writing a partial snapshot to the normal hash-store.

Accepted boundary: enable prefix hashing by default only when no complete hash-store snapshot exists for the canonical path. Prefix hashes are partial and separate from the persistent full hash-store. Cache only the file snapshot id, the covered prefix end, and the prefix hashes. Reuse the cache when a later request stays inside the covered prefix and the snapshot id still matches; if it needs more lines, reread from the beginning through the larger prefix and replace the partial cache. Discard prefix cache entries when the snapshot id changes or when a full `read`, full-load grep fallback, or `replace` creates a complete snapshot. Do not use prefix hashing when any complete snapshot exists but is stat-stale or metadata-less; full-load instead so `lineHashes(fullContent, path)` can preserve stored hashes if content is actually unchanged.

## Performance recommendation

Make stat-validated hash snapshot cache part of v1. It is a direct extension of existing stable-hash semantics and reduces repeated full-file reads for the common hot path.

Also include no-snapshot prefix hashing in v1 by default, using the simple prefix-coverage rule above. This improves first-grep behavior on large never-read files while keeping implementation simpler than incremental append or profitability heuristics. If validation is uncertain, FFF reports binary, local stat exceeds `MAX_BYTES`, or any complete snapshot already exists, use full-load fallback and create/refresh the complete snapshot.
