## Product Constraints

- **MUST** keep meaningful reads, commands, edits, delegation, retries, fallbacks, and model changes inspectable.
- **NEVER** silently select, replace, or route models/providers; subagents should inherit the caller's model unless explicitly overridden.
- **SHOULD** keep baseline prompts and tool schemas small, loading skills, references, catalogs, and volatile metadata only when needed.
- **AVOID** always-on reviewers, advisors, background agents, orchestration loops, and opaque automation.
- **MUST** preserve complete results even when UI output is collapsed, and keep sensitive, privileged, expensive, or setup-heavy capabilities opt-in.
- **SHOULD** build complex behavior from visible, composable primitives rather than hidden commands or modes.

**Product rule:** No hidden intent. No silent routing. No blind automation.

## Engineering

- **SHOULD** delete obsolete APIs, layouts, adapters, and compatibility layers after checking callers, persistence, resume/fork behavior, and public contracts.
- **NEVER** add speculative abstractions, extension points, compatibility shims, or configuration for unconfirmed requirements.
- Build the smallest runnable end-to-end path first; split only at real ownership, lifecycle, concurrency, or public-contract boundaries.
- **MUST** preserve validation, cancellation, cleanup, concurrency safety, error propagation, accessibility, and data safety.
- Before adding infrastructure, inspect existing implementations, dependencies, standard/platform APIs, and relevant upstream references.
- **AVOID** temporary adapters, unnecessary dependencies, duplicated infrastructure, and file splitting done only to reduce file length.
- **MUST** keep unrelated user changes untouched.
- read `DESIGN_TS.md` before write any typescript.

## Tooling

直接在仓库根目录使用 `pnpm`（系统已安装独立版，无需 `corepack` 或 `npx` 包装）：

```bash
# Biome: 检查并自动修复指定文件
pnpm exec biome check --write <paths...>

# Biome: 仅检查指定文件
pnpm exec biome check <paths...>

# 测试: 运行单个或多个指定测试文件
pnpm exec vitest run <test-paths...>

# 全量校验 (提交前)
pnpm run check:fix
pnpm run typecheck
pnpm test
```

- 本地日常改动优先对变更文件运行 `biome check --write` 与对应单测。
- 涉及共享接口、依赖或跨包边界变更时，运行根目录 `typecheck` 与完整 `test`。
## Package Boundaries

- Each `packages/pi-<name>/` workspace owns one independent feature or cohesive feature family and exactly one `pi.extensions` entry.
- Concrete extensions **MUST** depend on `@hheei/pi-ext-core`, never directly on another concrete extension; cross-extension cooperation goes through ext-core-owned runtime capabilities.
- `@hheei/pi-ext-core` is a side-effect-free foundation package and **MUST NEVER** import concrete extensions.
- Keep runtime state session-scoped and cleanup idempotent unless persistence is explicitly part of the contract.
- Avoid vendoring external repositories under `packages/`; if unavoidable, vendor the smallest surface and record the upstream URL/revision.
- Events are notifications, not shared state or RPC.

## Architecture Vocabulary

Use these names consistently:

- **Pi host** — `@earendil-works/pi-coding-agent`; owns the session, extension runner, editor, terminal, and native UI.
- **ext-core** — `@hheei/pi-ext-core`; owns reusable lifecycle, cancellation, cleanup, surfaces, widgets, and coordination primitives.
- **Concrete extension** — independently installable `packages/pi-<name>/`; owns feature state, commands/tools, schemas, policy, and rendering.
- **Surface** — ext-core-managed custom TUI lifetime.
- **Widget** — editor-adjacent presentation managed by ext-core.

**NEVER** use unqualified “core” as an owner name.

Architecture proposals should state, in order:

1. user-visible goal and main data/control-flow change;
2. ownership, consumers, cleanup, cancellation, fallback, and concurrency where relevant;
3. a small ASCII flow/state machine when useful;
4. the smallest public contract and focused tests before file-level details.

## Documentation

- Keep `docs/` high-level; implementation details and TypeScript API contracts belong near the code.
- **MUST** document public-contract, architecture, persistence, and meaningful UI/UX changes before implementation; small bug fixes and local refactors may skip new design docs.
- High-level design docs should use Simplified Chinese.
- Document non-obvious invariants around persistence, migration, cancellation, concurrency, validation, fallback, and critical UI behavior.
- Follow `docs/architecture/[extension-reference.md](http://extension-reference.md)` for new extensions.
- [`DESIGN.md`](http://DESIGN.md) is the UI/UX specification and **MUST** be updated when an agreed UI/UX contract changes.
- Treat `docs/plans/` as historical context, not current behavior.

## Workflow

For substantial feature, architecture, persistence, lifecycle/concurrency, public-contract, or UI/UX changes:

1. Inspect repository and relevant upstream implementations.
2. Write/update the high-level design document and explain the proposed boundary/interface.
3. Use `grill-me` or `grill-with-docs` for non-trivial design decisions and reach agreement.
4. Build the smallest runnable end-to-end path and define the smallest required public contract.
5. Add focused tests, implement details, and run focused verification.
6. Commit cohesive changes separately and **NEVER** include unrelated user work.

For small fixes/refactors: inspect callers, make the smallest sound change, update focused tests when behavior changes, and run focused formatting/type/test verification.

For UI work: follow [`DESIGN.md`](http://DESIGN.md), reuse ext-core primitives where appropriate, keep output ANSI/cell-width safe, request rendering after state changes, and test affected narrow/wide layouts.

## Release

```bash
pnpm run publish:dry-run                  # 预演
git tag vX.Y.Z && git push origin vX.Y.Z  # 触发 CI 自动发布
```

## Release Safety

- **MUST** pass the full repository release gate and verify intended versions/dependency ranges before publishing.
- **MUST** obtain explicit approval for the exact externally visible push/tag/publish/release action unless already authorized.
- Use a dry-run when available and report exact packages, versions, or tags before publication.
- **NEVER** treat a successful push, tag, workflow trigger, or command exit as proof of publication; verify the actual CI/CD release result.
- On failure, stop and report evidence. **NEVER** weaken tests, typing, validation, or compatibility constraints merely to make a release pass.
## Key Rules

- **MUST** keep edits focused, typing strict, runtime boundaries validated, and concrete extensions independent.
- **NEVER** silently route models, hide meaningful automation, preserve obsolete HEPI compatibility without need, or modify unrelated user work.
- **SHOULD** prefer simple, visible, composable, and idempotent mechanisms.
- Shared TypeScript baseline: `tsconfig.base.json`; packages extend it.

