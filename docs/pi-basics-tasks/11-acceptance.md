# 11｜第一版交付验收

## 目标

从用户可见行为和仓库边界验证第一版，而不是只验证 TypeScript 能编译。

## 必须通过

1. `packages/pi-basics` 可被 Pi 正常加载。
2. TUI mode 下 `/hepi setting` 打开 component；JSON/print mode 不创建 terminal component。
3. 通过 `registerHePiSettings()` 注册且有内容的 provider 可切换；未注册/空 provider 不显示。
4. 宽模式有右侧 Description panel；窄模式隐藏 panel，显示两行 Value 区域。
5. Boolean Enter 直接切换；非 Boolean Enter 进入 Edit，第二次 Enter 提交，Esc 取消。
6. Edit 中列表仍显示 committed value，draft 只在 editor。
7. Search、scroll、group collapse、async save error 不丢 selection 或 setting。
8. active/selected/edit/error 不只靠颜色；无色彩时也有结构、符号或文字提示。
9. model、renderer、component、controller、API 测试全部通过。
10. 不依赖、修改或要求 `pi-extcore`、`pi-loadout`、`pi-ssh`、`pi-inturl`。
11. `bun run typecheck`、`bun test`、`bun run check` 全部通过。

## 验收步骤

1. 运行 focused package tests。
2. 运行 monorepo typecheck、全量 test、check。
3. 运行 `bun run pi:dev -- basics`，在真实 Pi TUI 输入 `/hepi setting`。
4. 手动覆盖：provider 切换、boolean toggle、text/number edit、parse error、Esc cancel、save failure、search、group collapse、上下滚动、左右 tab、Tab/Shift+Tab 实机 encoding。
5. 调整终端为窄宽和宽宽，再以无色彩环境观察；确认每一行不溢出且提示不被截断成不可读状态。
6. 记录 Pi/Bun/终端宽度、实际命令、观察结果和未验证限制。

## 失败处理

- 行为失败：新增能复现用户可见问题的 regression test，修根因后重跑。
- 既有仓库失败：保留原错误证据，不修改无关 package。
- 交互或 PTY 无法自动化：标记为手动未验证，不声称通过。

只有全部必须项有证据，才可以把计划状态改为第一版完成。
