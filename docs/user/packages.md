# Package Catalogue

这是当前软件包清单。所有功能均发布为 `@hheei` 作用域下、可独立安装的
`pi-<name>` 扩展。

| Package | Purpose | Requirements |
| --- | --- | --- |
| [`pi-debug`](../../packages/pi-debug/README.md) | Development diagnostics and deterministic TUI replay | Pi host, ext-core |

Independent extensions:

| Package | Purpose | Requirements |
| --- | --- | --- |
| [`pi-ext-tools`](../../packages/pi-ext-tools/README.md) | Canonical Pi coding tools and FFF enhancements | Pi host, `pi-ext-core` |
| [`pi-settings`](../../packages/pi-settings/README.md) | `/ext-settings` host for registered provider and extension pages | Pi host, `pi-ext-core` |
| [`pi-loadout`](../../packages/pi-loadout/README.md) | Tool and skill activation policy plus its Settings page | Pi host, `pi-ext-core`, `pi-settings` |
| [`pi-ext-addon`](../../packages/pi-ext-addon/README.md) | Pi host addons; current feature is assistant/thinking local selection | Pi host, `pi-ext-core`, HEPI Pi `0.83.0` bridge |
| [`pi-dollar-skill`](../../packages/pi-dollar-skill/README.md) | `$skill-name` autocomplete and skill path references | Pi host, `pi-ext-core` |
| [`pi-t2s`](../../packages/pi-t2s/README.md) | Traditional-to-simplified Chinese input transformation | Pi host, `pi-ext-core` |

软件包 README 说明安装和兼容性。跨软件包概念、架构和贡献规则放在
`docs/`；详细 TypeScript API 和实现行为写在代码旁的注释中。
