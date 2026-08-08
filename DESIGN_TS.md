## TypeScript

- **MUST** keep strict TypeScript enabled, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; **NEVER** weaken compiler settings to land a change.
- Use `unknown` plus runtime narrowing for untrusted data. **NEVER** use explicit `any`, `@ts-ignore`, `@ts-nocheck`, production non-null assertions, `enum`, or `namespace`.
- Validate API, file, environment, and third-party data at runtime; prefer focused guards for small shapes and the existing TypeBox stack for shared/complex schemas.
- Prefer discriminated unions, exhaustive handling, composition over inheritance, readonly shared data, and explicit return types for exported/public APIs.
- Avoid type assertions except unavoidable interop gaps; `as const` is encouraged.
- Every Promise **MUST** be awaited, returned, rejection-handled, or intentionally discarded with `void`.
- Keep boolean/null/undefined semantics explicit and treat optional properties as potentially absent.
- Tests may use non-null assertions for clear fixture invariants.
- Temporary `@ts-expect-error` is allowed only with a reason and removal condition.
- Keep `compilerOptions.types` as an explicit allowlist.

