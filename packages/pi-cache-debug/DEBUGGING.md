# Prompt Cache Debugging Guide

This guide explains how to use `@hheei/pi-cache-debug` to determine why a Pi provider request did or did not reuse a prompt cache prefix.

The extension records hashes and structural metadata only. It does not decide whether a cache miss is correct. Use the request hashes together with the provider-reported `cacheRead` and `cacheWrite` values.

## What the extension observes

The extension runs on Pi's `before_provider_request` event. At that point the provider adapter has created the final request payload, including provider-specific input items and tool schemas.

For each request it records SHA-256 digests for:

- the complete provider payload
- the provider envelope outside prompt-bearing fields
- tools or functions
- system or developer instructions
- Magic Context m[0]
- Magic Context m[1]
- the remaining conversation
- every provider input item
- cumulative input prefixes ending at recognized module boundaries

It then correlates the request with:

- HTTP response status, when exposed by the provider
- input and output token usage
- provider-reported cache reads and writes
- stop reason and error presence

It does not record prompt text, tool arguments, tool results, API keys, headers, or response text.

## Installation and load order

Load the package after any extension that rewrites `before_provider_request`. Event handlers run in extension load order; loading this package last lets it hash the payload closest to the one sent by Pi.

```json
{
  "packages": [
    "...payload-rewriting extensions...",
    "npm:@hheei/pi-cache-debug"
  ]
}
```

If another extension loaded later modifies the payload, this extension cannot observe that later mutation.

## Log location

The default path is:

```text
/tmp/pi/cache-debug/<session-id>.jsonl
```

Use a persistent path when collecting a long reproduction:

```bash
PI_CACHE_DEBUG_LOG="$HOME/.pi/agent/logs/cache-debug/{sessionId}.jsonl" pi
```

`{sessionId}` is replaced with a filesystem-safe session ID. Without the placeholder, all sessions append to one file.

Run this Pi command to display both the active path and this guide:

```text
/cache-debug
```

## Record lifecycle

The log is JSONL. Each line is an independent JSON object.

A normal request produces these records:

1. `request`: final payload hashes and comparison with the previous request
2. `http-response`: provider HTTP status
3. `usage`: final assistant usage and cache accounting

A `session` record identifies session startup and contains the log path and this guide's URL.

The `request` integer correlates these records. Retries can produce multiple `http-response` records for one request. A request that fails before an assistant message may have no `usage` record.

## Request fields

### Top-level digests

Every digest has:

- `hash`: SHA-256 of `JSON.stringify(value)`
- `bytes`: UTF-8 byte length of that serialized value

Request records contain:

- `payload`: digest of the complete payload
- `envelope`: digest excluding `input`, `messages`, `contents`, `tools`, `functions`, `system`, and `instructions`
- `inputKey`: provider input field: `input`, `messages`, `contents`, or `null`
- `input`: digest of the complete provider input array
- `itemCount`: number of provider input items
- `modules`: logical module digests

An `envelope` change commonly means a model option, cache key, reasoning option, response format, or another provider control changed. The log intentionally does not reveal which raw value changed.

### Module fields

Each module has:

- `name`: logical module name
- `hash` and `bytes`: digest of that module
- `itemCount`: number of input items assigned to it
- `startIndex` and `endIndex`: inclusive item range, or `null` for top-level fields
- `prefixHash`: digest of all input items through `endIndex`

Recognized names:

- `envelope`: non-content provider options
- `tools`: tool or function definitions
- `system`: top-level instructions and system/developer input items
- `magic-context:m0`: project/user memory and project context injection
- `magic-context:m1`: session-history injection
- `conversation`: all other input items

`magic-context:m0` and `magic-context:m1` are diagnostic classifications, not provider-native boundaries. They are recognized from Magic Context markers. Missing or changed markers can cause an item to be classified as `conversation`.

### Adjacent-request comparison

`comparison` contains:

- `previousItems`: previous request's item count
- `commonPrefixItems`: number of identical leading item hashes
- `appendOnly`: whether every previous input item remains unchanged at the start of the current input
- `firstChangedItem`: index and hash-only metadata for the first difference
- `changedModules`: modules whose digest changed, appeared, or disappeared

For the first request, `appendOnly` is `null` because there is no prior payload.

`appendOnly=true` does not guarantee a provider cache hit. It proves only that the previous provider input item sequence is an exact prefix of the current sequence. Provider cache keys, token thresholds, expiration, routing, and implementation details still apply.

## Fast inspection

Set the log path first:

```bash
LOG="/tmp/pi/cache-debug/<session-id>.jsonl"
```

Show the request and usage timeline:

```bash
jq -c '
  select(.type == "request" or .type == "usage")
  | if .type == "request" then
      {
        type,
        request,
        payload: .payload.hash,
        items: .itemCount,
        appendOnly: .comparison.appendOnly,
        commonPrefix: .comparison.commonPrefixItems,
        changed: .comparison.changedModules
      }
    else
      {type, request, usage, stopReason, hasError}
    end
' "$LOG"
```

Show module hashes for every request:

```bash
jq -r '
  select(.type == "request")
  | .request as $request
  | .modules[]
  | [$request, .name, .hash, .bytes, .startIndex, .endIndex, .prefixHash]
  | @tsv
' "$LOG"
```

Show cache accounting only:

```bash
jq -r '
  select(.type == "usage")
  | [.request, .usage.input, .usage.cacheRead, .usage.cacheWrite, .stopReason]
  | @tsv
' "$LOG"
```

Show requests that changed an old prefix:

