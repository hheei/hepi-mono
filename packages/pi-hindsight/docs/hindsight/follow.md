# Pi Hindsight 上游跟随

## 目的

`packages/pi-hindsight` 是对 `https://github.com/luxus/pi-hindsight` 的二次开发包。此文档记录上游同步边界，避免把上游站点、CI 与发布治理再次带入工作区。

## 当前基线

- 上游仓库：`https://github.com/luxus/pi-hindsight`
- 初始导入版本：`@luxusai/pi-hindsight@0.11.1`
- 本地包名：`@hheei/pi-hindsight`
- 本地运行时：`extensions/`、`skills/`
- 本地验证：`tests/`、`vitest.config.ts`

## 保留边界

保留上游功能源码、技能、测试、运行说明与 ADR。删除上游专属的 GitHub Actions、Git hooks、发布配置、Astro 文档站、npm lockfile、发布脚本与治理文档。

HEPI 根目录的 `AGENTS.md`、Bun 工作区配置、Biome 与 TypeScript 规则是本包开发规范。

## 同步步骤

1. 在临时目录获取上游指定 commit 或 tag。
2. 比较 `extensions/`、`skills/`、`tests/`、`docs/` 与本包。
3. 按功能切片移植；不复制 `.github/`、`docs-site/`、`scripts/`、发布配置或 `package-lock.json`。
4. 保持 `package.json` 的本地包名、HEPI 仓库信息与 Pi `>=0.83.0` 依赖基线。
5. 对每个移植切片运行受影响测试与 `bunx biome check`；涉及包依赖时运行根目录 `bun install`、`bun pm ls` 与 `bun run typecheck`。

## 冲突处理

上游运行时行为与 HEPI 公共边界冲突时，优先采用 HEPI `AGENTS.md`。记录取舍到本目录的中文文档；不要通过兼容层保留已废弃的上游发布或站点机制。
