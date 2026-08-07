# pi-t2s

## 用户意图

`@hheei/pi-t2s` 把交互式繁体中文输入转换为简体中文，同时保留 inline code 与 fenced code 原文。它只处理用户提交给 Pi host 的文本，不改写模型输出、历史记录或文件内容。

这里的 T2S 表示 Traditional Chinese to Simplified Chinese，不表示 text-to-speech。

## 包与运行时边界

- Pi host 派发 `input` event，并按 extension/handler 注册顺序串联 `transform` 结果；
- `pi-t2s` 是 concrete extension，拥有 OpenCC、转换规则、Settings schema、输入 handler 与 session 状态；
- ext-core 只提供 session lifecycle、Settings provider registry 与原子 JSON settings transport；
- `pi-settings` 可选地渲染 provider；未安装时转换仍按已保存配置运行；
- 本功能没有 command、tool、surface、widget、timer 或后台任务。

```text
interactive input
  -> Pi host input chain
  -> pi-t2s prose conversion
  -> next input handler
  -> agent
```

`transform` 不短路后续 handler。Pi host 没有 input handler unregister API，因此 extension 保留单次注册标记与 active session identity；shutdown/reload 时先使旧 handler inert，再由下一 session 接管。cleanup 幂等。

## 转换契约

- OpenCC 使用 `tw -> cn` 转换；
- 普通 prose 转为简体；
- inline backtick code 与 backtick/tilde fenced code 保持原样；
- 输入无需改变时返回 `continue`，不制造等价 transform；
- `mode: "off"` 时保持 Pi native input；
- 未配置时默认 `mode: "t2s"`；
- 无效配置时当前 session 禁用转换并通知错误，Settings provider 仍可发现并修复。

首版保持现有转换范围，不增加 Markdown parser、文件转换、输出后处理或更多语言方向。

## Settings 与持久化

provider ID 为 `pi-t2s`。Settings 继续暴露一个 `mode` enum：`t2s | off`。保存不热切换当前 session；`/reload` 或新 session 后生效。

独立包拥有新 JSON contract：

```json
{
  "pi-t2s": {
    "traditional-to-simplified": {
      "mode": "t2s"
    }
  }
}
```

首次读取时，若新 section 不存在而旧 `pi-basics.traditional-to-simplified.mode` 存在，则在同一次原子更新中迁移该值、删除旧 group，并保留 `pi-basics` 与 JSON root 的所有 sibling。新 section 已存在时绝不读取或覆盖它。配置边界使用 TypeBox 严格验证；未知字段或非法 mode 不会被静默过滤。

## Clean cutover

`pi-t2s` 由独立 package 所有。代码、测试、OpenCC runtime dependency 与 Settings provider 均属于该 package；ext-core 不增加 T2S API。

## 公开接口与验证

package 的公开 TypeScript entry 仅导出 extension default；转换器与 storage 是 package 内部实现，不形成跨 extension API。

Focused verification 覆盖 prose/code 转换、input chain、session replacement、严格配置校验、旧 key 原子迁移、sibling preservation，以及 Settings provider 的 session 注册与注销。最终在 Pi host 中同时加载 `pi-settings,pi-t2s`，验证输入转换与 reload-only 设置行为。
