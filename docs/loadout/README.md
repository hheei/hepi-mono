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

Agent resource 可选贡献一个 nested settings detail。选中有 detail 的行后，`Enter` 把右侧
Description lane 切换为该 detail；窄终端把同一 detail 堆叠在列表下方。Loadout 只拥有焦点、布局与
导航；contributor 复用自己 settings provider 的 schema、storage、validation 与 live-policy callback，
不复制 JSON 格式或把 feature state 下沉到 Loadout。`pi-auto-title` 不注册 `agent` resource，始终经
`/ext-settings` 显示自己的 settings；`Agents` group 的行只来自 `pi-subagents` 的 subagent profiles。
`pi-subagents` 的所有 agent（含内置默认）都提供 detail：内置 agent 没有 backing 文件，首次保存时
自动 clone 到 `<cwd>/.pi/agents/`，body 保留内置 system prompt。

编辑入口只对显式 enabled 的行开放：选中一个贡献 detail 且处于 enabled 状态的 agent 时，右侧
Description lane 底部显示 `↵ Edit config` 提示，`Enter` 打开可编辑 detail；inherit（project scope
未显式选择、跟随 global effective state）与 disabled 的行是只读的——不显示提示，`Enter` 不打开
detail。agent 的激活状态完全由 Loadout policy 在 `agent:<name>` key 下决定（`Space` 切换三态并
persist 到 settings JSON），agent Markdown 不参与启停。

`pi-subagents` 的 agent detail 对 `model` 与 `thinking` 两个字段复用 Settings 的 cycler 交互
（与 `HepiSettingTabCycle` 语义一致）：在 `model` 或 `thinking` 行按 `Enter` 打开单一选择器，
`↑`/`↓` 在 model 选项间循环移动（到头回绕，与 Settings enum 编辑器一致），`Tab`/`Shift+Tab`
就地正向/反向循环 thinking 值（不产生第二个焦点），`Enter` 同时应用两者并立即保存，`Esc`
取消并保留原值。两者都提供 `inherit` 选项：选择 `inherit` 等价于未设置（省略 frontmatter
key），spawn 时回退到父会话或 profile 默认。

`model` 选择器选项顺序：`inherit`、当前已配置值（若不在下列列表中）、已认证可用模型
（`provider/model`，按字母序）。当前值可以是任意 fuzzy 模型名（如 `haiku`），选择器把它作为
独立选项保留，格式校验与宽容解析仍只在 spawn 时由 `resolveModel()` 负责。`thinking` 的
`Tab` 循环顺序：`inherit`、`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。

选择器打开时行数保持不变（固定 7 行）：`Model` 行就地显示当前选中的选项，`Thinking` 行值随
`Tab` 即时更新，hint 行切换为选择器说明。`Esc` 的消费顺序：detail 激活时先交给 detail
（选择器打开时取消选择器），detail 未消费才退回列表。

`𖠌 Agents` 的每一行显示 effective activation、profile 名和 profile 的 effective model：

```text
● Explore        ◔ cx/gpt-5.6-luna
○ Plan           ○ anthropic/claude-haiku-4-5
```

第一 glyph 是 raw activation selection（`●` enabled / `○` disabled / `◌` inherit，由 Loadout policy
在 `agent:<name>` key 下决定，与 agent Markdown 无关；inherit 表示 project scope 未做本地决策，
effective 状态跟随 global/default)；第二 glyph 是 thinking level，只在 profile 配置了
thinking（frontmatter 含 `thinking`）时显示——未配置（继承）时不显示 glyph。缺少 model
configuration 时显示 `inherit`，不猜测 provider。

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
  Loadout surface 打开 contributor 提供的 profile detail；没有 contributor detail 时保持当前 list
  focus，不能把 profile metadata 假装成可编辑 configuration。
- 不迁移无运行时效果的旧 MCP placeholder。
- 被 policy 关闭的工具 UI 由该工具扩展订阅 core activation snapshot 自行清理；Loadout
  不直接调用具体扩展。

## 后续

`pi-settings` 独占 `/ext-settings` host，`pi-loadout` 独占 `/loadout` direct entry；二者打开同一 router。
Loadout 页面把 Tools、Skills 与按需出现的 resource groups 放在一个列表，通过 Global/Project scope draft 修改这些 delta；它不 hot-apply，
关闭 Settings router 后提示用户 `/reload`。`pi-ext-tools` 的 integrated FFF tools 通过 core managed registration 接入该策略，不依赖已删除的
aggregate Loadout。
