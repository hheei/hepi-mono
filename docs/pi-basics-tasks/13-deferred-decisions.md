# 13｜不阻塞第一版的待决策项

## 目标

记录开放问题，避免 agent 自行扩张范围或把临时选择伪装成最终 API。第一版可以用最小、可逆、文档化的默认行为继续实现。

## 待决策项

### Settings 第一层是否显示 General

默认：只显示通过 `registerHePiSettings()` 注册且有内容的 provider。若需要 General，必须把它实现成 pi-basics 自己注册的普通 provider，不能在 TUI 内硬编码特殊分支。

### `/hepi setting <provider-id>` 是否直接跳转

默认：解析参数并保留在 module context；若第一版未实现跳转，显示清楚提示或按已定义 fallback 打开 Settings，不得静默假装跳转成功。补充跳转时必须增加 selection identity test。

### Shift+Tab key encoding

默认：先以 Pi/TUI 实际收到的 input sequence 为准；不要只凭文档猜测。实现 component input mapping 和真实 Pi 手测记录后，再决定是否抽通用 key constant。

### public API subpath export

默认：先从 `src/api/index.ts` 提供 named exports；只有 package exports 配置、构建/加载方式和实际消费者都确定后，才增加 `@hheei/pi-basics/api` subpath。

### Footer owner

默认：第一版不接管 Pi footer，只保留 contribution boundary。未来若成为唯一 custom footer owner，需单独任务，明确 ownership、清理、与 Pi 默认 footer 的兼容策略。

## Agent 规则

- 这些决策不阻塞 Phase 0–3。
- 选默认值时优先最小实现、可逆、符合现有 contract 的方案。
- 每个临时选择写入相关 README/task 的“当前行为”，不要新增隐式全局开关。
- 一旦决策影响 public API、storage shape、输入编码或全局 UI ownership，停止扩张并创建独立决策任务。
