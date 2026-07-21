# 09｜分阶段实施与交付编排

## 目标

把实现拆成有依赖的阶段，避免先造空壳、先接 UI 再发现 contract 不完整，或一次实现所有 future module。

## Phase 0：自有 contract

输入：`01`–`03`。

交付：package manifest、README、`src/index.ts` 骨架、runtime registry/context/lifecycle、public API 最小类型、test helpers/fixtures。

完成条件：无旧 extension 依赖；collision、ordering、session isolation 基础测试通过。

## Phase 1：Settings model/controller

输入：`04`、`08`。

交付：provider snapshot、state merge/default、selection identity、Navigation/Edit、committed/draft、parse/validate、async save queue、optimistic update、rollback、callback ordering。

规则：先让 model/controller tests 通过，再连接 TUI；不要在 component 中补 domain 规则。

## Phase 2：Settings TUI

输入：Phase 1、`02`、`06`、`08`。

交付：shell、tabs、provider list、search、group、wide/narrow layout、Description、footer keymap、value editor、component input routing。

完成条件：renderer/component/value-editor tests 通过，窄宽度不溢出。

## Phase 3：`/hepi setting` 整合

输入：Phase 0–2、`05`。

交付：单一 dispatcher、TUI guard、`scripts/pi-dev.mjs` alias、README 手动验收流程、Pi integration tests。

完成条件：`bun run pi:dev -- basics` 可以加载并运行 `/hepi setting`。

## Phase 4：未来功能

输入：第一版验收完成、`07`、`13`。

每次只添加一个 module：独立 source、public contract、`test/modules/<name>/`、command/lifecycle 接入。除非第二个真实使用者出现，不抽 shared。禁止一次创建所有空壳 command。

## Agent 执行协议

每个 phase 开始前：检查前置 phase 的测试和未解决事项。每个 phase 结束后：运行 focused test、typecheck，检查边界 import，再交给下一 phase。不要把“目录已创建”当作 phase 完成。
