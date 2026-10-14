# 后台任务契约

## 用户可见目标

后台 Bash 与子代理使用独立工具族，共享 session 内的活动登记与交付协调。模型保留启动返回的 ID，完成结果自动返回；没有 list 或等待工具，也没有旧名称兼容入口。PTY 留给后续独立设计。

| 工具族 | 工具 | ownership |
| --- | --- | --- |
| 后台 Bash | `bg_bash_spawn`、`bg_bash_get`、`bg_bash_stop` | pi-ext-tools |
| 子代理 | `agent_spawn`、`agent_send`、`agent_get`、`agent_stop` | pi-subagents |

`bash` 只执行前台命令；后台命令通过 `bg_bash_spawn` 启动，不绑定已返回的 tool call 的取消信号。两个 spawn 工具均由系统分配 ID，不接受调用方指定 ID。`agent_send` 显式使用已有 ID，保留 child session 上下文；idle、blocked、done、error 或 stopped child 的恢复仍须确认旧 runtime 状态，不能启动重复进程。

## 查询契约

操作工具使用最小返回：两个 spawn 成功时返回 JSON `{ id, path }`，失败时只返回原因；send、stop 成功时只返回一句确认，失败时只返回原因。`path` 为绝对路径：Bash 是完整日志文件，agent 是子进程中 Pi 分配的 session 文件。变量与返回字段统一使用 `id`、`path`，get 的 progress 也使用 `path`。工具返回不附带 session ID、presentation、生命周期快照或重复的执行参数，内部管理器仍保留运行与恢复所需数据。

agent 的首次输入确认携带实际 session 路径，父进程不猜测文件名，也不等待首次写盘。展示路径在 manager 生命周期内缓存，重启 runtime 后按新的输入确认更新；它不表示 session 已持久化，不写入用于恢复的已验证 sessionPath。恢复时仍按原有磁盘验证区分 never_flushed 与 flushed。

两个 get 工具接受 `id` 和可选的逗号分隔 `keys`。省略时返回 `status,progress`；支持的 key 只有 `status`、`progress`、`diagnostic`，未知 key 直接报错。查询不会等待或消费结果。

- `status`：当前生命周期状态，保留各 producer 的真实状态语义。
- `progress`：有上限的运行信息。Bash 提供执行上下文与当前输出尾部，agent 提供当前可观察进展，不复述初始任务参数或历史最终回答。
- `diagnostic`：失败、阻塞、超时或 runtime 状态不确定的原因；没有诊断时省略。

不提供 `maxOutputChars`。ID 是查询输入，command、cwd、exitCode、timedOut 和 elapsed 不成为独立查询 key；必要上下文并入 progress 或 diagnostic。终态仍可查询生命周期信息，终态结果通过自动交付返回，不由 get 重复返回。完整 Bash 输出使用 spawn 的 path、get 的 progress.path 或自动通知提供的日志绝对路径，通过 read/grep 检查。

## 工具展示

两个工具族各自在所属 extension 定义 header summary、可检查的输入、结果行与 copy 内容。ext-core 提供 `ToolPresentation` 数据契约和生成 Pi 原生 renderers 的工厂；不认识 Bash 或 agent 字段、不导入具体 extension。工厂将 presentation provider 与原生 renderCall 函数用 WeakMap 关联，并为嵌套调用建立 Pi runtime 内按工具名索引的 WeakRef；索引不强持有 renderer 或 provider，跟随 renderer 的可达性回收，没有 session 状态、订阅、持久化或加载顺序要求。

pi-ext-ui 从 Pi resolver 的 `next()` 查询这一关联，只有存在工具自己的 provider 时才将相同 presentation 装入 ToolView。UI 负责折叠、状态、时长、上下两段 rail 与 copy 交互；工具负责内容语义。未加载 pi-ext-ui 时，工具定义自带的 renderCall/renderResult 使用 Pi 的 Text 和主题，保留参数与结果。错误保留原始文本，成功 spawn 的 `{ id, path }` 同时放入 typed details 供展示使用，不解析模型输出、不改模型返回 JSON。跨 extension 不增加直接依赖；pi-ext-ui 仅依赖 ext-core 的纯契约。

