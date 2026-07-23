# @hheei/pi-fix

Compatibility fixes for Pi. Requires `@hheei/pi-basics`.

## Apply patch guard

`Guard patch` aborts streamed shell `apply_patch` commands when configured. `auto` guards only when no `apply_patch` tool is available; `on` always guards; `off` disables it. Settings persist under `pi-basics.guardPatch` in `<cwd>/.pi/settings.json`.

## OpenAI Responses compatibility

`Strip status` removes unsupported replayed assistant `message.status`; `Normalize IDs` rewrites `item_` message IDs to `msg_`. Both are disabled by default and leave reasoning/tool items unchanged. Settings persist under `pi-basics.openai-responses-compat`.

Configure both groups through `/ext-settings`. Enable provider fixes only for gateways that reject the official fields.
