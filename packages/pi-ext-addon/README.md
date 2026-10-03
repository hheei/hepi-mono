# @hheei/pi-ext-addon

A collection of independent, opt-in host enhancement features and resilience guards for Pi:

- **Dollar skill references (`dollar-skill`)**: Autocompletes `$skill-name`, expands references into skill file paths, and provides atomic editor navigation. Disabled by default (opt-in).
- **Auto session title (`auto-title`)**: Generates a concise, searchable session title after the first settled turn, or manually on demand via `/auto-title`. Disabled by default (opt-in).
- **Batch tool rules (`batch-tool-rules`)**: Injects tool execution rules into the system prompt instructing the model to batch as many tool calls as possible in a single turn via `codemode` or `eval` when available. Enabled by default with customizable prompt in settings.
- **Codemode guard (`codemode-guard`)**: Automatically detects single-tool execution patterns in `codemode` (especially on Gemini models) and injects an advisory system reminder after 4 consecutive single-call turns to encourage parallel batching.
- **Session recovery guard (`session-recovery-guard`)**: Intercepts upstream API 409 (`request_rejected`, "当前会话不可用，请新开会话。") errors before settle on GPT series models. It transparently initiates `pi-ext-memory` compaction to summarize and reset invalid history; in environments without memory (such as subagents) or when compaction is unready, it strips invalidated encrypted reasoning (`thinking`) signatures and retries cleanly, avoiding session death or manual forks.

## Install

Install through Pi's package manager or add `@hheei/pi-ext-addon` to your Pi package configuration:

```bash
pi install npm:@hheei/pi-ext-addon
```

The extension entrypoint is at `dist/extension.js`.

## Configuration

Features in this addon can be configured through `/ext-settings`:

- `dollar-skill`: `enabled` (default `false`), `maxSuggestions` (default `50`)
- `auto-title`: `autoTitle` (default `false`), `autoTitleModel`
- `batch-tool-rules`: `enabled` (default `true`), `prompt`
- `session-recovery-guard`: Active automatically to protect long-running sessions from 409 request rejections.
