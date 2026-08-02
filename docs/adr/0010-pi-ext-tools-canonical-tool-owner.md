# pi-ext-tools 作为基础工具的 Canonical tool owner

`@hheei/pi-ext-tools` 将静态注册明确 catalog 内的 Pi upstream/basic tool replacement；v1 为 `read`、`edit`、
`write` 和 `bash`。每个 tool name 只有一个 Pi-visible definition，`pi-ext-tools` 直接拥有 upstream compatibility、
renderer 与可选 selection；不建立 priority-based duplicate registration 或通用 tool-override framework。

## 考虑过的方案

- 多个 `registerManagedLoadoutTool()` definition 按 priority 选择最高 implementation。
- 由 `pi-ext-core` 为任意 native tool 提供 generic override/transform pipeline。
- 维持 `pi-fff` 的 `read` registration，并为每个 feature 独立注册同名 wrapper。

## 后果

`pi-ext-tools` 是 catalog name 的唯一 owner；其他 concrete extension 不得竞争注册。第一阶段将 `pi-fff` 拆分为
`pi-ext-tools` 的 `read` 与仍由 `pi-fff` 提供的 grep/find/FFF runtime，旧 `pi-fff` 与新 `pi-ext-tools` 不兼容。
`read` 的 auto-copy selection 是 concrete tool policy；core 保持 clipboard-neutral。
