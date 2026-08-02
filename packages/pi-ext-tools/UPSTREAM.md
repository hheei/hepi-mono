# HEPI FFF Upstream Tracking

`src/fff/` is an HEPI-owned adaptation of
[ShpetimA/pi-fff](https://github.com/ShpetimA/pi-fff), initially based on:

- URL: `https://github.com/ShpetimA/pi-fff.git`
- Revision: `694837d0644abc8527ebfa3ea50135e0f5d1ece4`
- Local reference clone: `references/repos/ShpetimA-pi-fff`

Source attribution and MIT license are in
`packages/pi-ext-tools/THIRD_PARTY_NOTICES.md`. The reference clone is ignored;
do not copy it into `packages/`.

## Intentional Differences

HEPI FFF owns runtime, commands, enhancement adapters, formatting, and persistence. It deliberately
never adopts upstream `src/editor.ts` or `FffEditor`, because upstream replaces Pi's editor through
`ctx.ui.setEditorComponent(...)` and would conflict with Pi Basics statusbar and dollar-skill editor wrapping.

`autocomplete.ts`, `lifecycle.ts`, and `settings.ts` are HEPI-specific. They compose `@path` completion with
Pi's current provider and integrate core lifecycle/settings without a custom editor. Canonical `read`, `grep`,
and `find` retain their upstream schemas; FFF only accelerates a semantics-compatible request.

## Updating

Fetch and inspect upstream before copying changes:

```bash
git -C references/repos/ShpetimA-pi-fff fetch origin
git -C references/repos/ShpetimA-pi-fff diff --stat \
  694837d0644abc8527ebfa3ea50135e0f5d1ece4..origin/main -- src
```

Compare adaptations with:

```bash
diff -ru references/repos/ShpetimA-pi-fff/src packages/pi-ext-tools/src/fff
```
