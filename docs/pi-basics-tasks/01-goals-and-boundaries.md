# 01｜目标与边界

## 目标

建立 `packages/pi-basics`，包名 `@hheei/pi-basics`，以 `src/index.ts` 作为唯一 Pi entry。第一版只交付 Settings TUI 和 `/hepi setting`，为未来 HePi module 提供独立、稳定、可选使用的 API。

## 交付范围

- 新建 `packages/pi-basics` package。
- 注册单一根命令 `/hepi`，第一版支持 `setting`。
- Settings provider 可注册、排序、切换、读取、编辑、保存和回滚。
- 提供 module、settings、panel/contribution 的最小公开 contract，但未来功能只留边界，不实现空壳。
- 建立一等测试目录 `packages/pi-basics/test/`。

## 硬性边界

- 不开发、修改或延长 `pi-extcore`。
- 不 import、整合或改写 `pi-loadout`、`pi-ssh`、`pi-inturl`。
- 不 fork 或修改 Pi 安装目录、interactive mode、editor、footer。
- 不把跨 session 的 mutable state 放进 module/global registry。
- 不在第一版实现 `continue`、`goal`、`advisor`、`plan`、`btw`、`todo`、`snapcompact`、`loadout`。

## 执行步骤

1. 检查仓库当前 package、scripts、Pi API 和现有 dirty work；不得覆盖无关改动。
2. 将上面范围写入 package README 的 scope/non-goals。
3. 搜索新 package 可能依赖的旧 extension import；发现任何反向依赖立即移除设计。
4. 以本文件作为每个后续任务的 scope gate。

## 完成标准

- [ ] package 名称、入口和第一版功能与原计划一致。
- [ ] README 和代码没有暗示未实现 future module 已可用。
- [ ] `pi-basics` source/API 不依赖四个明确排除的 package。
- [ ] 每个后续任务都能指出自己没有越过本边界。
