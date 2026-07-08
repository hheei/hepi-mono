# Hash algorithm alternatives for efficient grep anchors

## Question

Can `pi-hashline` change the underlying anchor algorithm so grep can produce anchors more conveniently and efficiently while preserving the current advantages?

Current advantages to preserve:

- 3-character compact anchors using the existing `HASH│content` wire format.
- Per-file uniqueness, including byte-identical duplicate lines.
- Stable anchors for unchanged lines across `replace` operations.
- Strict stale-anchor rejection with no fuzzy relocation.
- No normal line numbers as an edit locator.

## Current algorithm constraints

`lineHashes(content, path)` has two important properties:

1. Pure hashing is prefix-dependent. `_lineHashesPure(content)` assigns each line left-to-right, avoiding collisions against hashes already assigned earlier in the file. Future lines cannot change earlier hashes, which is why no-snapshot prefix hashing can be correct for displayed prefix rows.
2. Stable hashing is snapshot-dependent. With a stored snapshot, `lineHashes(content, path, previous?)` preserves hashes for unchanged lines across edits, including duplicate-line disambiguation via `removedHashes`. This means the correct anchor for a line may be the stored stable anchor, not the fresh pure hash.

Because of property 2, grep cannot safely compute anchors from FFF snippets alone. It needs either a fresh stored index/snapshot or enough file content to compute the same anchors `read`/`replace` would use.

## Alternative 1: content-only or longer content hashes

A line anchor could be `hash(canonicalLine)` with more bits, for example 6-8 characters instead of 3.

Benefits:

- Computable from a single line snippet.
- Simple grep integration.

Problems:

- Byte-identical duplicate lines get the same anchor unless the algorithm adds another discriminator.
- Collision probability drops with more bits but is not zero unless a full-file collision-resolution pass still exists.
- Longer anchors increase token overhead in every `read`/grep output.
- If duplicates are resolved with line numbers or byte offsets, anchors become position-dependent and less stable.

Verdict: not a good fit if duplicate-line uniqueness and compact anchors remain hard requirements.

## Alternative 2: position-salted hashes

A line anchor could be `hash(canonicalLine, lineNumber)` or `hash(canonicalLine, byteOffset)`.

Benefits:

- Computable from FFF metadata plus the matched line.
- Distinguishes duplicate lines in most cases.

Problems:

- Inserting a line above changes every later line's anchor.
- Formatting changes that shift byte offsets invalidate unrelated anchors.
- This loses one of `pi-hashline`'s main benefits: unchanged lines can keep anchors across edits.
- It effectively reintroduces line/position as the hidden edit locator.

Verdict: efficient, but it gives up too much stability.

## Alternative 3: content + occurrence ordinal

A line anchor could be `hash(canonicalLine, occurrenceNumberOfSameCanonicalLineSoFar)`.

Benefits:

- Duplicate lines become distinguishable without absolute line numbers.
- Inserting unrelated line content above does not change the occurrence number.
- Prefix computation remains natural: only prior lines are needed.

Problems:

- Inserting the same canonical line above changes occurrence ordinals for later duplicates.
- Different canonical lines can still collide in a 3-character space unless the algorithm keeps collision resolution.
- With collision resolution, anchor assignment still depends on prior assigned hashes, which means grep still needs prefix content or an index.
- Stored stable hashes can still disagree with fresh pure recomputation after edits.

Verdict: interesting as a pure algorithm, but it does not remove the need for prefix/index state, and it is weaker than the current stable snapshot behavior for duplicate edits.

## Alternative 4: random/stored per-line IDs

Each line could receive a random or allocated 3-character ID stored in a per-file index. Unchanged lines keep their IDs; new lines get unused IDs.

Benefits:

- Excellent stability once indexed.
- Grep can map `lineNumber -> anchor` without hashing full content when the index is fresh.
- Duplicate lines are naturally distinct.

Problems:

- Requires a trusted per-file index and stat validation.
- Cold files still need an initial index build or bounded prefix allocation.
- External edits require either full-load reconciliation or a robust incremental file watcher/indexer.
- The system still needs collision handling because 3-character space is finite.

Verdict: this is close to the proposed stat-validated hash snapshot cache. It is a storage/indexing change, not a snippet-only algorithm.

## Alternative 5: line-anchor index over the existing algorithm

Keep the existing 3-character perfect/stable hash algorithm, but promote the hash-store from a content cache into a stat-validated line-anchor index.

Suggested stored fields:

```ts
interface FileSnapshotV2 {
  content: string;
  hashes: string[];
  snap?: {
    snapshotId: string;
    mtimeMs: number;
    size: number;
  };
  // Optional future fields for faster grep/read windows:
  lineStarts?: number[];
  lineByteLengths?: number[];
}
```

Benefits:

- Preserves the existing wire format and strict semantics.
- Preserves duplicate-line stability and removed-hash disambiguation.
- Fresh stat hits allow grep to map FFF line numbers directly to anchors.
- Optional line offsets make displayed text windows cheaper and more honest than trusting FFF truncated snippets.
- Cold-prefix hashing remains correct for true cold files because current pure hash assignment is already prefix-stable.

Problems:

- Requires hash-store schema migration and tests.
- Old snapshots are not eligible for no-read grep until refreshed.
- Cold files still need prefix or full-load work.

Verdict: best fit. It keeps current benefits and makes grep efficient through a stronger index layer rather than a risky wire-format or hash-function redesign.

## Recommendation

Do not replace the existing 3-character perfect/stable hash algorithm for this grep task. The current algorithm already has the key property needed for bounded cold-prefix hashing: earlier anchors do not depend on future lines. The performance issue comes from missing indexed snapshot metadata, not from the hash function itself.

The better bottom-layer change is to evolve `hash-store.ts` into a stat-validated line-anchor index:

- add snapshot metadata now;
- optionally add line offset metadata later;
- keep `lineHashes()` as the single source of truth;
- make grep/read/replace consume the same indexed snapshot helpers;
- use no-snapshot prefix hashing only as a bounded cold-start path.

A more radical algorithm change should be a separate task only if we are willing to change at least one current benefit: anchor length, perfect uniqueness, duplicate-line behavior, or stable anchors across edits.
