# Hindsight 原生 MCP 集成

## 已确认方向

将 pi-ext-memory 的手写 Hindsight 工具注册迁移到 Pi host 原生 MCP。删除旧工具名、schema、managed-tool 重新声明和业务 execute 包装；不增加本地 MCP proxy 或旧名兼容层。

当前服务未开放的 initiative/page authoring 不再由 extension 经 REST 绕过；未来开放相应 MCP 工具时，由 MCP 发现和执行。

## Ownership

- Pi host：连接、发现、工具注册、exposure、调用、取消、重连、完整输出保存与 /mcp 状态。
- pi-ext-memory：显式启用、bank 解析、session 生命周期、自动 recall、transcript 写回、cache 失效与 /om 本地诊断。SDK 仅用于自动策略，不再用于模型工具包装。
- ext-core：共享 ToolTui 展示。拆开 execute 包装与 renderer，保留本地工具路径，经 registerToolRenderer 接入 MCP 与历史调用。

数据流：memory 解析 bank → 注册单 bank endpoint → Pi host 发现与执行 → ext-core 展示。

ext-core 的公共展示契约为 `ToolTui.renderers({ name, label?, renderCall?, renderResult? }, presentation?)`，返回 Pi 的 `ToolRenderers`。不要求 schema、execute 或字符串 overload。既有 `frame()` 使用相同渲染实现，但保留原来的 execute ownership；仅 renderer-only 登记的工具名称由 host 工具事件驱动 trace 与时长持久化，不改变无关工具结果。展示层可识别业务错误，但模型与 codemode 的错误状态由 memory 的 tool_result 归一化。

## 边界与不变量

- 使用 /mcp/{bank_id}/，不使用允许模型指定 bank 的 multi-bank endpoint。连接范围不等于服务器的访问授权。
- 推荐每仓库专用 bank；不自动迁移或删除现有共享 bank 数据。知识页面没有 repo tag 过滤，不能将共享 bank 宣称为完整仓库隔离。
- session 切换撤销旧注册；disabled 和子 agent 不建立连接。写回队列与 MCP 连接各自清理，清理幂等。
- 子 agent 不自动注册 Hindsight；child bridge 在 tool_call 边界阻止保留名称 mcp__hindsight__ 下所有调用，包括文件配置、嵌套调用与未来新增工具。其他 server 名称不属于此边界。
- 同名文件配置优先于 extension 注册，必须检查覆盖风险，不能静默声称 bank 边界仍然成立。
- 远端写工具成功后失效 recall cache；异步 retain 和页面刷新不承诺即时可见。
- 诊断不输出凭据。
- 每轮提供完整的期望 prompt sections；省略 section 表示删除，不表示保留。memory preamble 在实例内缓存并每轮提供相同文本，由 Pi host diff 避免重复更新；首次显示 guide 的 UI 摘要与模型 section 的生命周期分开。
- resume 从当前分支的 system sections 重放恢复 preamble；仓库、bank、scope 和静态指导相同时复用原页面目录快照，不因远端目录变化重写请求前缀。无可复用 section 时重新构建，不新增持久化条目；配置或指导变化仍产生必要更新。

## 工具与 UI

- 使用原生 mcp__hindsight__* 名称，更新提示、测试和子 agent 边界，不保留旧名 alias。
- 页面发现为目录树，搜索采用原生 limit 语义。
- 本地配置和写回队列诊断进入 /om；连接诊断使用 /mcp。
- renderer 保留完整输出路径、错误展示、历史渲染和窄/宽布局。业务错误可能是结构化 error 或 status: error，不能只看 MCP isError。
- 时长、完成状态和折叠不能因移除 execute wrapper 而失效；共享 API 在检查 host 生命周期后确定。
- pi-dev 显式启用 builtin:mcp，不另建 MCP 消费者。

## 已确认的开放策略

服务端决定工具集合，不维护客户端 allowlist。常用记忆工具使用 direct：知识树、知识搜索、页面读取、recall、reflect、retain；其他工具默认 deferred，包含运维、同步写入、记忆修正及未来新增 authoring 工具。exposure 不代表授权，所有调用仍走 Pi 权限管线。

保留显式 bank 配置，在文档和 /om status 中说明共享 bank 只有 bank 级共享语义，不保证仓库隔离；显式选择共享 bank 不触发启动 warning。没有显式 bank 时保持每仓库派生规则。不自动改 bank 或搬迁数据。

## 验证

覆盖注册与撤销、session 切换、disabled/子 agent、配置覆盖、cache 失效、业务错误、resume 渲染、完整输出路径与窄/宽布局。涉及 ext-core 公共 API 和跨 package 调用，执行全仓 typecheck 与受影响测试；行为传播到全仓时再升级完整 test。
