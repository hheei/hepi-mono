# @hheei/pi-codex-tool

Pi extension that exposes one tool: `apply_patch`.

The extension registers the structured `apply_patch` tool and its native cross-platform executor. It does not register shell tools, Code Mode, providers, web search, image tools, voice, compaction, settings commands, or background widgets.

## Load from this workspace

```bash
pi --no-extensions \
  -e packages/pi-codex-tool/src/index.ts \
  --model cx/gpt-5.6-luna --tools apply_patch
```

Or load the source entry directly:

```bash
pi --no-extensions \
  -e /Users/supercgor/Documents/dev/hepi-mono/packages/pi-codex-tool/src/index.ts \
  --tools apply_patch
```

`--tools apply_patch` keeps Pi's active model tool list limited to this tool. The extension itself only registers `apply_patch`.

Requires Pi `0.82.0` or newer and Node.js 22.19 or newer.

## Patch format

Use the Codex patch format:

```text
*** Begin Patch
*** Update File: path/to/file.ts
@@
-old line
+new line
*** End Patch
```

The executor supports add, update, delete, and move actions. Patch results include changed, created, deleted, and moved file counts. Partial failures report files already applied and files that must be read before retrying.

## License

MIT. Bundled native components retain their upstream licenses and notices.
