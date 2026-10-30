# @hheei/pi-web-access

Web search, URL fetching, GitHub repo extraction, and content tools for Pi. Install with `pi install npm:@hheei/pi-web-access`.

## Tools

Registers four web tools plus a `web_enable` loader, each renamable through `toolNames` in the config section:

| Default name | Purpose |
| --- | --- |
| `web_search` | Source-linked results or provider answers; `queries` runs 2-4 angles concurrently. Full results are stored for `get_search_content`. |
| `fetch_content` | Fetch one URL and return extracted content (HTML to markdown, PDF, GitHub repo/issue/PR, video frames). |
| `get_search_content` | Retrieve the full stored results of an earlier search by `responseId`. |
| `source_check` | Gather bounded passage-level citations for a claim, for manual review. |
| `web_enable` | Activate the configured web tools on the next model request; it never searches or fetches. Registered unless discovery is already handled elsewhere (`toolExposure: "deferred"`, `toolActivation` of `eager`/`deferred`/`disabled`, or `enableWebLoader: false`). |

`toolActivation` defaults to `auto` and infers `toolExposure: "direct"`, so the web tools register with `exposure: "direct"` and `defaultActive: true`. In a fresh session on a model that supports mid-conversation tool additions, they still start inactive with only `web_enable` active; resumed transcripts, sessions that predate transcript tool declarations, and models without that support keep them eagerly active. Set `toolExposure: "deferred"` to register them with `exposure: "deferred"` and `defaultActive: false` so `tool_search` discovers them on demand; `deferred` cannot be combined with `toolActivation: "eager"`.

Commands: `/websearch` (search curator), `/curator` (toggle or configure the curator workflow), `/search` (browse stored results), `/google-account` (active Gemini Web account).

## Configuration

Config lives in the `webSearch` section of `<agentDir>/ext_settings.json`, with a project override in `<cwd>/.pi/ext_settings.json` deep-merged over the global section. With `@hheei/pi-settings` installed, the same section appears as the "Web Access" page in `/ext-settings`.

Keys: `searchProvider` (single provider, list, or `auto` when none is configured), `toolNames`, `toolActivation`, `toolExposure`, `enableWebLoader`, `workflow`, `summaryModel`, `curatorRemote`, `autoOpenBrowser`, `shortcuts`, `tools.<name>.enabled` (gates registration of `webSearch`, `sourceCheck`, `fetchContent`, `getSearchContent`), `webSearch.enabled` (turns off `web_search` and `source_check`), `webSearch.allowedProviders`, `commands.<name>.enabled`, `fetch.defaultMode` / `fetch.allowedModes`, `fetch.answerProvider` / `fetch.answerModel` (defaults for `mode: "answer"`, overridable per call through `fetch_content`'s `answerModel`), `ssrf.allowRanges` / `ssrf.trustEnvProxy`, and `authFetch` profiles for credentialed hosts. Provider keys come from the same section and may reference `$ENV_NAME` or a command source. Unknown or malformed values fail loudly with the offending key name rather than falling back silently.

Browser-cookie extraction (`chrome-cookies`) and Gemini Web reuse an existing browser session; PDF and video extraction need the external binaries their modes document (`yt-dlp`, `ffmpeg`).

## Compatibility

Requires Pi host `>=1.3.0`. No other HEPI extension is required: settings and rendering primitives come from `@hheei/pi-ext-core`, and richer tool views appear only when `@hheei/pi-ext-ui` is loaded. Native tool text stays complete without it.
