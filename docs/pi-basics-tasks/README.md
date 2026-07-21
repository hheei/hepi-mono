# pi-basics Agent 任务文件

本目录把 [`../pi-basics-plan.md`](../pi-basics-plan.md) 拆成可直接交给 agent 执行的任务。每个文件对应原计划一个主要章节；章节之间有依赖，不能把所有任务并行实现。

## 推荐执行顺序

1. `01-goals-and-boundaries.md`：确认边界与不可做事项。
2. `02-design-principles.md`：建立实现约束，尤其是 terminal cell 宽度和状态分层。
3. `03-architecture.md`：创建 package、目录、runtime 骨架和测试骨架。
4. `04-public-api.md`：完成自有 module/settings/storage contract。
5. `05-command.md`：完成 command 类型与 `/hepi` dispatcher。
6. `06-settings-tui.md`：实现 Settings module 的模型、controller、component 和渲染。
7. `07-runtime-boundaries.md`：补齐 lifecycle、contribution 边界和未来模块扩展点。
8. `08-testing.md`：持续补充并运行测试；不能等实现结束才补。
9. `09-phases.md`：按 Phase 0–4 管理交付顺序。
10. `10-todo-checklist.md`：逐项核对原计划 TODO。
11. `11-acceptance.md`：执行第一版交付验收。
12. `12-non-goals.md`：确认没有越界改动。
13. `13-deferred-decisions.md`：记录不阻塞第一版的待决策项。

## Agent 使用规则

- 每次只领取一个文件；先阅读本文件和原计划相关章节，再检查仓库现状。
- 先复现/写失败测试，再实现；测试必须放在 `packages/pi-basics/test/`。
- 复用仓库和 Pi 已有类型/组件；不要复制 `pi-extcore` 实现，不要新增依赖来解决几行代码的问题。
- 修改导出的 symbol 前先查 references；不要修改 Pi 安装目录或既有 `pi-loadout`、`pi-ssh`、`pi-inturl`。
- 完成后报告：改动文件、行为、测试命令、未验证项目、保留的非目标工作。

## 全局完成定义

第一版只有在 `packages/pi-basics` 能加载、`/hepi setting` 在 TUI mode 可用、窄/宽布局符合规范、保存失败可回滚、测试和 monorepo checks 通过时才算完成。任何仅有骨架、空壳 command、静默覆盖、依赖旧 extension 或只靠颜色表达状态的实现都不算完成。
