# pi-mctx 上游代码重建

## 目标

当前 `@hheei/pi-mctx` 与上游 Magic Context 的行为差异过大。本次先停止旧
extension 的加载，保留其源码以便比对；再以 `cortexkit/magic-context` 当前
`packages/pi-plugin` 为新 `pi-mctx` 的源码和测试基线。此阶段不承诺新实现可运行，
只建立可审阅的上游起点。

上游依据为
[`cortexkit/magic-context`](https://github.com/cortexkit/magic-context) revision
`7dcd2e5726a1466126b2eea460482cca2b53283b`。本地只读参考 clone 位于
`references/repos/cortexkit-magic-context`，不属于 Git、Bun workspace、发布包或
运行时 import 路径。

## 边界

- `packages/xpi-mctx/`：原 `pi-mctx` 的完整源码和测试快照。它保留在 workspace
  供 diff 和回归调查使用，但 package manifest 不再声明 Pi extension entry，Pi host
  不会自动加载它。
- `packages/pi-mctx/`：新的目标 extension package。初始内容复制上游
  `packages/pi-plugin/src/**`，包括 colocated `*.test.ts`、`test-preload.ts` 与
  `subagent-entry.ts`。
- `packages/xmagic-context/`：上游 `packages/plugin/src/**` 的完整源码和测试快照。
  它包含 OpenCode adapter 与被 Pi adapter 引用的共用 implementation，保留原始目录
  结构以满足 `@magic-context/core/*` import 的后续对照需求，但不作为 OpenCode plugin
  安装、编译或加载。
- Pi host：新包接入前不加载任何 MCTX entry；不读取旧 SQLite、旧配置或旧 session
  state。
- ext-core：本阶段不增加 capability、生命周期、TUI 或 storage contract。

```text
旧 pi-mctx (Pi entry) ──rename──> xpi-mctx (无 Pi entry，存档)

cortexkit/magic-context@7dcd2e
  packages/plugin/src/** ──────copy──> packages/xmagic-context/src/**
                                          │
  packages/pi-plugin/src/** ────copy──> packages/pi-mctx/src/**
                                          │
                                          └── 两者均尚未注册到 Pi host
```

## 导入范围

复制 extension 直接拥有的 TypeScript 文件和测试：上游 `plugin/src/**` 与
`pi-plugin/src/**` 的完整树，包括 `commands/`、`dialogs/`、`dreamer/`、`tools/`、
`features/`、`hooks/`、`shared/` 和 OpenCode adapter。保留源文件名和相对 import，
以便之后逐项对照上游 commit；不在本阶段重构为 HEPI layout。

不复制：`node_modules`、`dist`、benchmark/experiment scripts、上游 package lock、
上游构建配置和依赖声明。源码基线还没有运行或编译入口，故不添加未被执行代码消费的
依赖。仓库禁止声明或安装 `@opencode-ai/*`；将来需要运行 OpenCode adapter 时必须先做
独立兼容性决策，不能以源码复制隐式绕过该约束。

## 启用与验证

默认建议新 `pi-mctx` 也不声明 Pi extension entry，直到首个可运行的 HEPI-adapted
slice 明确设计、测试并验证。这样安装当前 worktree 时仍只有 Pi native context
behavior，不会把未适配上游代码带入用户 session。

本阶段验证仅包括：旧 package 无 `pi.extensions` entry；两个新 source/test tree 与固定
upstream revision 的文件清单一致；根 workspace 不尝试解析上游依赖。没有 TypeScript
build 或 host lifecycle 成功的声明。

根 `biome`、TypeScript 与 Bun test command 明确忽略两个 source baseline。它们不是已
采用的 HEPI code，不能以关闭整个根检查或伪造依赖的方式让其通过；首个适配 slice
落地时，必须把其拥有的文件从忽略项移除并纳入正常验证。

后续每个真实功能 slice 必须先定义 Pi host、ext-core、`pi-mctx` 的 owner、缺失
fallback、cleanup、cancellation 和并发语义，再恢复一个最小 Pi entry，并在实际 Pi
host 或 `tui-replay` 验证可见行为。
