# 10｜原计划 TODO 逐项执行清单

## Package 与 runtime

- [ ] `packages/pi-basics/package.json`：`@hheei/pi-basics`、`main: src/index.ts`、`pi.extensions`。
- [ ] `packages/pi-basics/README.md`：`/hepi setting`、加载方式、public API 示例和非目标。
- [ ] `src/index.ts`：只初始化 runtime、注册 command、注册内建 Settings。
- [ ] `src/runtime/registry.ts`、`context.ts`、`lifecycle.ts`。
- [ ] `src/api/index.ts`：区分 public API/internal implementation。
- [ ] `scripts/pi-dev.mjs`：`basics`/`pi-basics` alias。

## Settings API

- [ ] 定义 provider/group/field/state/change 类型。
- [ ] 定义 global/project/session storage adapter，不引用 `pi-extcore`。
- [ ] 实现 module/provider registration 和 collision 检查。
- [ ] 实现 provider snapshot、state merge、defaults、change routing。
- [ ] 实现 provider async save queue、optimistic state、rollback。
- [ ] README 提供其他 module 可复制的最小 provider 示例。

## Model/controller

- [ ] selection identity、Navigation/Edit、draft state。
- [ ] boolean toggle、option cycle、text/number parse/validate、Esc rollback。
- [ ] parser exception、`NaN`、invalid option。
- [ ] 只显示 registered 且有内容的 provider。

## TUI

- [ ] rounded border、active/inactive tab。
- [ ] indicator/key/value 固定栏位、selected key viewport。
- [ ] 宽 Description：固定高度、wrap、ellipsis。
- [ ] 窄 Value 区域和 editor viewport。
- [ ] search、collapsed group、No results、scroll arrows。
- [ ] Navigation/Edit footer keymap。
- [ ] 所有 render line 通过 visible width/truncate/窄终端检查。
- [ ] 验证目标图示的实际 terminal cell width。

## Command 与边界

- [ ] 单一 `/hepi` dispatcher。
- [ ] `/hepi setting` 与非 TUI 错误。
- [ ] module registration API，不添加未指定空壳 command。
- [ ] 保留 Editor/Footer 边界，不接管 Pi editor/footer。
- [ ] source/API 不 import `pi-loadout`、`pi-ssh`、`pi-inturl`、`pi-extcore`。

## 测试与验证

- [ ] `test/`、helpers、fixtures。
- [ ] API、model、controller、component、layout、value-editor、UI 测试。
- [ ] selection/search/group regression。
- [ ] toggle、draft commit/cancel、parse error regression。
- [ ] save queue、rollback、callback ordering integration。
- [ ] `bun test packages/pi-basics/test`。
- [ ] `bun run typecheck`、`bun test`、`bun run check`。
- [ ] `bun run pi:dev -- basics` 手动验收。
- [ ] 窄/宽、无色彩、不同字体环境排版验收。

## 使用方式

Agent 每完成一项必须附上对应文件、测试和证据；无法完成的项标记阻塞原因，不得删除清单或改成“后续处理”。
