# HEPI FFF Upstream Tracking

This directory is an HEPI-owned adaptation of
[ShpetimA/pi-fff](https://github.com/ShpetimA/pi-fff), initially based on:

- URL: `https://github.com/ShpetimA/pi-fff.git`
- Revision: `694837d0644abc8527ebfa3ea50135e0f5d1ece4`
- Local reference clone: `references/repos/ShpetimA-pi-fff`

The source attribution and MIT license are in
`packages/hepi-tools/THIRD_PARTY_NOTICES.md`. The reference clone is ignored;
do not copy it into `packages/`.

## Intentional Differences

HEPI FFF owns the FFF runtime, commands, tools, formatting, and persistence.
It deliberately does not adopt upstream `src/editor.ts` or `FffEditor`.
Upstream owns the editor through `ctx.ui.setEditorComponent(...)`, which would
replace Pi Basics statusbar and dollar-skill's atomic editor wrapper.

`autocomplete.ts` is HEPI-specific. It composes `@path` completion with the
current Pi autocomplete provider through `ctx.ui.addAutocompleteProvider(...)`.
Non-`@` input delegates to the prior provider, preserving `$skill` completion.
`index.ts` is also HEPI-specific: it integrates feature lifecycle and Loadout
without installing a custom editor.

Copied-and-adapted modules correspond directly to upstream `src/` files with
the same names:

- `error-format.ts`, `errors.ts`, `extension-common.ts`
- `fff-format.ts`, `fff-runtime.ts`, `fff-types.ts`, `fff.ts`
- `register-commands.ts`, `register-tools.ts`, `result-utils.ts`, `runtime-paths.ts`

## Updating

Fetch the upstream reference and inspect its changes before copying anything:

```bash
git -C references/repos/ShpetimA-pi-fff fetch origin
git -C references/repos/ShpetimA-pi-fff diff --stat \
  694837d0644abc8527ebfa3ea50135e0f5d1ece4..origin/main -- src
git -C references/repos/ShpetimA-pi-fff diff \
  694837d0644abc8527ebfa3ea50135e0f5d1ece4..origin/main -- src/fff-runtime.ts
```

Compare the current adaptation against the reference clone with:

```bash
diff -ru references/repos/ShpetimA-pi-fff/src packages/hepi-tools/src/fff
```

Expected differences include upstream `editor.ts` being absent locally and
local `autocomplete.ts` being absent upstream. Preserve the provider-based
design when applying upstream changes. Afterwards, update this revision,
`references/README.md`, and `THIRD_PARTY_NOTICES.md`, then run:

```bash
bun run typecheck
bun test packages/hepi-tools/test/fff/autocomplete.test.ts
```
