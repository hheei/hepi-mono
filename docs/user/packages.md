# Package Catalogue

这是当前软件包清单。旧的 `hepi-*` 软件包仅用于过渡；新功能发布为
`@hheei` 作用域下、可独立安装的 `pi-<name>` 扩展。

| Package | Purpose | Requirements |
| --- | --- | --- |
| [`hepi-mono`](../../packages/hepi-mono/README.md) | **Deprecated.** Former unified bundle; do not install for new setups. | Pi host, `ffi-rs` |
| [`hepi-basics`](../../packages/hepi-basics/README.md) | Transitional foundational bundle | Pi host |
| [`hepi-tools`](../../packages/hepi-tools/README.md) | Transitional tool and agent bundle | Pi host, `ffi-rs` |
| [`hepi-mctx`](../../packages/hepi-mctx/README.md) | Transitional Magic Context bundle | Pi host |
| [`hepi-skills`](../../packages/hepi-skills/README.md) | Transitional skills bundle | Pi host |
| [`hepi-debug`](../../packages/hepi-debug/README.md) | Development diagnostics and deterministic TUI replay | Pi host |

Independent extensions:

| Package | Purpose | Requirements |
| --- | --- | --- |
| [`pi-settings`](../../packages/pi-settings/README.md) | `/ext-settings` host for registered provider and extension pages | Pi host, `pi-ext-core` |
| [`pi-loadout`](../../packages/pi-loadout/README.md) | Tool and skill activation policy plus its Settings page | Pi host, `pi-ext-core`, `pi-settings` |
| [`pi-t2s`](../../packages/pi-t2s/README.md) | Traditional-to-simplified Chinese input transformation | Pi host, `pi-ext-core` |
| [`pi-ponytail`](../../packages/pi-ponytail/README.md) | Ponytail engineering minimalism mode and companion skills | Pi host, `pi-ext-core` |
| [`pi-caveman`](../../packages/pi-caveman/README.md) | Caveman concise communication mode | Pi host, `pi-ext-core` |

`pi-ponytail` 与 `pi-caveman` 各自拥有一个 Pi 扩展入口、命令、会话状态、
设置提供者和提示词注入逻辑。Ponytail 的五个辅助 skill 随该软件包发布；
Caveman 当前没有额外 skill 目录。两者都通过 `@hheei/pi-ext-core` 使用
生命周期和设置注册能力，不依赖另一个具体扩展或旧的 `hepi-skills`。

软件包 README 说明安装和兼容性。跨软件包概念、架构和贡献规则放在
`docs/`；详细 TypeScript API 和实现行为写在代码旁的注释中。
