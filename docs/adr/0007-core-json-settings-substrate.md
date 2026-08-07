# core 提供无 policy JSON settings file transport

`@hheei/pi-ext-core` 提供 Pi global/project settings path、JSON object root/named section read，以及带
process queue、file lock 和 atomic rename 的 root update。默认 merged section entry 递归 merge plain object，
以 project 覆盖 scalar/array/null/type mismatch，并以 structured key path 查询 global/project/mixed 来源。
旧 aggregate consumer 与 `@hheei/pi-mctx` 是两个独立 consumers。

core 不解析 feature schema、不决定某个 project override 是否可信、不保存 feature state，也不提供 Settings
provider 或 UI。每个 extension 自己验证 raw section、定义可信 scope 和 application lifecycle。这个限制防止
common file transport 演变为跨 feature settings framework。
