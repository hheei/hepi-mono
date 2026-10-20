# Tool Search Ownership

## 目标

由 @hheei/pi-ext-tools 接管 Pi 内建的 tool_search。结果区分本次新加载的工具与模型已经可用的工具。tool_search 不返回参数 schema；新工具完整声明由 Pi 在下一次模型请求中提供。

## Ownership 与数据流

pi-ext-tools 使用 Pi 可替换内建工具的契约注册同名 tool_search。它通过 getAllTools() 读取当前工具目录，通过 getActiveTools() 读取可见状态，只对 codemode 与 deferred 工具排序，并用 setActiveTools() 激活新匹配项。工具声明投递、transcript 记录、分支恢复和模型执行仍由 Pi host 负责。

    query -> 工具元数据 -> 排序结果
                         -> 已激活：报告 already available
                         -> 未激活：setActiveTools -> 报告 loaded for next call

host active set 是唯一状态来源。extension 不维护平行的已加载状态，因此重复搜索幂等。tool_search 使用 sequential execution，避免并行调用基于旧 active set 更新时互相覆盖。

## 搜索与结果契约

- 搜索内容只包含工具名称、描述和 namespace 元数据，不索引参数 schema。
- 仅搜索 exposure 为 codemode 或 deferred 的工具，其他 exposure 不参与搜索。
- 匹配项若已在 active set 中，结果用 `loaded: name, name` 汇总且不带描述；否则加入 active set，标为 loaded for next call 并附简短描述。
- 无匹配表示元数据未命中；已激活的工具仍会作为匹配项正常返回。
- tool_search 不返回或概述参数定义。模型需要为具体任务选择工具；激活后由 Pi 在下一次请求中提供完整 schema。
- 对明确要求查找工具 definition、schema、parameters、arguments 或 signature 的请求，拒绝执行搜索和激活，并提示改用任务描述。
- 空 query 或非法 limit 在修改 active set 前报错。

## 生命周期与回退

没有持久化状态、后台工作或新增取消路径。Pi 的 active set 和 transcript 负责跨 turn、分支和 resume 的工具可见性。未加载 Pi 内建 tool-search 时，package-owned 工具仍可查询当前工具目录；未安装 pi-ext-tools 时，Pi 内建行为保持不变。

## 验证

聚焦测试覆盖排序、exposure 过滤、排除参数 schema、首次加载、重复搜索、保留无关 active 工具、definition lookup 拒绝及非法输入。
