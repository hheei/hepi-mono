# Pi Basics BTW Research

研究日期：2026-07-23

本次只研究四个公开仓库的 BTW 实现，没有复制代码到 `packages/pi-btw`。可选浅克隆统一放在 ignored `references/repos/`；下表记录本次研究所依据的 revision。

| Repository | Local reference | Revision | BTW implementation |
| --- | --- | --- | --- |
| [dbachelder/pi-btw](https://github.com/dbachelder/pi-btw) | `references/repos/dbachelder-pi-btw` | `4f858102706910ee9d520a9666832f3103631b61` | `extensions/btw.ts` |
| [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) | `references/repos/narumiruna-pi-extensions` | `c5dc930cd85a6f661c3fd530fa62e44109c86070` | `extensions/pi-btw/src/` |
| [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono) | `references/repos/juicesharp-rpiv-mono` | `700c2d370353ca145d2658c61df1eee6297e8d80` | `packages/rpiv-btw/` |
| [Firstp1ck/npm-packages](https://github.com/Firstp1ck/npm-packages) | `references/repos/firstp1ck-npm-packages` | `7ff59ae4baa303ccbb66212355ecc335bee3a4c1` | `pi-extension-btw/` |

## Executive comparison

| Dimension | dbachelder | narumiruna | rpiv | Firstp1ck |
| --- | --- | --- | --- | --- |
| Main model interaction | Independent `AgentSession`, streaming, tools enabled | Direct `completeSimple`, no tools | Direct `completeSimple`, no tools | Direct `compat.stream`, no tools |
| Main context | Seeded sub-session, contextual/tangent modes | One-time text context from current branch | Cached converted branch snapshot | Textual converted current branch snapshot |
| Follow-up history | Persistent hidden sub-session state | In-memory `SideThread`, successful turns only | Per-session process-global history | In-memory `SideThread`, serialized with a promise tail |
| UI | Rich transcript overlay with tool events | Native Pi message components in a pager overlay | Bottom overlay with answer/history | TUI overlay plus RPC/WebUI widgets |
| Main transcript | Hidden by default; optional save/inject | Not modified | Not modified | Not modified unless explicit transfer |
| Persistence | Custom session entries restore hidden thread | Invocation/session memory only | Process-global memory, not disk | Extension instance/session lifetime |
| Cancellation | Abort and dispose independent sub-session | Abort race guarded before commit | Dedicated overlay controller and abort | Per-run controllers plus shutdown queue abort |
| Test depth | Broad orchestration tests, many Pi API mocks | Good focused behavior/UI tests | Strong execution/UI/compat tests | Only focused `SideThread` tests |
| Migration cost to `pi-basics` | High | Low | Medium | Medium-high |

## 1. dbachelder/pi-btw

### Shape

This is a full side-agent workflow rather than a simple side question. The package manifest registers `extensions/btw.ts`; the extension registers `/btw`, `/btw:tangent`, `/btw:new`, `/btw:clear`, `/btw:inject`, `/btw:summarize`, `/btw:model`, and `/btw:thinking`, plus keyboard shortcuts and a BTW message renderer. See `references/repos/dbachelder-pi-btw/extensions/btw.ts:1590-1613` and `:2200-2309`.

### Execution and context

`createBtwSubSession` creates an independent `AgentSession` with an in-memory `SessionManager`, a selected or overridden model, and the standard `read`, `bash`, `edit`, and `write` tools. `buildBtwSeedState` builds either a contextual seed from the current branch or an empty tangent seed, filters hidden BTW notes, and reconstructs previous side-thread turns. The request enters the side session with `session.prompt(question, { source: "extension" })` (`extensions/btw.ts:268-342`, `:1599-1625`, `:2069`).

The overlay subscribes to side-session events and renders thinking, assistant streaming, tool execution, and turn state as a transcript (`:1010-1457`). The default side agent is therefore capable of changing files and running commands; this is a substantially different trust boundary from a read-only `/btw` question.

### State and behavior

Hidden state is represented by custom session entries for thread/reset/model/thinking configuration, so the extension can restore it on `session_start` and `session_tree`. `/btw --save`, injection, and summarization intentionally cross the boundary and write or enqueue content into the main session. Cleanup aborts subscriptions, aborts the side agent, and disposes it (`:1445-1457`, `:1960-2034`, `:2188-2195`, `:2240-2244`).

### Strengths and risks

Strengths: complete event-driven transcript state machine; explicit sub-session isolation; restore/save/inject semantics; broad orchestration tests in `tests/btw.runtime.test.ts:688-2179`.

Risks for Pi Basics: large scope and high migration cost; it enables tools by default; it depends on `createAgentSession`, internal agent state assignment, resource loaders, and several version-sensitive Pi APIs. The peer range is broad (`>=0.74.0 <1`) while the tests and implementation were written around older Pi APIs. It should be treated as a source of optional future features, not the first implementation baseline.

## 2. narumiruna/pi-extensions

### Shape

This is the closest match to a minimal read-only BTW. The manifest points at `extensions/pi-btw/src/btw.ts`. `/btw` rejects non-TUI execution, reads optional user-level model/thinking configuration, resolves a model and credentials, then runs a persistent composer loop (`src/btw.ts:98-145`, `:204-242`, `:298-331`).

### Execution and context

`SideThread` stores the original main context and successful user/assistant turns. `buildSideThreadMessages` includes the main context once, then successful side turns and the next question; failed turns are display-only and are not fed back to the provider (`src/side-thread.ts:78-107`, `:125-155`). The provider call is `completeSimple` with a system prompt that explicitly forbids tools, file edits, commands, and searches (`src/side-thread.ts:45-63`, `:194-247`).

The main branch is converted to a bounded textual context, including readable representations of tool calls/results, with the newest portion retained (`src/btw.ts:408-461`). This is simple and predictable, but loses the original message structure and has a fixed context character limit.

### UI, cancellation, and tests

The transcript pager uses Pi's native `UserMessageComponent`, `AssistantMessageComponent`, Markdown, and Editor. It handles narrow widths, scrolling, terminal-control escaping for display, and resize (`src/transcript-pager.ts:30-378`). A dedicated `AbortController` and a settled guard prevent a late provider response from committing after the UI has closed (`src/btw.ts:341-364`, `src/side-thread.ts:125-155`).

The two test files cover compat loading, settings/auth fallback, context conversion, message ordering, cancellation races, command state transitions, and UI sizing/scrolling (`test/btw.test.ts`, `test/side-thread.test.ts`).

### Strengths and risks

Strengths: smallest coherent architecture; successful-turn-only commit rule; one-time main-context injection; native Pi UI; focused tests; current Pi 0.80-oriented dependency/API assumptions; configuration failure falls back to the main model with a warning.

Risks: the textual context bound and side-thread history can still grow; user configuration and `completeSimple` compat loading need to be adapted to `pi-basics` policies; the feature is currently TUI-centric. The implementation does not provide a durable session record, which is acceptable for an initial transient feature.

## 3. juicesharp/rpiv-mono

### Shape

`packages/rpiv-btw/index.ts` registers the command, a `message_end` snapshot hook, and compact/tree invalidation hooks. `/btw <question>` opens one temporary bottom overlay and never writes the side answer to the main transcript (`packages/rpiv-btw/index.ts:13-17`, `btw.ts:309-359`).

### Execution and context

A process-global state object, keyed by session file or an in-memory session id, stores per-session successful `BtwTurn` history and converted main-session snapshots (`btw.ts:30-35`, `:90-135`). On first use it reads the live branch; after assistant messages end it caches converted message entries. A request is assembled as:

`main snapshot + successful BTW user/assistant turns + current question`

(`btw.ts:179-194`). The system prompt adds at most ten recent question-only hints from all in-process sessions, while answers and main context remain session-local (`btw.ts:155-167`).

The executor resolves API key/headers and calls `completeSimple` with `tools: []`; it distinguishes abort, provider error, missing text, and thrown exceptions (`btw.ts:200-268`). `pi-compat.ts` falls back from `@earendil-works/pi-ai/compat` to the package root only for module-resolution failures, and rethrows real initialization errors (`pi-compat.ts:21-64`).

### UI and lifecycle

`btw-ui.ts` builds a bottom-center overlay capped at 85% of terminal height, with question history, current question, answer/error, and footer. `Esc` aborts; `x` clears the current session's side history; arrow keys scroll (`btw-ui.ts:40-47`, `:104-156`). `session_compact` and `session_tree` invalidate snapshots, with narrowly scoped handling for stale session-replacement errors (`btw.ts:275-307`).

Tests cover execution/error/cancel branches, snapshot behavior, command behavior, overlay rendering, scrolling, width safety, compatibility loading, and package ship files (`btw.test.ts`, `btw.command.test.ts`, `btw-ui.test.ts`, `pi-compat.test.ts`, `ship-manifest.test.ts`).

### Strengths and risks

Strengths: explicit cache invalidation; strong test contract; stable provider prefix via original message object reuse; clear separation between temporary overlay and main transcript; careful compat fallback.

Risks: `globalThis`/`Symbol.for` state can outlive a session runtime and complicate reload/cleanup; snapshot keying by session file is weaker than explicit branch identity; cross-session hints add policy and privacy surface; non-streaming answer delivery is less responsive. The architecture is a useful set of hardening ideas but should not be copied wholesale into Pi Basics.


## 4. Firstp1ck/npm-packages

### Shape

`pi-extension-btw/index.ts` registers `/btw`, `/btw-transfer`, and `/btw-status`. The package also has `side-thread.ts`. The side thread is transient, has no tools, and is rendered through different projections depending on execution mode (`index.ts:489-627`).

### Execution and context

The first prompt gets a textual transcript built from the current branch using `buildSessionContext` and `convertToLlm`; later prompts append only the side-thread follow-up (`index.ts:75-106`, `side-thread.ts:32-53`). The stream executor uses `@earendil-works/pi-ai/compat.stream`, a bounded token response, a no-tools system prompt, and an abort signal (`index.ts:391-486`). A promise tail serializes concurrent submissions and session shutdown aborts active and queued work (`side-thread.ts:3-78`).

`/btw-transfer` can send either the full thread or a generated summary to the main agent via a steering message. The transfer payload is decoded from base64url JSON directly and has no schema/size validation (`index.ts:603-621`), which is a boundary to harden before reuse.

### UI and tests

TUI uses a centered overlay with streaming output, bounded answer rows, scrolling, and close/abort controls. RPC/WebUI uses versioned widgets (`btw:output`, `btw:footer`) and throttled updates; non-TUI/RPC falls back to notification (`index.ts:184-385`, `:507-590`).

The only test file, `tests/side-thread.test.mjs:37-101`, checks first-context behavior, follow-up ordering, and shutdown rejection. It does not cover command registration, model stream events, UI rendering, transfer validation, auth/error paths, or RPC cancellation.

### Strengths and risks

Strengths: responsive streaming; a clean serial queue; mode-specific rendering; explicit transfer action rather than automatic transcript pollution.

Risks: wider scope than the current Pi Basics requirement; peer dependencies are unbounded; WebUI/widget protocol increases compatibility surface; transfer and summary boundaries are under-validated; test coverage is comparatively thin. Reuse the serial queue and streaming state ideas only if the first TUI version proves that non-streaming latency is a problem.

## Baseline recommendation for Pi Basics

Use `narumiruna/pi-extensions` as the initial structural baseline:

1. Keep `SideThread` semantics: main branch context is injected once, successful turns are committed, failed/aborted turns never enter the next provider request.
2. Keep the no-tools system prompt and current-model/auth resolution, but adapt it to the existing `HePiRuntimeContext` and `pi-basics` strict TypeScript rules.
3. Rebuild the transcript component using `packages/pi-basics/src/ui/text.ts`, the Pi Basics semantic theme, and the existing `ctx.ui.custom` lifecycle pattern used by Ask.
4. Make the runtime explicitly session-scoped and dispose it through `HePiLifecycleController`; do not use `globalThis`, `Symbol.for`, or disk persistence for the first version.
5. Add `rpiv`-style focused tests for cancellation races, successful-only commit, branch/compaction invalidation, auth failures, empty provider output, width-safe rendering, and command rejection outside interactive UI.
6. Defer dbachelder-style sub-agent tools, main-transcript save/inject, model/thinking override commands, cross-session hints, and Firstp1ck-style WebUI transfer until separate requirements justify them.

This recommendation was based on migration risk and alignment with the Pi Basics runtime. The implementation later landed as the independent `packages/pi-btw` workspace with behavior tests before visual polish.

## Verification performed

The four repositories were cloned with `git clone --depth 1`. Their latest revisions were recorded above. Source and tests were read; no reference repository test suite was run, and no production `pi-basics` code was changed in this research step.
