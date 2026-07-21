# 03｜架构与目录骨架

## 目标

按原计划建立 package、runtime、command、api、Settings module、ui 和 test 的边界。骨架必须能被后续 agent 直接接手，不以大量空壳功能冒充完成。

## 目标目录

```text
packages/pi-basics/
├── package.json
├── README.md
├── src/
│   ├── index.ts
│   ├── command/{hepi-command.ts,command-types.ts}
│   ├── runtime/{registry.ts,context.ts,lifecycle.ts}
│   ├── api/{index.ts,modules.ts,settings.ts,panels.ts,contributions.ts}
│   ├── modules/setting/{index.ts,model.ts,controller.ts,component.ts,layout.ts,render.ts,value-editor.ts}
│   ├── ui/{border.ts,text.ts,keymap.ts}
│   └── errors.ts
└── test/{helpers.ts,fixtures/settings.ts,api,modules/setting,ui}
```

## 实现步骤

1. 参考 `docs/extension-development.md` 创建 package manifest：`type: module`、`main: src/index.ts`、`pi.extensions: ["src/index.ts"]`、正确 peer dependencies。
2. 只让 `src/index.ts` 负责创建 session runtime、注册一次 `/hepi`、注册内建 Settings module；不要把字段定义或 render 细节放进去。
3. 创建 runtime context，明确保存当前 Pi session 的 `pi`、`ctx`、registry、requestRender/close 等能力；不要放跨 session singleton state。
4. 创建 registry 的接口和测试用内存实现；先支持 module/provider registration、排序、查询、collision error、清理注册。
5. 创建 test helpers 和 fixtures，使后续测试不依赖真实 terminal。
6. 所有暂未实现的 `contributions` API 必须是清楚的类型边界或显式未启用入口，不得暴露 no-op 假功能。

## 分层检查

- `index.ts` 不操作字段 state。
- `command/` 不读写 storage。
- `runtime/` 不 render UI。
- `api/` 不持有单一 module domain state。
- `ui/` 不保存 settings/session state。
- test 不启动真实交互 loop。

## 验收与命令

- [ ] package 可被 TypeScript 解析。
- [ ] 目录和 import boundary 与计划一致。
- [ ] `bun run typecheck` 通过。
- [ ] `bun test packages/pi-basics/test` 至少能运行基础测试。
- [ ] `src` 中没有四个排除 package 的 import。

## 非目标

不在本任务实现完整 Settings 行为；后续任务负责具体 API、model、controller、TUI。
