# @hheei/pi-ext-addon

A collection of independent, opt-in host enhancement features for Pi:

- **Dollar skill references (`dollar-skill`)**: Autocompletes `$skill-name`, expands references into skill file paths, and provides atomic editor navigation. Disabled by default (opt-in).
- **Auto session title (`auto-title`)**: Generates a concise, searchable session title after the first settled turn, or manually on demand via `/auto-title`. Disabled by default (opt-in).

## Install

Install through Pi's package manager or add `@hheei/pi-ext-addon` to your Pi package configuration:

```bash
pi install npm:@hheei/pi-ext-addon
```

The extension entrypoint is at `dist/extension.js`.

## Configuration

All features in this addon are strictly **opt-in** and individually configurable in `/ext-settings`:

- `dollar-skill`: `enabled` (default `false`), `maxSuggestions` (default `50`)
- `auto-title`: `autoTitle` (default `false`), `autoTitleModel`
