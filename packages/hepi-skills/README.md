# @hheei/hepi-skills

Self-contained HEPI skills bundle for Pi. Its published `dist` entry contains
Ponytail and Caveman behind one extension entry and one JIT boundary, and
includes Ponytail's skills for Pi resource discovery.

Included extension modules:

- `pi-ponytail`
- `pi-caveman`

Included auxiliary skills:

- `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`, and `ponytail-review`
- `grill-me` and `grill-with-docs`, explicit entry skills for a design interview
- `grilling`, the interview workflow used by both Grill entry skills
- `domain-modeling`, which keeps a glossary and ADRs while grilling with documentation

`grill-me` and `grill-with-docs` deliberately disable model invocation. Invoke
them explicitly as `/skill:grill-me <plan>` or `/skill:grill-with-docs <plan>`.
`grilling` and `domain-modeling` remain discoverable by their descriptions. Pi
Basics Loadout sees every included skill as a `skill:<name>` item; disabling one
removes it from the model prompt for the active branch.

Git releases include this bundle through `hepi-mono`:

```bash
pi install git:github.com/hheei/hepi-mono@<tag>
```

Build locally with `bun run build` from this package or
`bun run build:aggregates` from the repository root. Do not install this
package together with `@hheei/hepi-mono`; the unified bundle already contains
these modules.
