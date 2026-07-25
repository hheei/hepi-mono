# @hheei/pi-ponytail

A session-scoped Pi extension that applies the smallest correct engineering approach using rules adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail).

The extension owns persistent mode state and prompt injection. Five companion workflows ship as Pi skills and do not register commands.

## Install

Install the local package from this monorepo into your user Pi settings:

```bash
pi install ./packages/pi-ponytail
```

Use `pi install -l ./packages/pi-ponytail` for a project-local installation. Pi loads both the extension and companion skills from the package manifest. After publication, install it from npm:

```bash
pi install npm:@hheei/pi-ponytail
```

## Command

```text
/ponytail
/ponytail lite
/ponytail full
/ponytail ultra
/ponytail off
/ponytail status
```

`/ponytail` without an argument selects `full`. Pi autocomplete lists all modes, `off`, and `status` with a detailed description. Mode changes print a one-line confirmation such as `※ Ponytail mode enabled: ultra.` without adding a persistent status indicator. The standalone phrases `stop ponytail` and `normal mode` disable it without matching incidental mentions inside a longer request.

## Companion Skills

The package publishes these skills without registering top-level commands or `/ponytail` subcommands:

```text
/skill:ponytail-review
/skill:ponytail-audit
/skill:ponytail-debt
/skill:ponytail-gain
/skill:ponytail-help
```

The core `ponytail` skill is intentionally omitted because the extension injects those persistent rules through `before_agent_start`.

## Defaults

With `@hheei/pi-basics` loaded, open `/ext-settings` and select **Ponytail defaults**. Settings are global in `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`):

```json
{
  "pi-ponytail": {
    "defaults": {
      "mainMode": "full",
      "subagentMode": "full"
    }
  }
}
```

Valid modes are `lite`, `full`, `ultra`, and `off`. `pi-basics` is optional; the JSON configuration still works without its Settings UI.

## State And Lifecycle

- New sessions use the configured main-agent or subagent default.
- Explicit mode changes are stored as Pi custom session entries.
- Resume, fork, and `/tree` navigation restore the mode visible on the selected branch.
- `off` removes prompt injection.
- Ponytail does not add passive status or startup UI.

## Compatibility

Requires `@earendil-works/pi-coding-agent` 0.80.10 or newer. `@hheei/pi-basics` is an optional peer loaded through its package-root public API.

For `pi-subagents`, child sessions that load extensions use `subagentMode`. The parent also marks prompts passed through the `Agent` tool, covering isolated agents and agents with extension inheritance disabled. A loaded child recognizes the marker and avoids duplicate injection.

No tools, model providers, telemetry, or network calls are added. Filesystem writes occur only when the HEPI Settings provider saves the global Pi settings file.

## Development

```bash
bun test packages/pi-ponytail
bun run typecheck
bunx biome check packages/pi-ponytail
```

## Attribution

Behavior and companion skills are adapted from Dietrich Gebert's Ponytail project at revision `16f29800fd2681bdf24f3eb4ccffe38be3baec6b`, licensed under MIT. See `LICENSE` for both copyright notices.
