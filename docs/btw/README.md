# Pi BTW

## 目的

`@hheei/pi-btw` 提供 TUI 专用的 `/btw <question>` 侧问。它读取当前主会话作为只读背景，使用当前模型回答问题，并在临时 overlay 中显示结果。回答可加入同一 session 的 side-thread history，但不写入主 transcript、主 agent context 或磁盘。

## 边界

- 包拥有命令、overlay、side-thread history、问题与上下文裁剪、成功结果提交和 stale UI guard。
- 包通过 `@hheei/pi-ext-core` 的 `completion` 启动无工具模型调用；core 拥有 execution admission、取消与 terminal result。
- `/btw` 不创建 child `AgentSession`，不注册 model-facing tool，不使用 task delivery，也不把结果 follow-up 给主 agent。
- 每个 session 最多一个 active `/btw` request；tree、compact、switch、reload 或 shutdown 会取消该 request。

## 安装与接口

包只声明一个 Pi extension entry。用户接口为：

```text
/btw <question>
```

调用需要 TUI 和 active model。空问题、无模型、认证失败、空响应、provider failure 和取消均只在 BTW overlay 或通知中呈现，不改变主会话。

## 已确认决策

- `/btw` 是 `completion` consumer；其模型调用不再自行管理 credential、AbortController 或 completion lifecycle。
- context 仍在 invocation 时从当前 session branch 构建；成功的 BTW turn 才进入 side-thread history。
- core shared active-turn cap 由本 package session start 时显式声明；若已有 direct consumer，必须声明同一值。
