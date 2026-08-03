# Loadout

`@hheei/pi-loadout` 是 Pi 工具、技能与 extension resource 激活策略扩展。它读取 global 和 project JSON delta，在每个
session 开始时解析可用资源并应用给 Pi；它注册 `/loadout`，以 Loadout 为 initial page 打开 shared
Settings router，而不维护另一份 renderer。

## 用户意图

Loadout 让用户在不改变扩展安装集合的前提下控制工具、技能和已登记 resource 是否可用。`/loadout` 与
`/ext-settings loadout` 都提供同一个 scoped-delta 写入界面；也可以直接编辑配置文件。

资源按固定语义分组显示：

```text
⚒ Tools
✦ Skills
𖠌 Agents
```

`Agents` 只有安装的 extension 登记至少一个 agent resource 时才出现。图标只标识分组；每行仍以文字及
`✓` / `○` 表达启用状态。

`𖠌 Agents` 的每一行显示 effective activation、profile 名和 profile 的 effective model：

```text
● Explore        ◔ cx/gpt-5.6-luna
○ Plan           ○ anthropic/claude-haiku-4-5
```

第一 glyph 是 enabled (`●`) 或 disabled (`○`)；第二 glyph 是 thinking level。缺少 model configuration
时显示 `inherit`，不猜测 provider。

## 配置与作用域

配置段为 `pi-loadout`。全局 `<agentDir>/settings.json` 与项目
`<cwd>/.pi/settings.json` 各自使用同一段：

```json
{
  "pi-loadout": {
    "disabled": ["tool:grep", "skill:review", "agent:Plan"],
    "enabled": ["tool:find", "agent:Explore"]
  }
}
```

数组成员为 canonical `tool:<name>`、`skill:<bare-name>` 或 contributor 登记的 resource ID，例如
`agent:<name>`。它们记录显式 delta，不是完整
inventory。配置解析顺序固定为：

`project disabled > project enabled > global disabled > global enabled > discovered default`。

同一 scope 中意外同时出现在两个数组的 key 按 `disabled` 处理。写入 API 会归一化被修改的
key，移除另一数组的同名项。合法但尚未发现的 key 保留在 JSON 中，在资源被发现前没有运行时
效果；Settings UI 静默隐藏它们。格式错误、旧 `tools` / `skills` boolean map 或其它未知字段是
schema error，不读取也不迁移。为限制 project JSON 的 startup 资源消耗，每层数组最多 4096 个
key，每个 key 最多 256 个字符。

global-visible resource 的 global 选择只有 `enabled` / `disabled`：选择等于 discovered default
时不会写入 delta。它在 project 有 `enabled` / `disabled` / `inherit` 三态；`inherit` 同时移除
project 的两侧 delta 并露出 global effective state。仅当前 project 发现的 private resource 不显示
global 设置，也没有 project `inherit`；它在 project 是二态，选择等于 discovered default 时不写。

conflict set 不会改写原始 JSON。多个 enabled member 同时存在时，engine 先按上述 delta source
rank、再按 metadata priority 和 name 保留 winner；其它 member 是 locked/inactive。用户必须先让
winner inherit 或回到其 default，才可操作被锁定 member。

## 边界

- `pi-ext-core` 提供 runtime-scoped resource inventory、已解析 activation snapshot 与
  disabled-skill capability；它不持有策略、存储或 UI。
- `pi-loadout` 发现 Pi 中的 native、HEPI 与第三方工具。同名工具合并为一个 name-level
  项，因为 Pi 的 active set 和 handler 选择同样按 name 工作。
- 未配置的已发现工具保留 session-start Pi active set；HEPI managed tool 可声明自身默认值。
- skill disable 只过滤 HEPI prompt 与 dollar-skill autocomplete/input expansion，不卸载 Pi
  skill。
- 安装 `pi-subagents` 后，Loadout 才显示 `Agents` group。`agent:<name>` 不传给
  Pi host `setActiveTools()`；core 将 effective activation 发布给 profile owner。`Enter` 在同一
  Loadout surface 打开 contributor 提供的 profile detail。
- 不迁移无运行时效果的旧 MCP placeholder。
- 被 policy 关闭的工具 UI 由该工具扩展订阅 core activation snapshot 自行清理；Loadout
  不直接调用具体扩展。

## 后续

`pi-settings` 独占 `/ext-settings` host，`pi-loadout` 独占 `/loadout` direct entry；二者打开同一 router。
Loadout 页面把 Tools、Skills 与按需出现的 resource groups 放在一个列表，通过 Global/Project scope draft 修改这些 delta；它不 hot-apply，
关闭 Settings router 后提示用户 `/reload`。`pi-fff` 通过 core managed registration 接入该策略，不依赖已删除的
aggregate Loadout。
