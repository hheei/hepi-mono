# 工具扩展拆包规格

状态：五包边界已在独立 worktree 实现；完整检查、构建、真实子进程集成与包产物验证通过，尚未合并或发布。

## Problem Statement

当前 pi-ext-tools 同时安装文件工具、Bash、补丁引擎、Python kernel 和 Todo。用户无法按需求选择这些能力，维护时不同进程、设置和持久化责任也汇集在同一入口。拆分应保留现有工具行为和历史会话，使 pi-dev 主工作目录不受开发过程影响。

## Solution

保留 pi-ext-tools 为基础文件工具与前台 Bash 扩展，新增 pi-bg-bash、pi-apply-patch、pi-python-eval 和 pi-todo。每包独立安装、恰有一个 extension 入口、拥有自身状态和生命周期。具体 extension 之间无直接依赖；可选 UI 仍通过 ext-core 接入。Pi host 负责工具执行，ext-core 提供共享写入锁和可选展示契约。

## User Stories

1. 作为用户，我希望只安装基础工具，以便获得 read、grep、find、edit、write 和前台 bash。
2. 作为用户，我希望独立安装后台 Bash，以便管理长任务而不依赖前台工具包。
3. 作为用户，我希望独立安装 apply_patch，以便选择补丁编辑能力。
4. 作为用户，我希望独立安装 Python eval，以便进行持久化会话内计算。
5. 作为用户，我希望独立安装 Todo，以便管理当前会话任务。
6. 作为用户，我希望组合安装后没有重复工具，以便确定每项能力的 owner。
7. 作为用户，我希望工具名称和参数保持一致，以便继续使用现有 loadout 与 subagent 配置。
8. 作为用户，我希望可选工具保持原默认启用策略，以便按需启用。
9. 作为用户，我希望旧设置仍能读取，以便无需重新配置。
10. 作为用户，我希望旧会话结果仍能折叠展示，以便阅读历史 diff 和 Python 输出。
11. 作为用户，我希望没有 UI 扩展时仍能看到结果，以便独立安装工具包。
12. 作为用户，我希望 Python 通过 Pi host 调用工具，以便验证、权限和 hooks 一致生效。
13. 作为用户，我希望 Python 无法调用未安装或未获准的工具，以便能力范围明确。
14. 作为用户，我希望取消 Python 时传播到嵌套工具，以便中止当前工作。
15. 作为用户，我希望三个文件写入工具仍共享互斥，以便避免协作写入冲突。
16. 作为用户，我希望后台 Bash 恢复原执行记录，以便检查历史结果而无需重跑。
17. 作为用户，我希望 Bash 无法确认结果时继续显示 unknown，以便自行判断副作用。
18. 作为用户，我希望 Bash 报告仍遵循当前分支收据，以便 tree 和 resume 后交付一致。
19. 作为用户，我希望 Todo 按当前分支恢复，以便 fork 和 tree 后任务正确。
20. 作为用户，我希望 Todo footer 保持显示，以便继续通过 pi-status 查看任务。
21. 作为用户，我希望发布产物携带 Python kernel 和补丁 Worker，以便安装后可运行。
22. 作为开发者，我希望新包接入本地开发和验证流程，以便开发安装和 npm 产物行为一致。
23. 作为开发者，我希望在独立 worktree 完成实现，以便主目录 pi-dev 持续运行。

## Implementation Decisions

