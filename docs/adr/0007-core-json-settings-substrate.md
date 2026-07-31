# core 提供无 policy JSON settings file transport

`@hheei/pi-ext-core` 提供 Pi global/project settings path、JSON object root/named section read，以及带
process queue、file lock 和 atomic rename 的 root update。`@hheei/hepi-basics` 与 `@hheei/pi-mctx` 是两个
独立 consumers。

core 不解析 feature schema、不决定 global/project field precedence、不保存 feature state，也不提供 Settings
provider 或 UI。每个 extension 自己验证 raw section、定义可信 scope 和 application lifecycle。这个限制防止
common file transport 演变为跨 feature settings framework。
