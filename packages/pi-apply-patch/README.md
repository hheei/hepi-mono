# @hheei/pi-apply-patch

Standalone `apply_patch` extension for Pi. Install with `pi install npm:@hheei/pi-apply-patch`. The tool is registered with `defaultActive: false`; enable it through your loadout.

Owns V4A parsing, pure JavaScript jsdiff worker matching, per-path publishing, partial outcomes and the `applyPatch` group in `ext_settings.json`. Confirmed edits persist after failure or cancellation. File mutation locks are shared with `edit` and `write` through ext-core.

No file tools, Bash, Python or UI extension is required. Optional UI rendering comes through ext-core; native tool text remains available without it. Worker code is included in `dist`.

See [architecture](../../docs/architecture/apply-patch.md) and [migration](../../docs/ext-tools/README.md).
