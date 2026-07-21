# 08｜测试基础设施与覆盖策略

## 目标

让测试和 source 同时交付，保证 Settings 行为可重现、可回归，不依赖真实 terminal 或复制整个 Pi interactive loop。

## 目录与 helpers

创建：

- `packages/pi-basics/test/helpers.ts`：fake theme、fake host、render text、去 ANSI、可见宽度断言、fake provider/storage。
- `test/fixtures/settings.ts`：boolean、enum、text、number、path、空 provider、group/panel fixtures。
- `test/api/`：module/provider registration、collision、ordering、public exports。
- `test/modules/setting/`：model、controller、component、layout、value-editor。
- `test/ui/`：text、render、border、tabs、keymap。

## 必测行为

### Model

- selection identity 在 search、tab、排序、group collapse 后保持。
- group collapse/filter/no results。
- Navigation/Edit transition。
- boolean toggle、option cycle、draft commit/cancel。
- parser exception、`NaN`、无效 option。

### Controller

- provider load、defaults merge、onLoad。
- optimistic update、save queue 顺序。
- async save error rollback；失败时 draft、selection、committed value 保留。
- `onChange`、storage write、`onClose` callback ordering。

### Renderer/component

- 宽/窄 layout、Description panel、固定高度。
- 每行 visible cell width 不超终端宽度。
- Unicode 图标实际 width，不用 `string.length`。
- selected key viewport、wrap、ellipsis、scroll arrows。
- 输入事件、`requestRender`、Esc/Enter、cursor Home/End。
- ANSI 不作为唯一 snapshot；同时断言去 ANSI 后文字和 width。

### Pi integration

只测试 command registration、单次注册、TUI mode guard 和 module route；不启动不可控 interactive loop。

## 执行规则

- 使用 Bun test，沿用 monorepo 当前风格。
- 每个非平凡 state transition 至少有一个能在旧实现失败的 regression test。
- 每个 TUI test 至少覆盖一个窄宽度和一个宽宽度。
- fake storage 必须支持成功、延迟、失败，测试不能依赖真实 HOME、cwd 或文件。

## 验收命令

```bash
bun test packages/pi-basics/test
bun run typecheck
bun run check
```

失败时区分新任务失败与仓库既有失败；不得为了让全局测试变绿修改无关 package。
