# Pi Dollar Skill

`@hheei/pi-dollar-skill` 为 Pi 提供 `$skill-name` 自动补全和输入替换。Pi
发现 skill 后，TUI 编辑器可补全 `$skill-name`；发送输入时，已知引用替换为对应的
`SKILL.md` 路径。仅已加载的 skill 可引用；非 TUI 模式仍执行输入替换。编辑器将已知
引用作为原子单元移动和删除。

配置存于 `pi-dollar-skill` 顶层 section：

```json
{
  "pi-dollar-skill": {
    "dollarSkillReferences": {
      "enabled": true,
      "maxSuggestions": 50
    }
  }
}
```

默认启用。不读取或迁移已冻结的 `pi-basics.dollarSkillReferences` 配置。
