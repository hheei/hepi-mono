# pi-ext-tools 基础工具替换

## 状态

这是已确认、尚未实现的 `@hheei/pi-ext-tools` 独立 Pi extension 设计。它不修改 Pi 源码，不引入
`pi-select`，也不让 `pi-ext-core` 解释具体 tool 语义。实现顺序必须是 package framework、focused tests、
tool modules，再实现行为。

## 目标

Pi upstream tool 的同名 replacement 由一个 Canonical tool owner 静态注册，而不是由多个 extension 以 priority
竞争同一个 tool name。`pi-ext-tools` 只在明确的 Tool replacement catalog 内接管名称；Pi、Loadout 与用户始终
只看见该名称的一份 definition。

```text
Pi upstream factory -> pi-ext-tools tool module -> one managed registration -> Pi-visible tool
```

每个 tool module 自己决定如何复用 upstream factory、如何 render、是否支持 selection，以及如何处理特定
feature policy。`pi-ext-core` 仅提供 managed registration、mouse transport 和可缺席的 Host surface bridge。

## v1 Catalog

v1 的显式 catalog 是：

```text
read
edit
write
bash
```

catalog 不从 `pi.getAllTools()` 或 active-tool inventory 自动推断。新增名称必须单独确认 upstream compatibility、
tool schema、rendering、lifecycle、Loadout metadata 与 focused tests。

`read`、`edit`、`write`、`bash` 每个名称只通过一次 `registerManagedLoadoutTool()` 静态注册。不存在 tool-definition
priority、同名 fallback registration 或运行时 provider arbitration。Loadout priority 仍只属于 activation/inventory
policy，不能用于决定哪个 implementation 执行。

## Tool Ownership

- `pi-ext-tools` 是 catalog 中每个名称的唯一 Canonical tool owner，负责 upstream parameter/execute compatibility、
  renderer、ToolRenderContext state、abort、streaming 与 cleanup。
- 每个 module 可以调用对应 upstream `create...Tool()`；这用于复用运行行为，不表示必须复用 upstream renderer。
- `read` 使用 upstream `createReadTool()` 的参数与 execute 语义，但拥有 selection-aware result renderer 和逻辑
  text model。
- `edit`、`write`、`bash` 第一版保留 upstream-compatible 行为，不支持 custom mouse selection。diff、streaming、
  ANSI 或 command-output selection 另行逐项设计，不从 `read` 泛化。
- 其他 extension 不得为 catalog 名称直接 `pi.registerTool()` 或 managed-register competing definition。它们不能
  import `pi-ext-tools`；跨包协作若确有需求，另行定义 narrow core capability。

## Read Selection 与 Copy

`read` 是第一份 selection consumer。它与 `MouseSupport` 和 Runtime host bridge 的关系是：

```text
read logical text model + bridge Host surface snapshot
  -> read-owned SelectableRegion
  -> MouseSupport down / drag / up
  -> TextRange + selection highlight
  -> primary-button up auto-copy
```

- selection 基于 logical text，不反解析 ANSI 或 terminal output。
- visual soft wrap 不生成复制换行；真实 logical newline 保留；每个复制行移除 trailing spaces/tabs，行首空白
  保持不变。
- 无修饰 primary-button `up` 后，`read` 尝试通过系统 clipboard 写入当前 selection。写入异步且不得阻塞 mouse
  dispatch；selection/highlight 无论成功与否保留。
- clipboard 失败时，`read` 每个 surface/session 最多报告一次 Pi native warning，后续 selection release 仍继续
  尝试 copy。rejected Promise 必须被处理。
- bridge 未安装或 unavailable 时，`read` 正常执行和 render，但不注册 host-bound selectable region、不启用 mouse
  tracking，也不伪造成功 copy。

自动 copy 是 `pi-ext-tools/read` policy，不扩张 `pi-ext-core` 的 clipboard boundary；core 仍不在 `up` 时读取
selection、写 clipboard 或发出 copy notification。

## pi-fff 过渡

`pi-ext-tools` 最终取代 `pi-fff`，但第一阶段采取 split migration：

```text
pi-ext-tools: read, edit, write, bash
pi-fff:       grep, find_files, fff_multi_grep, FFF runtime/settings/autocomplete
```

第一阶段的 `pi-ext-tools/read` 不使用 FFF approximate-path resolution，保持 upstream read behavior。`pi-fff`
必须移除自己的 `read` registration；保留它的三个 FFF tool。旧的、仍注册 `read` 的 `pi-fff` release 与
`pi-ext-tools` 不兼容，必须在 release documentation 中明确并同 release 发布 split migration。

当 grep/find/FFF runtime 全部迁入后，`pi-fff` 才能被废弃。过渡期两个 package 不得互相 import。

## 验证与发布

- 每个 catalog tool：upstream schema/execute compatibility、managed registration singleton、abort、streaming（如适用）
  和 Loadout activation tests。
- `read`：logical line extraction、wide/combining glyph mapping、soft wrap、trailing whitespace copy、release auto-copy、
  clipboard failure warning deduplication、bridge absence 与 lifecycle cleanup。
- 真实 Pi/TUI replay：`read` 的已有和后续 tool surface、窄宽 viewport、scroll、selection highlight、copy 与
  bridge fail-closed fallback。
- split release：验证新 `pi-fff` 不再注册 `read`，新 `pi-ext-tools` 是唯一 `read` owner；旧 `pi-fff` 与
  `pi-ext-tools` 的不兼容性写入两个 package README 和 release notes。
