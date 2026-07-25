# @hheei/pi-caveman

A session-scoped Pi extension that keeps responses concise using rules adapted from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman).

Unlike the upstream Agent Skill integration, this package owns real Pi runtime state. It registers a command, observes natural-language activation, and injects the active rules through `before_agent_start`.

## Install

Install the local package from this monorepo into your user Pi settings:

```bash
pi install ./packages/pi-caveman
```

Use `pi install -l ./packages/pi-caveman` for a project-local installation. After publication, install it from npm:

```bash
pi install npm:@hheei/pi-caveman
```

## Command

```text
/caveman
/caveman lite
/caveman full
/caveman ultra
/caveman wenyan
/caveman wenyan-lite
/caveman wenyan-full
/caveman wenyan-ultra
/caveman off
/caveman status
```

`/caveman` without an argument selects `full`. `wenyan` is an alias for `wenyan-full`. Pi autocomplete lists every canonical mode, `off`, and `status` with a detailed description. Mode changes print a one-line confirmation such as `※ Caveman mode enabled: ultra.` without adding a persistent status indicator.

The extension also recognizes explicit English activation phrases such as `talk like caveman`, `use ultra caveman mode`, `normal mode`, and `stop caveman`.

## Defaults

With `@hheei/pi-basics` loaded, open `/hepi setting` and select **Caveman defaults**. Two enum fields are available:

- `Main agent mode`: default for the interactive Pi session.
- `Subagent mode`: default for agents launched through `pi-subagents`.

The provider stores global configuration in `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`) without replacing other settings:

```json
{
  "pi-caveman": {
    "defaults": {
      "mainMode": "full",
      "subagentMode": "ultra"
    }
  }
}
```

Valid values are `lite`, `full`, `ultra`, `wenyan-lite`, `wenyan-full`, `wenyan-ultra`, and `off`. `pi-basics` is optional; without it, the same JSON configuration still works but has no HEPI Settings UI.

## State And Lifecycle

- New sessions use the configured main or subagent default. Both default to `full` when unset.
- Mode changes are stored as Pi custom session entries, not global files.
- Reloading or resuming restores the latest mode from the active session branch.
- Forks and `/tree` navigation restore the mode visible at the selected branch point.
- `off` removes the injected prompt.
- Session shutdown clears extension-owned UI state.

No tools, model providers, telemetry, or network calls are added. Filesystem writes occur only when the HEPI Settings provider saves the global Pi settings file.

## Compatibility

Requires `@earendil-works/pi-coding-agent` 0.80.10 or newer. `@hheei/pi-basics` is an optional peer loaded through its package-root public API.

`pi-subagents` compatibility has two paths:

- Subagent sessions that load extensions detect their independent Pi session and use `subagentMode` as the branch fallback.
- Calls to the `Agent` tool receive a marked prompt reinforcement. This also covers `isolated: true` and custom agents configured with `extensions: false`; loaded child extensions recognize the marker and avoid duplicate injection.

An explicit `/caveman` selection stored in a session branch overrides its configured default. This extension injects communication guidance into prompts; model compliance is not a byte-level output transformation.

## Development

```bash
bun test packages/pi-caveman
bun run typecheck
bun run check
```

## Attribution

Prompt behavior is adapted from Julius Brussee's Caveman project at revision `0d95a81d35a9f2d123a5e9430d1cfc43d55f1bb0`, licensed under MIT. See `LICENSE` for both copyright notices.
