# Publishing Packages

HEPI publishes prebuilt npm tarballs. Source repositories do not track `dist`.

## Release Check

Update every package version being released, then run:

```bash
bun run clean
bun run check
bun run pack:check
```

`pack:check` executes every package `prepack` hook and checks that its Pi entry
exists. It covers `@hheei/hepi-basics`, `@hheei/hepi-tools`,
`@hheei/hepi-skills`, `@hheei/hepi-aft`, `@hheei/hepi-mctx`,
`@hheei/hepi-subagents`, and `@hheei/hepi-mono`.

## Publish Order

Publish selective packages before the unified bundle:

```text
hepi-basics, hepi-tools, hepi-skills, hepi-aft, hepi-mctx, hepi-subagents, hepi-mono
```

Each publish command runs from its package directory. Publish only after the
tarball check and a real Pi smoke test of the intended install composition.
