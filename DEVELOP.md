# 开发与验证

本仓库使用 Bun。先在每个 worktree 根目录安装依赖：

```bash
bun install
```

不要使用 npm、Yarn 或 pnpm，也不要提交其他 lockfile。

## 日常开发

修改前先定位所属 `packages/pi-*/` 包及其 focused test。优先运行最小检查：

```bash
# 单个测试文件
bun test packages/pi-ext-core/test/subagents.test.ts

# 改动的 TypeScript 文件
bunx biome check --write packages/pi-ext-core/src/subagents.ts

# 单个包的类型检查
bunx tsc -p packages/pi-ext-core/tsconfig.build.json --noEmit
```

普通局部改动不需要运行全仓库检查。改动共享 API、Pi 依赖或包边界时，
再运行：

```bash
bun run typecheck
bun test <affected-test-path>
```

Pi 包的基础 `tsconfig` 默认 `noEmit`。需要手动更新某个包的 `dist` 时使用：

```bash
cd packages/pi-ext-core
bun run build -- --noEmit false
```

日常本地 Pi 启动应使用 `scripts/pi-dev`，不需要手动构建 `dist`。

## Worktree Pi 开发

```bash
# 启动当前 worktree 的全部本地 pi-* 包
bun scripts/pi-dev

# 仅加载待测组合
PI_DEV_PACKAGES=pi-auto-title,pi-subagents bun scripts/pi-dev
```

`pi-dev` 将 session、settings 和包配置隔离在 `<worktree>/.pi-dev/agent/`。首次运行会将
该目录的空 `auth.json`、`models.json` 链接到当前 Pi 的
`~/.pi/agent/auth.json`、`~/.pi/agent/models.json`，不复制密钥。默认模型为
`cx/gpt-5.6-luna`，thinking 为 `low`。

启动器不会继承 `OPENAI_API_KEY`，避免旧 OpenAI 凭证覆盖默认 `cx` 认证。使用 OpenAI
必须在 Pi 命令中显式选择 provider 并提供认证；不要把密钥写进 worktree 文件。

### 构建缓存

首次运行会 build 所选包并生成 `dist`。随后源码与构建配置不变时，启动器从
`.pi-dev/agent/build.json` 命中缓存并跳过 build。下列变化会自动失效缓存：

- 已选包的 `src/**/*.ts`、`package.json`、`tsconfig.json` 或 `tsconfig.build.json`
- 根目录 `bun.lock` 或 `tsconfig.base.json`
- 任一已选包的 `dist/` 缺失

要强制重建，删除缓存文件：

```bash
rm .pi-dev/agent/build.json
```

## Live Smoke

单元测试不能证明 Pi 真实 extension lifecycle、模型注册或凭证读取有效。改动 extension
注册、lifecycle、provider、subagent 或 TUI 后，至少执行与改动范围匹配的 smoke。

```bash
# 只检查隔离配置能解析默认模型，不输出 API key
bun scripts/pi-dev --list-models cx/gpt-5.6-luna

# 检查 cx 认证存在，不输出 API key
bun scripts/pi-dev auth print-api-key --provider cx --model gpt-5.6-luna >/dev/null \
  && echo "cx auth ready"

# 真实父 Agent 请求，不加载扩展；会消耗一次模型调用
bun scripts/pi-dev --no-extensions --no-session --print "Reply only: ok"

# 加载全部本地 pi-* extension 的真实 host smoke；会消耗一次模型调用
bun scripts/pi-dev --print "Reply only: ok"
```

需要验证指定 extension 组合时，使用 `PI_DEV_PACKAGES` 重跑最后一条。检查输出中是否有
extension error、重复注册、lifecycle collision 或 provider/authentication error。TUI 可见
行为还必须在实际 Pi host 或 `tui:replay` 中检查，不能仅凭 source inspection 或 unit test。

## 完成前

```bash
git diff --check
git status --short
```

只提交本次功能涉及的文件，保留其他 worktree 的未提交用户改动。独立完成的 cohesive
变更应在 focused verification 后单独提交。
