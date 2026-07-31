# pi-mctx 在迁移期保留完整配置 schema

`@hheei/pi-mctx` 在迁移期保存完整 upstream-shaped MCTX configuration schema，但首个 context-pipeline
milestone 只读取已实现字段。其余字段是 reserved/inactive，不构成 active behavior 或 backward-compatibility
promise；每项 future feature 启用字段时，代码必须以 `ponytail:` 注释说明 inactive ceiling 与 activation trigger。
这允许逐步迁移时保留未来配置，同时避免把未实现功能误作当前行为。

reserved/inactive values 作为 opaque JSON 保存。首个 milestone 只 validation active pipeline fields；不能复制
Dreamer、embedding、experimental 等未实现 feature 的 runtime validator。future feature 激活其 section 时才增加
exact runtime validation。

schema baseline 固定为 `@hheei/pi-magic-context@0.33.1-hepi.0`。public CortexKit source 只能辅助研究，不能让
validation 跟随 upstream `master` 漂移。

global 与 project section 均可保存 raw schema，但 active behavior 不使用 blanket merge。当前 pipeline 必须由
user config 启用并选择 historian；project 只能 disable，不能选择 historian、改变 fail-closed/SQLite policy，且
只能提高 user 已设置的 trigger threshold。每个 reserved field 激活时必须单独定义其 scope policy。
