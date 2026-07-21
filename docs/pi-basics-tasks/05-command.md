# 05｜`/hepi` dispatcher

## 目标

实现唯一根命令 `/hepi`，让第一版 `setting` 路由到 Settings module，并为未来 module 保留同一 dispatcher 的扩展方式。

## 行为契约

- `pi.registerCommand("hepi", ...)` 只注册一次。
- `/hepi setting` 打开 Settings module。
- `/hepi setting <provider-id>` 第一版可解析并保留参数，但可以暂不跳转；必须有明确行为说明，不能假装已支持。
- `/hepi`、未知 subcommand、参数错误必须给清楚提示。
- JSON/print/non-TUI mode 不得建立 terminal component；返回可读错误或通知。
- 不注册 `/hepi-setting`、`/hepi-settings` 等平行命令。
- 既有 `/loadout` 和其他 extension command 不在此 dispatcher 中接入。

## 实现步骤

1. 在 `command-types.ts` 定义 command/module context，不把 storage 逻辑塞进 command。
2. 实现参数 trim、subcommand 解析和未知命令错误；保留原始 args 供 module handler 使用。
3. 让 dispatcher 从 runtime registry 查询 module，按 `commands` 路由并处理 collision/缺失 module。
4. 在 Settings module 上实现 `open(args, ctx)`，由它检查自身 TUI 能力；dispatcher 只负责路由。
5. 在 `src/index.ts` 保证 command 注册幂等且 runtime 与当前 session 绑定。
6. 添加 Pi integration-level fake tests：注册 command、TUI guard、setting 路由；不要复制 Pi interactive loop。
7. 更新 `scripts/pi-dev.mjs` 的 `basics`/`pi-basics` alias 和 usage，但不要改变默认既有 extension 行为。

## 验收

- [ ] TUI mode 下 `/hepi setting` 能进入 Settings component。
- [ ] JSON/print mode 下不会创建 component，不会写 stdout。
- [ ] 未知命令和空 args 都有稳定提示。
- [ ] command 只注册一次，重复初始化不会重复 handler。
- [ ] `bun run pi:dev -- basics` 能加载 package；手动流程记录在 package README。

## 非目标

不实现 future command handler，不修改既有 command，不负责 provider save。
