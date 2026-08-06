# Pi Ext Addon

`@hheei/pi-ext-addon` 提供 Pi host 的窄兼容性补丁和编辑器增强。功能包括 OpenAI
Responses replay 兼容，以及 `$skill-name` 引用。

## 边界

Pi host 在 `before_provider_request` 提供请求 payload；`pi-ext-addon` 仅在模型
API 为 `openai-responses` 时重写该 payload。它可移除 assistant 与 reasoning item
的 `status`，并将 assistant 的 `item_` ID 改为 `msg_pi_` ID。其他 provider、input
item 与 payload 保持不变。

扩展通过 ext-core 注册 settings provider。配置存于 `pi-ext-addon` 顶层 section：

```json
{
  "pi-ext-addon": {
    "openai-responses-compat": {
      "stripAssistantMessageStatus": true,
      "normalizeAssistantMessageId": true
    }
  }
}
```

不读取或迁移已冻结 `pi-basics.openai-responses-compat` 配置。未安装 addon 时，Pi host
不重写请求；配置默认关闭。每个 Pi session 缓存加载后的配置，并在 lifecycle cleanup
时删除；已注册的 provider hook 在 session 尚未启动时按需读取配置，支持 extension reload。

## Dollar Skill

Pi host 发现 skill 后，addon 在 TUI 编辑器补全 `$skill-name`，并在发送输入前将已知引用
替换为对应的 `SKILL.md` 路径。仅已加载的 skill 可引用；非 TUI 模式仍执行输入替换。编辑器
将已知 `$skill-name` 作为原子单元移动和删除。

配置存于 `pi-ext-addon` 顶层 section：

```json
{
  "pi-ext-addon": {
    "dollarSkillReferences": {
      "enabled": true,
      "maxSuggestions": 50
    }
  }
}
```

不读取或迁移已冻结 `pi-basics.dollarSkillReferences` 配置。默认启用；每个 session 的
编辑器、自动补全 provider 与配置在 lifecycle cleanup 时释放。

## 接口

包入口导出 extension default、OpenAI Responses compatibility 与 Dollar Skill 的 settings/
feature factory。没有跨扩展 capability。