- pi-ext-tools 拥有 read、grep、find、edit、write、bash；pi-bg-bash 拥有 bg_bash_spawn/get/stop；pi-apply-patch 拥有补丁解析、匹配、Worker、发布和工具结果；pi-python-eval 拥有 Python kernel、协议和嵌套调用转换；pi-todo 拥有任务、命令、提醒和状态展示。
- 每个包独立注册设置和 lifecycle。删除旧综合入口对已拆功能的注册，不保留自动安装或转发入口。旧安装需按迁移说明显式增加所需新包。
- Python bridge 仅依赖 Pi host 的 ExtensionToolContext.executeTool，保留当前七种允许嵌套的工具及 active 检查，删除直接调用 ToolDefinition 的 fallback 和重复参数验证；host 返回的执行结果决定错误状态。缺少工具或权限拒绝均传播为工具失败，保留 trace、structuredContent 和取消。
- 文件工具不再接受未使用的 Bash runtime state。Bash runtime 归 pi-bg-bash，不进入 ext-core。
- ext-core 提供 acquireMutationLock 和 withMutationLock，保留现有 key、哈希、socket/pipe 路径协议、等待者取消和 finally 释放。edit、write、apply_patch 使用同一实现；锁仅协调相同 key 的合作调用，不保证任意 shell 写入互斥。导入不创建锁或后台工作。
- 保留工具名、参数、defaultActive 和 exposure。保持 Python details format、edit/write view key、patch details、Todo 状态 key 与 customType、bg-bash-report。保留 Bash 账本、日志、ID、anchor 和分支收据。
- 设置仍使用 ext_settings.json 及原 bash、eval、applyPatch group；Todo 没有独立设置 provider；provider ID 和 origin 更新为新 owner，无需新增旧 ID alias。
- 前台 Bash 通过 Pi host 的本地执行能力管理当前调用，清理和取消由其进程树管理负责；后台 Bash 独立拥有 BashJobRegistry、账本与通知。前台不依赖后台包，不创建后台记录；输出边界、错误传播和超时保持。恢复不接管旧 PID、不发信号、不重跑；未知终态继续 unknown。
- Todo 的分支恢复和提醒仍归 Todo；Python kernel 在 session 结束时清理，变量不跨 session 恢复。
- 工具包拥有展示语义、参数摘要、结果解析、状态和内容行；ToolPresentation 描述内容、section、复制文本和状态，pi-ext-ui 仅拥有通用框架、折叠、布局和复制交互，不按具体工具名分派。每个工具 definition 在所属 package 通过 ext-core 的 createOptionalToolRenderers 注册可选 UI 与原生回退。pi-ext-ui 在 session 内提供 ToolRendererFactory，render 时懒读取，不依赖加载顺序；全局 resolver 跳过已经由 package 接线的 definition，避免双重框架。所有具体工具包括 subagents 与 memory 都采用同一契约，内置/外部工具继续由 UI 全局 resolver 接入。
- 每个新包携带所需许可证、声明和运行资产，更新 build、pi-dev、artifact 校验与受影响验证识别。具体 extension 不依赖 pi-ext-ui。

## Testing Decisions

- 主要 seam 为 Pi extension 注册与 Pi host 工具执行；检查独立安装、组合安装、默认启用和错误 hooks。
- Python 测试提供原生 executeTool 的 host fixture，验证参数与错误由 host 处理、active/允许列表、trace、structuredContent 和取消，不重新模拟生产工具 registry。
- 三个写入调用方共用锁的测试覆盖持锁等待和取消，保持已有补丁算法、路径、文件发布测试。
- 保留 Bash 账本/分支交付/进程清理和真实子进程集成测试，保留 Todo 分支恢复与 footer 测试。使用现有 fake timers 和事件协调。
- UI payload 历史兼容、窄宽布局已有测试继续生效；产物测试验证新入口、Python 资产和 Worker 启动。
- 因涉及共享导出、依赖与发布包边界，完成全仓 check、integration 和 package artifact 门禁，并更新 Graphify AST。禁止在主 worktree 安装、构建或启动 pi-dev。

## Out of Scope

不改变工具模型提示、匹配算法、Bash 恢复策略、Todo 语义或 Python 工具权限范围。不引入任务注册表、RPC、适配层、额外可配置 backend 或新的工具总包。不发布、push、合并回 main。

## Further Notes

没有配置 issue tracker；本次使用 to-tickets 支持的本地单文件 tickets。用户已批准拆分方案，测试 seam 和任务顺序沿用该方案。基线快照包含开始时已有的未提交工作，用于保留现状；本次拆包 diff 以该快照为比较起点。
