# 本仓库 Pi 开发启动

`pi-dev`（或 `scripts/pi-dev`）增量构建固定的本地扩展组合，并通过 Node 启动 Pi host。
它替换本次进程的默认扩展发现，不写入 Pi 配置；认证、模型、会话和资源仍沿用 Pi 默认路径。

## 使用

前置条件：Node.js >=22.19.0、pnpm >=12.4.1。
在仓库根目录执行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pi-dev # 或 scripts/pi-dev
```

Pi 参数直接追加，例如 `pi-dev --model <provider/model>`。
启动器默认使用 `packages/pi-ext-tools/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`，即仓库锁定的未捆绑 Pi host。它会加载 pnpm 管理的 `pi-tui` 补丁；全局 Pi 和 `dist/bundle/cli.js` 内嵌的 TUI 不会使用该补丁，因此不再作为自动回退。

启动前会打印实际 CLI 路径。`PI_CLI` 仍可显式指定其他入口，同时提示仓库补丁不保证生效；路径不存在时直接报错，不静默改用其他 host。此选择不修改模型、供应商或 Pi 配置。

## 固定加载组合

启动器显式加载以下入口，不根据包 manifest 自动发现或选择扩展：

| 扩展 | 入口 | 启动前处理 |
| --- | --- | --- |
| `pi-ext-addon` | `packages/pi-ext-addon/dist/extension.js` | 增量构建 TypeScript |
| `pi-ext-memory` | `packages/pi-ext-memory/dist/extension.js` | 增量构建 TypeScript |
| `pi-ext-tools` | `packages/pi-ext-tools/dist/extension.js` | 增量构建 TypeScript |
| `pi-ext-ui` | `packages/pi-ext-ui/dist/extension.js` | 增量构建 TypeScript |
| `pi-optimizer` | `packages/pi-optimizer/dist/extension.js` | 增量构建 TypeScript |
| `pi-settings` | `packages/pi-settings/dist/extension.js` | 增量构建 TypeScript |
| `pi-status` | `packages/pi-status/dist/extension.js` | 增量构建 TypeScript |
| `pi-subagents` | `packages/pi-subagents/dist/extension.js` | 增量构建 TypeScript |
| `pi-web-access` | `npm:pi-web-access` | 外部包（无需本地构建） |
| `codemode`（内置） | `builtin:codemode` | 无需构建；由 `pi-ext-ui` 通过 `registerToolRenderer` 提供折叠与元工具看板渲染 |
| `tool-search`（内置） | `builtin:tool-search` | 无需构建；同上，且它默认 inactive，需由 `defaultTools` 激活 |
| `mcp`（内置） | `builtin:mcp` | 无需构建；消费配置文件及 extension 的原生 MCP server 注册 |

`codemode` 由 `pi-ext-tools` 注册，复用 Pi host 的 codemode 工厂并读取 host 设置；重复加载
`builtin:codemode` 会产生工具冲突警告。`tool-search` 用 `builtin:` 路径显式加载。
pi-dev 会话同样受 `defaultTools`（例如 `["+codemode", "+tool_search"]`）和 `codemode.mode`
设置控制。`tool-search` 注册为 inactive，仅加载它并不会激活它。

两者配合的方式：`codemode.mode: "only"` 把 `direct` 工具从模型声明中隐藏，只留 codemode 描述里的
目录；`deferred` 工具既不进声明也不进那个目录，靠 `tool_search` 按查询加载，或由 codemode 脚本通过
`tools` 全局与 `ALL_TOOLS` 访问。MCP 同样显式加载，支持 memory 的 session-scoped Hindsight 注册，并读取 Pi 的 MCP 配置；其他内置扩展（如 `llama.cpp`）仍保持禁用；需要时用同样的
`--extension builtin:<name>` 显式追加。

`pi-ext-core` 在上述 TypeScript 扩展之前构建，但不会作为扩展加载。
没有包选择环境变量；仅运行某个扩展时，使用[开始使用](../user/getting-started.md)中的直接加载命令。

## 构建缓存

- TypeScript 保存输入指纹，写入 `.pi-dev/build.json`。
- 首次运行、输入变化或所检查的构建产物缺失时触发构建；未变化时跳过。
- 构建失败时不启动 Pi。

## 运行与认证边界

- 这不是隔离配置环境：沿用 `~/.pi/agent`，不复制或链接认证、模型文件，也不创建独立 profile。
- 启动参数包含 `--no-extensions`，默认扩展发现和内置扩展被禁用；`builtin:tool-search` 与
  `builtin:mcp` 由启动器显式重新启用。
- 默认传入 `--approve`，本次运行信任当前项目并加载项目资源；不写入持久化信任决定。
  显式传入 `--no-approve` 可覆盖默认值，忽略项目本地资源。
- 技能、prompt、theme 和项目配置仍由 Pi 默认路径与传入参数决定。
- 启动器移除子进程的 `OPENAI_API_KEY`，避免它覆盖 Pi 默认认证。需要临时显式指定密钥时，可使用 Pi 的 `--api-key` 参数。
- Pi 继承调用者的当前工作目录；从其他目录调用脚本时，项目资源按该目录解析。

## 故障排查

- **找不到本地 Pi CLI**：在仓库根目录完成依赖安装后重试。
- **折叠仍清空终端滚动历史**：确认启动输出是 workspace 的未捆绑入口，而不是 `PI_CLI` 指向的 bundle。依赖补丁修改后重新安装依赖并重启进程；`/reload` 只重载扩展，不能替换已加载的 host/TUI。
- **需要强制重建**：删除 `.pi-dev/build.json` 后重新启动。该文件只保存构建指纹，不包含认证、会话或 Pi 配置。
- **构建失败**：根据启动器输出修复对应 TypeScript 构建错误；不要将未成功生成的入口当成可运行版本。
