# Pi Ext Addon

`@hheei/pi-ext-addon` 提供 Pi host 的窄兼容性补丁，处理部分 OpenAI Responses
gateway 不接受 replayed input item 的 `status` 字段的问题。

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

## 接口

包入口导出 extension default、`applyOpenAIResponsesCompat()`、
`normalizeAssistantMessageId()`、`stripAssistantMessageStatus()` 与 settings/feature
factory。没有跨扩展 capability。
