# 测试运行时

HEPI 的日常开发、构建和测试控制平面使用 pnpm、Node 22.19+ 与 Vitest。Pi 的 npm host 是 Node，因此默认测试必须在 Node 中执行。仓库开发工具链与用户侧 `pi install npm:@hheei/...` 无关。

```text
pnpm install --frozen-lockfile --ignore-scripts -> pnpm run build -> pnpm run check -> Vitest (Node)
```

## 运行时边界

- Vitest 使用 workspace source alias，不依赖尚未构建的 workspace `dist`。
- `test.sh` 用临时 HOME、TMPDIR 与 pnpm home 运行测试，不读取用户凭据或本地 Pi 状态。
- Bun 不是默认 test runner。它仅作为显式 compatibility runtime：Pi standalone binary、Bun-host smoke，以及产品明确要求的 Bun child runtime。
## 依赖与发布

- 内部依赖使用 `workspace:^` 别名（故意不带显式版本），由 pnpm 在 workspace 中链接本地 package，并在 `pnpm publish`/`pnpm pack` 时自动改写为该包当时的实际版本（例如 `^0.1.2`）。这样各包独立发版时不需要手工同步内部范围；只在需要收窄兼容范围时才写显式版本。`npm pack` 不会做该改写，因此发布与产物校验都必须走 pnpm。首次发布或升级时必须先发布 `@hheei/pi-ext-core`，再确认所有内部范围仍能解析到已发布版本。

每个声明 Pi peer contract 的 workspace 只把自身直接 import 的 Pi package 固定为本地精确 dev dependency：同一 package 若同时出现在 peer 与 dev 声明中则使用精确版本，未被 import 的 Pi package 不再声明（例如仅使用 `pi-coding-agent` 的 workspace 不再声明 `pi-agent-core`、`pi-ai`、`pi-tui`）。root 不重复声明它们；公开 peer range 保持最低兼容版本。pnpm 使用 isolated `node_modules`，各 workspace 的直接 devDependency 仍会出现在该包自己的 `node_modules` 中。

`pnpm-workspace.yaml` 的 `patchedDependencies` 给 `@earendil-works/pi-tui` 打上仓库维护的 TUI patch。

## 验证顺序

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
./test.sh
pnpm run check
```

Node control-plane migration 不得静默删除 Bun-host coverage；任何移除 Bun path 的变更必须另行证明 Pi binary 与 Eval runtime 的兼容契约已被替代。
