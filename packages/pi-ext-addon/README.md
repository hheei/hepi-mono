# @hheei/pi-ext-addon

Pi extension addon pack providing opt-in host enhancements:

- **OpenAI Responses replay compatibility**: Strips status fields and normalizes message IDs for non-standard OpenAI compatible gateways.
- **Dollar skill references**: `$skill-name` autocomplete, input expansion to skill file paths, and atomic editor navigation. Disabled by default (opt-in).
- **Auto Title generation**: Automatically generates a concise session title after the first settled turn, or via `/auto-title`. Disabled by default (opt-in).

## Install

Install through Pi package manager or add `@hheei/pi-ext-addon` to your Pi package configuration:

```bash
pi install npm:@hheei/pi-ext-addon
```

The extension entrypoint is at `dist/extension.js`.

## Configuration

All features in this addon are strictly **opt-in** and can be configured in `/ext-settings`:

- `openai-responses-compat`: `stripAssistantMessageStatus`, `normalizeAssistantMessageId`
- `pi-dollar-skill`: `enabled` (default `false`), `maxSuggestions` (default `50`)
- `auto-title`: `autoTitle` (default `false`), `autoTitleModel`
