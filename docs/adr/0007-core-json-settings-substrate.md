# ext-core 提供无 policy extension settings transport

`@hheei/pi-ext-core` 将 extension 配置与 Pi host 原生配置分离。默认 global/project 路径分别为
`<agentDir>/ext_settings.json` 与 `<cwd>/.pi/ext_settings.json`；JSON root read、named key merge、process
queue、file lock、atomic rename 和 root update 由 ext-core 提供。plain object 递归 merge，project 覆盖
scalar、array、`null` 和 type mismatch，并可用 structured key path 查询 global/project/mixed 来源。

Settings provider 的 group ID 与 `SettingsRegistry.registerGroups()` 预留的非 UI key 共享同一 runtime collision
domain；该 ID 直接成为文件顶层 key，不使用 package section 包裹，重复 ID 显式失败。ext-core 不解析
feature schema、不决定 project override 是否可信，也不拥有业务状态或 Settings UI；每个 extension 自己
验证字段、定义可信 scope 和 application lifecycle。