```bash
jq -c '
  select(.type == "request" and .comparison.appendOnly == false)
  | {
      request,
      commonPrefix: .comparison.commonPrefixItems,
      firstChanged: .comparison.firstChangedItem,
      changed: .comparison.changedModules
    }
' "$LOG"
```

Show non-success HTTP responses:

```bash
jq -c 'select(.type == "http-response" and (.status < 200 or .status >= 300))' "$LOG"
```

## Investigation workflow

### 1. Find the first unexpected cache result

Start with `usage` records. Identify the first request where `cacheRead` drops unexpectedly or `cacheWrite` becomes unusually large.

Do not infer a miss from latency alone. `cacheRead` and `cacheWrite` are provider-reported values and are the direct cache evidence available to Pi.

### 2. Inspect that request and the request before it

Check:

- `payload.hash`
- `envelope.hash`
- `input.hash`
- `comparison.appendOnly`
- `comparison.commonPrefixItems`
- `comparison.changedModules`
- `comparison.firstChangedItem`

The comparison is adjacent. To compare non-adjacent requests, compare their module and prefix hashes directly.

### 3. Locate the first changed module

Use `changedModules` as a shortlist:

- `envelope`: inspect model, provider, reasoning, cache retention, response format, and extension options
- `tools`: inspect active-tool changes, extension loadout changes, or nondeterministic schema generation
- `system`: inspect context files, extension instructions, dates, generated metadata, and model-specific prompts
- `magic-context:m0`: inspect memory/profile/project-context injection
- `magic-context:m1`: inspect session-history materialization, drop, historian, or compaction activity
- `conversation`: inspect old message mutation versus normal suffix append

A module hash shows that serialized content changed. It does not identify the semantic field or extension responsible for the change.

### 4. Decide whether the miss is locally explained

Use these evidence patterns.

#### Normal append-only turn

Typical evidence:

- `appendOnly=true`
- only `conversation` changed
- `commonPrefixItems` equals the previous item count
- `cacheRead` remains stable or grows

The provider input preserved the previous item prefix.

#### Expected drop or compaction bust

Typical evidence:

- `appendOnly=false` once
- `magic-context:m1` or `conversation` changed
- `firstChangedItem.index` points into old history
- `cacheRead` drops for that request
- later requests return to `appendOnly=true` and cache reads recover

The old prefix was intentionally rewritten. One cache bust is expected.

#### Repeated local prefix mutation

Typical evidence:

- `appendOnly=false` on several consecutive requests
- the same old item region changes repeatedly
- module or prefix hashes keep changing

The request producer is preventing stable prefix reuse. Investigate the first changing module and extensions that own it.

#### Tool schema churn

Typical evidence:

- `tools.hash` changes
- conversation prefix may remain stable
- cache reuse falls near the tool boundary

Check tool activation, tool ordering, generated descriptions, schema property ordering, and extensions loaded between requests.

#### Provider envelope churn

Typical evidence:

- `envelope.hash` changes
- input and module prefix hashes remain stable

Check `prompt_cache_key`, model/provider selection, reasoning parameters, cache retention, and provider-adapter changes. Raw envelope values are deliberately absent from this log; use a separate sensitive trace only when necessary.

#### Likely provider-side miss

Strong evidence:

- relevant module and prefix hashes match a previously cached request
- `appendOnly=true`, or the complete `payload.hash` is identical
- model/provider remain the same
- `cacheRead` still drops unexpectedly

This rules out a serialized payload change visible to this extension. Remaining causes include provider expiration, cache shard/routing behavior, cache admission thresholds, provider incidents, or a mutation performed after this extension's handler.

It does not prove a specific provider implementation failure.

## Magic Context drop analysis

For a suspected `ctx_reduce` or automatic drop issue:

1. Find the request where `magic-context:m1.hash` first changes.
2. Confirm `appendOnly=false` on that request.
3. Treat that request's cache bust as expected.
4. Inspect the next two or more requests.
5. Verify m[0], m[1], tools, system, and envelope hashes remain stable.
6. Verify later requests are append-only.
7. Compare subsequent `cacheRead` values.

If cache reads recover, drop materialization behaved normally. If hashes remain stable but reads do not recover, collect the log and provider incident timing. If m[1] keeps changing, inspect Magic Context transform and materialization logs for repeated execution.

## Limits

- Hashes describe JavaScript serialized payloads, not provider-side token streams.
- Cache boundaries may occur inside an input item; `commonPrefixItems` reports only whole-item boundaries.
- Module recognition is provider-shape-aware but heuristic. Unknown providers can place data in fields this version does not classify.
- Magic Context module recognition depends on known textual markers.
- The extension sees its position in the event handler chain. Load it last.
- Provider cache accounting can be absent, delayed, rounded, or provider-specific.
- Hash equality is strong evidence of serialized equality. It is not evidence that the provider admitted or retained the prefix.

## Privacy and retention

The log omits raw prompt content, but it is not anonymous.

It exposes:

- session ID
- model and provider IDs
- request timing
- HTTP status
- serialized byte lengths
- item roles/types
- deterministic hashes
- cache usage
- local log path

A deterministic hash of low-entropy content can be guessed by hashing candidate values. Treat the log as potentially sensitive metadata. Review it before sharing, store persistent logs with appropriate filesystem permissions, and delete it when the investigation ends.

```bash
rm "$LOG"
```

## Reproduction bundle

For a useful cache issue report, include:

- the JSONL log
- Pi and extension versions
- provider and model IDs
- extension load order
- approximate incident time and timezone
- the request numbers that should be compared
- whether a drop, compaction, tool activation, model switch, retry, or session reload occurred
- a redacted settings excerpt relevant to cache retention and provider selection

Do not include API keys, raw prompts, provider authorization headers, or unreviewed session files.
