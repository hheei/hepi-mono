# @hheei/hepi-aft

HEPI-owned Pi adapter for [Agent File Tools](https://github.com/cortexkit/aft).
It uses the public `@cortexkit/aft-bridge` transport and currently registers:

- `aft_outline`: structural source and document outlines.
- `aft_zoom`: symbol and document-section inspection.

Install it as a separate Pi package:

```bash
pi install npm:@hheei/hepi-aft
```

On session start, the adapter resolves AFT `0.49.0`, migrates AFT storage when
needed, and starts an AFT bridge pool. A startup failure leaves the tools
registered but unavailable with an actionable tool error; it does not replace
Pi's built-in tools.

This first surface intentionally does not register or replace `read`, `write`,
`edit`, `grep`, or `bash`. It can therefore coexist with HEPI FFF, RTK, and the
Codex apply-patch tool. AFT uses its normal CortexKit storage directory and
does not yet load `aft.jsonc` feature/configuration tiers through HEPI.

Do not install it together with an external `@cortexkit/aft-pi` extension: both
register `aft_outline` and `aft_zoom`.
