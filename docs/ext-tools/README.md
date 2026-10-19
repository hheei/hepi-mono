# 文件工具与独立工具包

`@hheei/pi-ext-tools` 仅注册 `read`、`grep`、`find`、`edit`、`write`、`bash`。每个名称恰有一份 definition；调用时使用 tool context 的 cwd，不使用 extension 构造时的 cwd。工具执行、参数校验和 hooks 由 Pi host 协调。

## 工具包

每个工具包独立安装，只有一个 extension 入口。

| 包 | 职责 |
| --- | --- |
| `@hheei/pi-ext-tools` | 文件读取、搜索、edit/write 与前台 Bash |
| `@hheei/pi-bg-bash` | 后台执行、日志、账本和通知 |
| `@hheei/pi-apply-patch` | V4A 补丁、匹配 Worker、逐 path 发布 |
| `@hheei/pi-python-eval` | Python kernel、嵌套调用协议、状态清理 |
| `@hheei/pi-todo` | Todo tool、命令、分支状态、提醒与 footer |

```bash
pi install npm:@hheei/pi-ext-tools
pi install npm:@hheei/pi-bg-bash
pi install npm:@hheei/pi-apply-patch
pi install npm:@hheei/pi-python-eval
pi install npm:@hheei/pi-todo
```

各包只依赖共享基础库和自身运行依赖，具体 extension 之间无直接依赖。工具名、参数、defaultActive 和 exposure 保持原样；Loadout 按工具名工作。`apply_patch`、`python_eval`、后台 Bash 与 Todo 仍按原策略 opt-in。`codemode` 属于 Pi host。

设置位于 `ext_settings.json` 的 `bash`、`applyPatch`、`eval` 分组；Todo 没有独立设置 provider。provider ID 与 origin 归各自工具包所有。

## 文件写入与取消

`edit`、`write` 和 `apply_patch` 使用 ext-core 的 `withMutationLock` / `acquireMutationLock`，相同 cwd key 共用原 socket/pipe 协议。等待者可取消，运行结束在 finally 中释放。锁只协调合作调用，不能阻止任意 shell 或外部编辑器写入。文件工具不拥有 Bash runtime 或会话级进程状态。

`read` 复用 Pi host 原生读取和图像结果；`grep`、`find` 保持搜索 schema、只读提示、超时与分页行为。`edit`、`write` 保存执行时 diff view，恢复历史结果时不从当前 workspace 反推旧内容。

## 展示与扩展边界

具体工具提供结果事实与必要的 ToolPresentation，ext-core 提供展示契约，`pi-ext-ui` 负责可选的折叠框架。未安装 UI 时仍有原生文本结果，不存在对 UI 包的硬依赖。折叠不改变模型可见 content 或持久化 details；宽度和交互约束见 [DESIGN.md](../../DESIGN.md)。

Python 只通过 Pi host `executeTool` 调用允许且 active 的七种嵌套工具；不持有其他包的 definition 或 fallback registry。缺少工具、权限拒绝和取消由 host 路径返回。完整边界见[拆包规格](../architecture/tool-packages.md)。

补丁匹配、部分成功与取消见 [apply_patch 合约](../architecture/apply-patch.md)。Bash 的 unknown、分支收据与进程清理见[后台任务合约](../architecture/background-tasks.md)和[执行恢复](../architecture/bash-execution-recovery.md)。Todo 的分支恢复见 [Todo 文档](../todo/README.md)。
