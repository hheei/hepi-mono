# 本仓库 Pi 开发启动

`scripts/pi-dev` 用仓库根目录安装的
`@earendil-works/pi-coding-agent` 启动 Pi，使用 Pi 默认的
`~/.pi/agent` 配置、认证、模型、会话和资源路径。它只替换本次进程加载的
extension，不写入 Pi 配置。

脚本读取本仓库包的 `package.json`，依照 `pi.extensions` 显式传入本地构建的
extension，并禁用默认 extension 发现。技能、prompt、theme 和项目配置仍由
Pi 默认路径与命令行行为决定。

## 边界和接口

- 入口：`scripts/pi-dev [Pi 参数...]`。
- 包来源：仓库 `packages/` 下选定的本地 Pi 包，使用其原有 `pi` manifest。
- Pi 状态：沿用 Pi 默认目录，不创建独立的配置目录，也不复制或链接认证、模型文件。
- 构建缓存：仅将构建指纹写入 `.pi-dev/build.json`；这不是 Pi 配置目录。
- 启动前构建所选本地包并强制 TypeScript 产出 `dist`，构建失败时不启动 Pi。
  选中 `pi-ext-tools` 时，启动器还会以增量 `local` profile 构建其
  `crates/pi-ext-bridge` N-API 模块。两类构建各有指纹，首次运行或对应输入变化时
  构建；同一 worktree、同一包集、未改源码时跳过构建。删除
  `.pi-dev/build.json` 可强制下一次构建。

启动器不会向子进程继承 `OPENAI_API_KEY`，避免环境变量覆盖 Pi 默认认证；需要
OpenAI 时用 `pi` 的 `--api-key` 参数显式提供。

默认加载全部本仓库 `pi-*` 包。可用 `PI_DEV_PACKAGES` 传入以逗号分隔的包目录名
测试局部组合，例如 `PI_DEV_PACKAGES=pi-auto-title,pi-subagents`。
默认集为 `packages/pi-*` 下的本仓库 `@hheei` 独立包。脚本不加载已弃用的
`hepi-*` 聚合包、开发诊断包 `hepi-debug` 或独立子模块 `hepi-subagents`。
