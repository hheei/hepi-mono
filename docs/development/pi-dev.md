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
启动器优先解析全局安装的 Pi CLI（或 `PI_CLI` 环境变量），回退时从 `packages/pi-ext-tools/node_modules/@earendil-works/pi-coding-agent` 解析本地 Pi CLI。

## 固定加载组合

启动器显式加载以下入口，不根据包 manifest 自动发现或选择扩展：

| 扩展 | 入口 | 启动前处理 |
| --- | --- | --- |
| `pi-ext-addon` | `packages/pi-ext-addon/dist/extension.js` | 增量构建 TypeScript |
| `pi-ext-memory` | `packages/pi-ext-memory/dist/extension.js` | 增量构建 TypeScript |
| `pi-ext-tools` | `packages/pi-ext-tools/dist/extension.js` | 增量构建 TypeScript |
| `pi-optimizer` | `packages/pi-optimizer/dist/extension.js` | 增量构建 TypeScript |
| `pi-settings` | `packages/pi-settings/dist/extension.js` | 增量构建 TypeScript |
| `pi-status` | `packages/pi-status/dist/extension.js` | 增量构建 TypeScript |
| `pi-subagents` | `packages/pi-subagents/dist/extension.js` | 增量构建 TypeScript |
| `pi-web-access` | `npm:pi-web-access` | 外部包（无需本地构建） |

`pi-ext-core` 在上述 TypeScript 扩展之前构建，但不会作为扩展加载。
没有包选择环境变量；仅运行某个扩展时，使用[开始使用](../user/getting-started.md)中的直接加载命令。

## 构建缓存

- TypeScript 保存输入指纹，写入 `.pi-dev/build.json`。
- 首次运行、输入变化或所检查的构建产物缺失时触发构建；未变化时跳过。
- 构建失败时不启动 Pi。

## 运行与认证边界

- 这不是隔离配置环境：沿用 `~/.pi/agent`，不复制或链接认证、模型文件，也不创建独立 profile。
- 启动参数包含 `--no-extensions` 和 `--no-approve`；默认扩展发现及扩展审批被禁用，应只运行可信的本地代码。
- 技能、prompt、theme 和项目配置仍由 Pi 默认路径与传入参数决定。
- 启动器移除子进程的 `OPENAI_API_KEY`，避免它覆盖 Pi 默认认证。需要临时显式指定密钥时，可使用 Pi 的 `--api-key` 参数。
- Pi 继承调用者的当前工作目录；从其他目录调用脚本时，项目资源按该目录解析。

## 故障排查

- **找不到本地 Pi CLI**：在仓库根目录完成依赖安装后重试。
- **需要强制重建**：删除 `.pi-dev/build.json` 后重新启动。该文件只保存构建指纹，不包含认证、会话或 Pi 配置。
- **构建失败**：根据启动器输出修复对应 TypeScript 构建错误；不要将未成功生成的入口当成可运行版本。
