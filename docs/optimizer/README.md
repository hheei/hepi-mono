# pi-optimizer 迁入与功能边界

## 用户目标

以独立 `@hheei/pi-optimizer` 替换 `@hheei/pi-t2s`，复用 OMP optimizer 的 Caveman、Ponytail、RTK 规则与本仓库现有 T2S、RTK 实现。提供 `/optimizer` 统一配置入口，不迁入 apply_patch/hashline 防卫、sudo 策略或 tool-result 警告过滤器。不自动选择模型、不改写历史或文件。

## 所有权与数据流

- `pi-optimizer` 拥有输入转换、提示词模式、RTK 重写策略、配置与当前会话状态。
- ext-core 提供既有生命周期、Settings registry、原子 JSON settings transport，以及需要时的 Surface/Widget 生命周期。
- Pi host 或 `pi-ext-tools` 继续拥有 bash 注册、实际执行、Target、Output 与渲染；optimizer 不注册 bash，不依赖其他 concrete extension。
- RTK 从 `pi-ext-tools` 完整迁出，删除旧 provider、hook 与运行时状态，避免双重重写。

```text
Settings / /optimizer -> validated persisted settings -> session state
  input              -> interactive prose T2S
  before_agent_start -> existing prompt + enabled prompt fragments
  tool_call          -> eligible bash argument rewrite -> existing bash owner
```

## 配置契约

单个 provider `pi-optimizer`，全局 settings.json 的 `pi-optimizer` section 使用以下分组：

```json
{
  "pi-optimizer": {
    "t2s": { "mode": "t2s" },
    "caveman": { "level": "off" },
    "ponytail": { "level": "off" },
    "rtk": { "enabled": false, "path": "" }
  }
}
```

Caveman 档位为 off/lite/full/ultra/micro；Ponytail 为 off/lite/full/ultra。未配置时 T2S 开启，其余关闭。RTK 可指定 executable path。边界严格验证，不以未知/无效值静默启用功能。

新配置各组优先；缺失组从旧 pi-t2s.traditional-to-simplified、pi-basics.traditional-to-simplified 以及 pi-ext-tools 的 rtk/rtkPath 导入。原子更新只移除已迁功能字段，保留其他 root/section sibling。失败保留原文件；重复读取幂等；不读取 OMP lockfile。

Settings 与 `/optimizer` 共用 provider/storage。保存成功才更新活动会话，失败保留旧值并报告错误。Prompt 变化从下一轮生效，输入与命令变化只影响后续事件，不追改正在执行的调用。resume/fork 使用当前持久设置，不追加另一份可覆盖设置的 session-level 配置。非法配置时会话功能关闭，provider 仍可用于修复。

## 行为与安全边界

T2S 保留当前 tw -> cn 与 inline/fenced code 保护，只处理 interactive 来源，并限制活动 session identity。

Prompt 复用 OMP 原文与档位逻辑，适配 Pi 的 string systemPrompt，固定顺序组合而不丢弃其他扩展的 prompt，不积累上一轮片段。RTK 提示词必须符合本地前台适用范围，不能要求所有命令无条件加前缀。

RTK 复用现有 Pi 的 signal/timeout/custom path/失败处理，以官方 rewrite 为主，仅对可安全识别的命令应用 OMP 补充规则。跳过非 local Target、PTY、async 与已经包装的命令。不能把有限 quote scanner 当完整 shell parser。只在 rewrite 查询失败且命令尚未执行时回到原命令；已执行的命令失败后绝不自动重跑。取消或 session 替换后的异步结果不得更新命令或新 session 状态。

命令重写与失败必须可检查，保留原命令及执行命令的可见记录；headless/RPC 不能仅依赖 transient notification。Output 保存实际子进程输出，即 RTK 模式下的过滤后输出，不承诺还原 RTK 丢弃的原始文本。用户可在执行前关闭 RTK 获得未过滤输出；本次不增加 raw capture。

所有实际注入统一使用 Pi 原生 `optimizer-info` custom entry：T2S 仅在文本改变时记录原文/结果；Prompt 每轮注入时记录启用档位及完整注入片段；RTK 记录原命令/执行命令或查询失败原因。Settings 保存成功与错误也进入同一 info 流。使用 `appendEntry` + `registerEntryRenderer`，不使用 steering/custom message 队列：TUI 在 `entry_appended` 时立即显示，resume 可重放，且记录不进入模型上下文、不触发额外 turn。默认显示紧凑 info 摘要，展开保留完整 payload；不是仅显示 transient notify，也不另造审计框架。

Settings schema 同时定义运行时类型与有效值，原生菜单/参数命令复用 provider 字段，不重复维护档位分支。保留原子迁移、取消和会话身份边界；删除仅转抄同形对象的适配函数和重复测试 fixture。

## 交互

`/optimizer` 统一列出四项功能、当前值与 RTK 路径，通过 Pi 原生交互或 ext-core-managed surface 编辑同一份设置。不得复制第二套持久化状态。关闭/取消不能留下 stale surface；headless 不打开 TUI，提供可读状态/参数操作。所有动态状态遵循 DESIGN.md 的 ANSI/cell-width 与主题规则，不依赖 Nerd Font 图标辨识功能。

## 复用与切换

源参考：hheei/oh-my-pi 的 packages/hepi/omp-optimizer，调查时 HEAD 为 5d30ef8e55d54788afa3f316bf67348f6920987d（迁移以本地实际源码为准）。保留来源/许可，不 vendor 整个仓库。

T2S 从本仓库移动，提示词与相关行为测试从 OMP 迁入，RTK 从本仓库迁出并吸收源规则。最终删除 pi-t2s 包，不保留转发壳。更新 build、lockfile、安装列表与当前行为文档。既有外部安装按说明显式替换，不自动修改全局安装配置，不进行发布。

## 验证

复用并更新 T2S、RTK、提示词已有测试。补充配置原子迁移/并发/sibling preservation、保存失败、session 切换/取消、prompt 共存与不累积、真实宿主参数执行路径、单 RTK owner、SSH/PTY/async 跳过、可见命令记录和原生菜单窄宽行为。跨包切换运行根 typecheck 与全量测试，实际 Pi smoke 验证输入转换、配置与命令改写；无可用视觉运行工具时明确报告并以行为 smoke 覆盖。

## 使用与已验证边界

交互式 `/optimizer` 打开原生菜单；参数命令为 `status`、`t2s <t2s|off>`、`caveman <off|lite|full|ultra|micro>`、`ponytail <off|lite|full|ultra>`、`rtk <on|off>` 和 `rtk-path <path>`。空 `rtk-path` 恢复 PATH 查找，路径内部空格保留。

Headless 使用 `pi --mode json --print '/optimizer status'` 或 RPC 消费 `entry_appended`（`entry.customType = "optimizer-info"`）事件。Pi plain-text print renderer 不显示 custom entries，不能把无文字输出当作未执行配置操作。

迁入验证覆盖真实 Pi Agent → beforeToolCall → 原生 Bash 的执行参数链；provider response 与 rewrite query 在测试中固定，不调用模型网络。原生 Pi CLI smoke 使用隔离 settings，验证旧 T2S/RTK 配置迁移、菜单切换 Caveman、取消后清理及 48/120 列终端布局，没有修改用户全局配置或调用模型。
