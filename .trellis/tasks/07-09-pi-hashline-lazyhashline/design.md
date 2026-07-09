# Lazy hashline technical design

## Scope

Implement the file-scoped lazy hashline algorithm from `docs/lazyhashline.md` inside `packages/pi-hashline`.

This supersedes the old full-file hash snapshot path for the model-facing hashline tools. The model-facing family is:

```text
read, grep, insert, edit
```

Existing implementation names may still be reused internally during migration, but the user-facing lazy design is not block-scoped and does not revive `bread`/`breplace`/`bgrep`.

## Architecture

### Lazy State Module

Add a dedicated lazy state layer, tentatively `src/lazy-state.ts` plus small helpers as needed.

Core types:

```ts
type Hash3 = string;

type FileSerial = {
  ino: number;
  size: number;
  mtimeMs: number;
  mtimeNs?: bigint;
};

type Interval = { start: number; end: number }; // 1-indexed inclusive lines

type LazyFileState = {
  canonicalPath: string;
  serial: FileSerial;
  cacheSections: Interval[];
  lineToHash: Map<number, Hash3>;
  hashToLine: Map<Hash3, number>;
  retiredHashes: Set<Hash3>;
  salt: string;
  allocId: number;
  sectionChecksums?: Map<string, string>;
};
```

`lineToHash` and `hashToLine` are authoritative. `cacheSections` is a derived interval index used for efficient observed-range lookup; it must be rebuilt or invalidated if it diverges from `lineToHash`.

### Canonical Path Keying

Reuse `resolveTarget()` from `src/fs-write.ts` for canonical path resolution. The state key is always canonical path, even when the tool receives a relative path or a symlink path. Display paths may remain as supplied by the user in responses, but state must not be duplicated by display path.

### Per-File Locking

Use a per-canonical-file promise queue for all lazy state operations:

- read state extension
- grep state extension
- insert/edit state resolution
- file write + lazy state commit
- persisted state load/save

This can wrap package-local logic even if Pi also provides a mutation queue. The lazy state map and persisted state file need their own consistency boundary.

### Hash Allocation

Reuse the original `pi-hashline` 3-character URL-safe base64 alphabet and deterministic collision retry idea from `src/hashline/hash.ts`.

Lazy allocation changes the uniqueness set only:

```text
used = live hashes in hashToLine + retiredHashes
candidate = hash3(salt + allocId + probe + canonicalLineContent)
retry until candidate not in used
```

Do not emit duplicate live hashes. Do not reuse retired hashes. If the candidate space is exhausted, throw an explicit allocation error.

### Read Flow

`read(path, offset?, limit?)` should:

1. canonicalize path and lock file state;
2. stat/read the current file;
3. if the serial mismatches existing state, discard old lazy state and start fresh;
4. compute the requested line range;
5. allocate hashes only for uncached lines in that range;
6. merge observed intervals;
7. persist lazy bookkeeping if enabled;
8. return `HASH│content` rows for the requested range.

This replaces the current full-file `lineHashes(normalized, path)` read path for lazy mode.

### Grep Flow

Add FFF-backed grep to `pi-hashline` rather than relying on standalone `pi-fff` output.

The grep layer should reuse or adapt `packages/pi-fff/src/query.ts` query normalization and `FileFinder` initialization patterns where practical. Fuzzy behavior is controlled by settings/parameters; algorithm code does not restrict short queries or reinterpret fuzzy result risk.

For each returned FFF match/context line:

1. canonicalize the file path;
2. update that file's lazy state under lock;
3. allocate hashes only for returned lines not already observed;
4. render pure hashline rows.

Normal line numbers may be used internally, but model-facing content rows remain `HASH│content` or `HASH|content` style rows.

### Insert Flow

`insert(path, beforeHashline, content)`:

- stale serial rejects when inserting by hashline;
- `beforeHashline === -1` inserts at EOF;
- content is a list of complete content lines, not hashline-prefixed rows;
- inserted lines receive fresh hashes;
- cached lines at/after the insertion point shift by inserted line count;
- state commit follows atomic write success.

### Edit Flow

`edit(path, changes[])` resolves all changes against the initial lazy state:

1. canonicalize path and lock;
2. reject stale serial;
3. resolve all start/end hashes via initial `hashToLine`;
4. convert all ranges to initial byte spans;
5. reject overlapping spans;
6. apply spans from end to start;
7. retire live hashes inside replaced ranges;
8. allocate fresh hashes for replacement lines;
9. shift surviving observed lines by cumulative deltas of prior initial spans;
10. rebuild `cacheSections` from updated `lineToHash`;
11. write file atomically, refresh serial, then commit/persist state.

Unseen lines inside an edit span have no bookkeeping; they are overwritten as normal file content.

### Persistence

If lazy persistence is enabled, store only lazy bookkeeping:

- canonical path
- serial
- cache sections
- live mappings
- retired hashes
- salt / allocId
- optional section checksums

Do not store the original full-file `content + hashes` snapshot shape for lazy state. Existing `hash-store.ts` may remain for compatibility during migration, but lazy state should have a distinct store version/shape so full snapshots and lazy state cannot be confused.

### Stale Serial Policy

- `read` and `grep`: stale serial discards old lazy state and rebuilds from current file content as lines are returned.
- `edit` and `insert` by hashline: stale serial rejects and requires fresh `read` or `grep`.

No exact relocation or diff refresh after external modification in v1.

### Atomic Commit Order

For mutating operations:

1. prepare new file content and next lazy state in memory;
2. write file atomically through existing `writeAtomic()`;
3. stat file and refresh serial;
4. commit in-memory state;
5. persist lazy state.

If write fails, old in-memory/persisted state remains authoritative. If persistence fails after a successful write, do not leave persisted state claiming to describe the new content; either keep persistence best-effort with in-memory state authoritative for the session, or write persistence through an atomic temp-file path.

## Compatibility Notes

- Preserve 3-character anchors and `HASH│content` row format.
- Preserve strict validation for malformed edit inputs and hashline-prefixed content lines.
- Existing `replace` may be kept as a compatibility alias only if needed, but lazy task acceptance is about `edit` and `insert`.
- Existing prompts and tool descriptions must be updated together with tool schemas.

## Validation Focus

Tests must cover:

- duplicate-anchor prevention with repeated identical lines;
- retired-anchor non-reuse after edit/insert cycles;
- read reuses anchors for previously observed lines;
- grep reuses anchors from prior read and marks returned FFF lines;
- multi-edit resolves against initial state and shifts surviving anchors correctly;
- overlapping multi-edit ranges reject;
- stale serial clears read/grep state but rejects edit/insert-by-hash;
- canonical path aliases share one state;
- same-file concurrent operations do not duplicate anchors or clobber state;
- persistence stores lazy bookkeeping only, not full file content snapshots.
