# Pi Debug

`@hheei/pi-debug` 提供 Pi 扩展开发诊断。首个功能是 prompt cache 探针：它只记录 provider payload 的哈希和缓存用量，不保存 prompt 或响应正文。

## 边界

- Pi host 发送 provider 请求，并调用 `before_provider_request`、`after_provider_response`、`message_end` hook。
- `@hheei/pi-debug` 拥有诊断开关、请求摘要、JSONL 日志、`/cache-debug` 命令。
- ext-core 提供 settings registry、全局 JSON 设置存储、session 生命周期和清理。
- 关闭诊断时，包不注册 provider hook，不创建日志文件；`/cache-debug` 显示如何启用。

## 设置

全局 `~/.pi/agent/settings.json` 使用：

```json
{
  "pi-debug": {
    "cache": {
      "enabled": true
    }
  }
}
```

默认 `false`。可通过 ext-settings 切换；变更在当前 session 生效。日志默认写入系统临时目录的 `pi/cache-debug/<sessionId>.jsonl`，`PI_CACHE_DEBUG_LOG` 仍可覆盖路径。

## 流程

```text
ext-settings -> pi-debug settings -> enabled
Pi host provider hook -> pi-debug hash-only record -> JSONL
/cache-debug -> 当前日志路径或未启用提示
```

公开入口保持两个：`@hheei/pi-debug` 和 `@hheei/pi-debug/tui-replay`。旧 `@hheei/hepi-debug` 不保留兼容入口。
