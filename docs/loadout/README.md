# Loadout

`@hheei/pi-loadout` 是无界面的 Pi 工具与技能激活策略扩展。它读取 JSON 覆盖值，在每个
session 开始时解析可用资源并应用给 Pi；它不注册 `/loadout` 命令，也不渲染设置页面。

## 用户意图

Loadout 让用户在不改变扩展安装集合的前提下控制工具和技能是否可用。未来
`pi-settings` 提供写入界面；本阶段只支持直接编辑配置文件。

## 配置与作用域

配置段为 `pi-loadout`。全局 `<agentDir>/settings.json` 与项目
`<cwd>/.pi/settings.json` 使用同一段，项目同名字段覆盖全局字段：

```json
{
  "pi-loadout": {
    "tools": { "tool:grep": false },
    "skills": { "skill:review": false }
  }
}
```

键为 canonical `tool:<name>` 或 `skill:<bare-name>`。本包不读取或迁移旧
`pi-basics-loadout` 数据。

## 边界

- `pi-ext-core` 提供 runtime-scoped tool inventory、已解析 activation snapshot 与
  disabled-skill capability；它不持有策略、存储或 UI。
- `pi-loadout` 发现 Pi 中的 native、HEPI 与第三方工具。同名工具合并为一个 name-level
  项，因为 Pi 的 active set 和 handler 选择同样按 name 工作。
- 未配置的已发现工具保留 session-start Pi active set；HEPI managed tool 可声明自身默认值。
- skill disable 只过滤 HEPI prompt 与 dollar-skill autocomplete/input expansion，不卸载 Pi
  skill。
- 不迁移无运行时效果的旧 MCP placeholder。
- 被 policy 关闭的工具 UI 由该工具扩展订阅 core activation snapshot 自行清理；Loadout
  不直接调用具体扩展。

## 后续

`pi-settings` 成为唯一的 `/ext-settings` host 后，Loadout 页面可写入相同 JSON schema。
`pi-fff` 通过 core managed registration 接入该策略，不依赖已删除的 aggregate Loadout。
