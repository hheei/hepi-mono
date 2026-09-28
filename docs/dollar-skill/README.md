# Pi Dollar Skill

`@hheei/pi-ext-addon` 内置的 Dollar Skill 能力为 Pi 提供 `$skill-name` 自动补全和输入替换。Pi
发现 skill 后，TUI 编辑器可补全 `$skill-name`；发送输入时，已知引用替换为对应的
`SKILL.md` 路径。仅已加载的 skill 可引用；非 TUI 模式仍执行输入替换。编辑器将已知
引用作为原子单元移动和删除。此功能为 opt-in，預設關閉。

配置存于 `dollar-skill` 顶层 section（亦兼容旧 `pi-dollar-skill`）：

```json
{
  "dollar-skill": {
    "enabled": false,
    "maxSuggestions": 50
  }
}
```

默认关闭（opt-in）。`pi-dollar-skill` section 只做读取兼容，写回始终落在 `dollar-skill`；更早版本写入的 `dollarSkillReferences` 引用不再读取或迁移。
