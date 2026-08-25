# 测试运行时

HEPI 的日常开发、构建和测试控制平面使用 npm、Node 22.19+ 与 Vitest。Pi 的 npm host 是 Node，因此默认测试必须在 Node 中执行。

```text
npm ci -> npm run build -> npm run check -> Vitest (Node)
```

## 运行时边界

- Vitest 使用 workspace source alias，不依赖尚未构建的 workspace `dist`。
- `test.sh` 用临时 HOME、TMPDIR 与 npm cache 运行测试，不读取用户凭据或本地 Pi 状态。
- Bun 不是默认 test runner。它仅作为显式 compatibility runtime：Pi standalone binary、Bun-host smoke，以及产品明确要求的 Bun child runtime。
- `pi-mctx` 的 SQLite adapter 保持 Node `node:sqlite` 与 Bun `bun:sqlite` 双路径；Node 是默认 coverage，Bun 兼容 smoke 另行运行。
- `pi-mctx/scripts/handoff-live-smoke.ts` 是显式、需要凭据和网络的 Node handoff host smoke，不属于默认测试 gate。它通过 Jiti 加载 TypeScript source，并在 Node 与 Bun 条件下解析同一套 `#core/*` source imports。
- Root TypeScript gate 当前仍排除 `pi-mctx`；将其纳入需要先修复既有的 strict source、script 与 fixture typing，不能通过放宽 compiler options 或保留永久 exclusion 伪装为覆盖。

```text
npm run smoke:handoff --workspace=@hheei/pi-mctx -- all
```

## 依赖与发布

npm 不解析 `workspace:*`。内部依赖使用当前 lockstep 版本 `0.0.0`，npm 在 workspace install 中链接本地 package。首次发布时必须先发布 `@hheei/pi-ext-core`，再把所有内部范围同步升至可安装的发布版本。

每个声明 Pi peer contract 的 workspace 同时将四个 Pi package 固定为本地精确 dev dependency。root 不重复声明它们；公开 peer range 保持最低兼容版本。`.npmrc` 固定 `install-strategy=nested`，使这些 local development trees 保留完整版本节点，避免 npm 的 hoisted workspace lockfile 生成无法安装的空版本占位依赖。

## 验证顺序

```text
npm ci --ignore-scripts
npm run build
./test.sh
npm run check
```

Node control-plane migration 不得静默删除 Bun-host coverage；任何移除 Bun path 的变更必须另行证明 Pi binary 与 Eval runtime 的兼容契约已被替代。
