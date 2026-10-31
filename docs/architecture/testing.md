# 测试运行时

Pi 的日常开发、构建和测试控制平面使用 pnpm、Node 22.19+ 与 Vitest。Pi 的 npm host 是 Node，因此默认测试必须在 Node 中执行。仓库开发工具链与用户侧 `pi install npm:@hheei/...` 无关。

```text
pnpm install --frozen-lockfile --ignore-scripts -> pnpm run build -> pnpm run check -> Vitest (Node)
```

## 运行时边界

- Vitest 使用 workspace source alias，不依赖尚未构建的 workspace `dist`。
- `test.sh` 用临时 HOME、TMPDIR 与 pnpm home 运行测试，不读取用户凭据或本地 Pi 状态。
- Bun 不是默认 test runner。它仅作为显式 compatibility runtime：Pi standalone binary、Bun-host smoke，以及产品明确要求的 Bun child runtime。

## 两个测试入口

`pnpm test`（`vitest run`）是日常套件，`vitest.config.ts` 只收集 `packages/*/test/**/*.test.ts`。`pnpm run test:integration`（`vitest run -c vitest.integration.config.ts`）单独收集 `packages/*/test-integration/**/*.test.ts`，`pnpm test` 不包含它们。

两者都不是"有没有真实进程"的分界。日常套件里仍有小规模本地子进程与内核原语：`runCommand` 的取消与超时、eval kernel 的协议与 frame、Bash 进程组停止、SQLite 进程锁探测。它们启动一个短命子进程或开一个锁文件就能验证契约，因此留在日常套件里保持快速反馈（Bash job 的大部分用例用 `vi.mock("node:child_process")` 的 spawn double，不启动真实 shell）。可选集成套件覆盖的是重活：真实 Pi CLI 启动、`/reload` 与重启、跨进程锁竞争、进程树清理、SIGKILL 后释放账本所有权。一个用例属于哪一侧取决于它需要的生命周期与成本，而不是"是否 `spawn`"。

## 确定性协调

Settings 与 Loadout 的布局测试直接调用组件的 `render(width)` 和输入方法，覆盖窄宽布局、固定行数与交互行为；人工可见验证在 Pi 中完成。仓库不再维护独立的调试扩展或 TUI replay CLI。

单元测试不得用固定 sleep 充当同步。等待某个状态时用确定性信号：

- 定时器与延迟用 `vi.useFakeTimers()` 加 `vi.advanceTimersByTimeAsync()` / `vi.advanceTimersByTime()`。断言边界值（`LIMIT - 1` 与 `LIMIT`）比断言某个毫秒数更能表达契约。
- 事件与 Promise 用 `events.once()` 或直接 `await` 返回的 Promise 等待可观察条件；需要等待某个最终状态时，写一个明确轮询该条件的 helper（带尝试次数或总时长上限），不要用固定 sleep 猜。
- 需要构造"另一个进程已死"或"锁已被占用"这类事实时，用注入的 fake 或真实但确定的前置条件，不要用 sleep 让真实时间过去。
- `afterEach` 必须把 fake timer 恢复为真实实现，并按注册逆序释放 registry、ledger 与临时目录；否则下一个用例会看到上一个用例的定时器或锁。
- 拥有独立进程和状态的真实 I/O 用例可以并行，保留真实停止宽限期。清理绑定到当前用例的 `context.onTestFinished()`，不要用共享资源数组配合 `afterEach`，以免一个用例清理另一个仍在运行的用例。

## 临时存储

SQLite 账本、mailbox 与进程锁测试优先在 Linux 的 `/dev/shm` 创建独立临时目录，避免每次初始化和事务提交都承担磁盘 fsync 的延迟。仍使用真实文件、SQLite 事务、锁和权限检查，不修改生产环境的持久化设置；目录不可用时回退到系统临时目录。调用方先关闭 mailbox、释放锁，再删除目录。需要直接执行临时文件或验证特定磁盘行为的用例使用系统临时目录，不依赖 `/dev/shm` 的挂载选项。

## 真实进程协调

集成用例只能用**显式、有界的就绪判断**，不能用固定 sleep 猜测进程已经起来或已经退出：

- 就绪用可观察事实轮询：pid 文件出现、socket/锁文件可打开、IPC 消息到达。每次轮询有上限（尝试次数或总时长），超时后失败并带上诊断，而不是无限等待。
- 等待某个进程事件用 `once(emitter, "exit")` 之类的 Promise，而不是"sleep 后检查"。需要给等待设上限时用 `AbortSignal.timeout()`，让超时本身成为失败原因。
- 用例自己创建的资源由用例自己清理：观察到的进程组、临时目录、账本文件。被测代码"不接管旧 PID"这类契约要靠用例断言旧进程仍然存活，因此清理责任留在测试里。
- 集成用例的默认超时高于日常套件（`vitest.integration.config.ts` 设 60s）；不要用提高单个用例的超时来掩盖一个没有边界的等待。

## 依赖与发布

- 内部依赖使用 `workspace:^` 别名（故意不带显式版本），由 pnpm 在 workspace 中链接本地 package，并在 `pnpm publish`/`pnpm pack` 时自动改写为该包当时的实际版本（例如 `^0.1.2`）。这样各包独立发版时不需要手工同步内部范围；只在需要收窄兼容范围时才写显式版本。`npm pack` 不会做该改写，因此发布与产物校验都必须走 pnpm。首次发布或升级时必须先发布 `@hheei/pi-ext-core`，再确认所有内部范围仍能解析到已发布版本。

每个声明 Pi peer contract 的 workspace 只把自身直接 import 的 Pi package 固定为本地精确 dev dependency：同一 package 若同时出现在 peer 与 dev 声明中则使用精确版本，未被 import 的 Pi package 不再声明（例如仅使用 `pi-coding-agent` 的 workspace 不再声明 `pi-agent-core`、`pi-ai`、`pi-tui`）。root 不重复声明它们；公开 peer range 保持最低兼容版本。pnpm 使用 isolated `node_modules`，各 workspace 的直接 devDependency 仍会出现在该包自己的 `node_modules` 中。

`pnpm-workspace.yaml` 的 `patchedDependencies` 给 `@earendil-works/pi-tui` 打上仓库维护的 TUI patch。该 patch 只包含两处宿主修复：Editor 在应用 slash 补全后重算补全列表，以及 full redraw 不再发送 `CSI 3 J`（保留终端 scrollback）。`ScrollView.updateLayout` 的 follow-end 逻辑保持上游原样：不 patch 视图位置，滚动行为不对宿主打补丁。

## 验证顺序

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
./test.sh
pnpm run check
```

日常改动先按 [AGENTS.md](../../AGENTS.md) 的 Verification policy 跑最低足够验证：`pnpm run check:changed` 与受影响的测试文件；`pnpm run verify:changed` 按受影响包自动选择检查、构建与测试。改动 `packages/*/test-integration/**` 本身、它们驱动的 CLI/锁/重启路径，或准备发布时，额外运行 `pnpm run test:integration`。全量 `pnpm run check` 只在影响范围无法可靠界定或用户明确要求时运行。

本文件不记录任何测试耗时数字：耗时随机器、负载与用例规模变化，没有测得的数值就不写。

Node control-plane migration 不得静默删除 Bun-host coverage；任何移除 Bun path 的变更必须另行证明 Pi binary 与 Eval runtime 的兼容契约已被替代。
