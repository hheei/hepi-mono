# 隔离的本仓库 Pi 开发启动

`scripts/pi-dev` 用仓库根目录安装的
`@earendil-works/pi-coding-agent` 启动 Pi，并把 `PI_CODING_AGENT_DIR`
指向仓库内的隔离配置目录。因此它不读取用户的 `~/.pi/agent` 配置、已安装
Pi 包、扩展、技能或主题，也不加载项目 `.pi/` 中自动发现的资源。

脚本只在隔离 `settings.json` 中登记本仓库已构建包目录。Pi 依照每个包
`package.json` 的 `pi` 字段加载其声明的扩展、技能和主题；脚本不维护第二份
资源清单。

## 边界和接口

- 入口：`scripts/pi-dev [Pi 参数...]`。
- 包来源：仓库 `packages/` 下选定的本地 Pi 包，使用其原有 `pi` manifest。
- 隔离状态：配置、会话和包设置都保存于 `.pi-dev/`，不会修改用户 Pi
  的配置目录。
- 认证和模型来源：当隔离 `auth.json` 或 `models.json` 不存在或为空时，启动器
  链接当前 Pi 的对应文件，不复制密钥或 provider 定义；可用
  `PI_DEV_AUTH_FILE`、`PI_DEV_MODELS_FILE` 指定来源。
- 启动前构建所选本地包并强制 TypeScript 产出 `dist`，构建失败时不启动 Pi。

默认使用 `cx/gpt-5.6-luna` 和 `low` thinking。命令行传入的 Pi 模型与
thinking 参数仍可覆盖此默认值。启动器不会向子进程继承父进程的
`OPENAI_API_KEY`，避免旧 OpenAI 凭证覆盖隔离 `cx` 认证；需要 OpenAI 时用
Pi 的 `--api-key` 参数显式提供。

默认加载全部本仓库 `pi-*` 包。可用 `PI_DEV_PACKAGES` 传入以逗号分隔的包目录名
测试局部组合，例如 `PI_DEV_PACKAGES=pi-auto-title,pi-subagents`。

默认集为 `packages/pi-*` 下的本仓库 `@hheei` 独立包。脚本不加载已弃用的
`hepi-*` 聚合包、开发诊断包 `hepi-debug` 或独立子模块 `hepi-subagents`。
