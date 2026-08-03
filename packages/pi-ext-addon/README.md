# @hheei/pi-ext-addon

Pi host addons. Current addon enables local mouse selection for assistant text and expanded thinking
when used with HEPI's patched `@earendil-works/pi-coding-agent@0.83.0` bridge. It preserves normal Pi
rendering when the bridge is unavailable. Local selection uses `selectedBg`; it does not copy text or
access the clipboard.

Install this package together with `@hheei/pi-ext-core`. Future host addons, including statusbar
integration, share this package's lifecycle but remain separately documented features.