spawn 展示命令或 agent 名及任务，结果展示分配的 ID 和可检查路径；send 展示 ID、mode 和输入消息；get 展示 ID、keys，并按 status/progress/diagnostic 展示实际查询字段；stop 展示 ID 与操作确认。折叠结果仍保留关键 ID/path 或状态；展开保留完整输入与结果，copy 使用工具提供的原始文本。嵌套调用使用同一 renderer。

## Ownership 与生命周期

- ext-core `TaskRegistry` 负责 session 内身份、活动状态、容量、终态保留与纯通知；不注册 Pi 工具、不启动进程、不投递消息。内部 list/wait/stop 能力不等于模型工具目录。
- pi-ext-tools 创建并通过 `TASK_REGISTRY_SERVICE_KEY` 提供 session 的 registry，拥有 Bash 工具、日志和 task delivery。
- pi-subagents 拥有 child 定义、持久化 session、bridge、启动/恢复/停止与报告；可独立使用自身工具，通过可选 registry 集成参与后台活动计数。
- `BashJobRegistry` 拥有进程、输出、timeout 与 reminder timer。
- ext-core `BackgroundDelivery` 协调后台活动源和交付通道，通道拥有待交付内容；不新增持久化调度器或 outbox。

取消是请求，执行退出确认后才记录终态；自然完成与取消竞态保留真实结果。迟到的 binding、旧 session 事件或已结束执行不能复活任务。停止 Bash 清理整棵进程树。session 替换/reload/shutdown 清理 timer、订阅、队列与进程，清理必须幂等。

## Bash 提醒

只对后台 Bash 开启提醒，不对 agent 或前台 bash 开启。

1. 启动后连续 180 秒没有 stdout/stderr 时发送一次 idle notice。输出通过 onData 更新，不轮询；输出到来重置尚未发出的 idle timer。
2. 本次执行的 idle notice 发出后不再重复；每 1800 秒发送 heartbeat。
3. stop、退出、terminalize 或 dispose 取消所有 reminder timer，旧执行不能继续投递。

reminder 携带 task ID、kind（idle/heartbeat）、状态、elapsed、必要进展与 logPath。它与 terminal event 使用同一 task delivery channel；不改变 terminal delivery state、不消费结果、不要求模型查询 get。父会话空闲时 reminder 可绕过普通完成门控唤醒，普通终态结果仍按原门控保留。

## 自动交付与分支

普通终态结果和 child 报告共享完成门控：父 agent 工作时通过 steer 进入下一模型步骤；空闲时等待全部后台活动结束，再统一唤醒一次。blocked/error 紧急报告与 Bash reminder 可提前唤醒。单轮协调只由最后一个有效通道请求新回合。

Bash 通知通过 `bg-bash-report` 紧凑消息交付，采用原生 Bash 纯文本格式。终态投递保持 `pending → submitted → observed`，host 接收不等于模型已读；同步拒收会恢复 pending 并报告错误，不能静默丢结果或无界重试。reminder 不参与该终态状态机。

结果受固定输出、字节与条目上限约束：registry 终态输出上限 64 KiB、最近已交付终态 64 条、活动或未确认结果最多 64 条；消息内联输出最多 10,000 字符，批次最多 24,000 UTF-8 字节、8 条。未确认结果受保护，不因保留上限淘汰。日志提供完整输出。

任务记录启动分支 anchor，离开该分支后暂停自动投递，回到分支重新协调；已经交给 host 的消息不能撤回。不承诺进程崩溃后的 exactly-once，不新增持久化 outbox。

## 提示与旧契约清理

工具默认 deferred。未激活时，`deferred_tools` 分别介绍 background Bash 和 subagents；存在可用 discovery 入口时才提示调用。激活后分别使用 `bg_bash_guidance`、`subagent_guidance`，说明自动返回结果、继续独立工作或结束当前 turn、禁止轮询等待。

当前源码、测试、README 和有效契约文档删除旧 job/task 工具名称；历史 plans、迁移记录保留。memory 不再将废弃等待工具的执行时间计入 idle compaction，空闲计时沿用 settled 时间。
