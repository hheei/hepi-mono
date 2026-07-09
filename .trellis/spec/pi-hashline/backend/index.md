# pi-hashline Backend Guidelines

`pi-hashline` provides hashline-anchored file tools for Pi. Its backend contract is the model-facing tool protocol and the lazy state that keeps anchors stable.

## Pre-Development Checklist

- Read `.trellis/spec/guides/hepi-mono-project-conventions.md`.
- Read `packages/pi-hashline/AGENTS.md` before touching tool behavior.
- Read `docs/lazyhashline.md` before changing `read`, `grep`, `insert`, `edit`, lazy state, or persistence.
- Preserve strict semantics: reject bad shapes and stale anchors instead of guessing.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Lazy Hashline Contract](./lazyhashline-contract.md) | File-scoped lazy anchors, tools, state, and validation | Filled |

## Quality Check

- From `packages/pi-hashline`, run `bun run typecheck`.
- From `packages/pi-hashline`, run `bun run test`.
- Lazy hashline behavior changes must include focused tests under `test/integration/` or `test/core/` for the affected invariant.
