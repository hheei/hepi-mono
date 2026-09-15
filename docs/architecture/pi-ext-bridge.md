# pi-ext bridge

## 目标与能力

`pi-ext-bridge` 是 HEPI-owned N-API boundary。Pi extension 只依赖它公开的
JavaScript contract，不直接暴露 vendored Rust API。

bridge 目前提供两项彼此独立的原生能力：一次性的、可取消的 vendored `mpatch`
调用，以及基于 `portable-pty` 的 session-owned `PtySession`。它不嵌入 Brush、uutils
或任何 shell；PTY 只启动调用方提供的 command、args、cwd、env 与终端尺寸。

## mpatch 边界

`apply_patch` 的单次 mpatch 调用使用 bridge 提供的 `MpatchRun` handle：

```ts
const run = new MpatchRun({ cwd, unifiedDiff, fuzzFactor, dryRun })
await run.run()
await run.abort()
```

`pi-ext-tools` 把 Pi 的 `AbortSignal` 映射为 `abort()`，并在调用结束后解除 listener；它仍拥有
V4A parser、workspace path validation、staging、baseline hash revalidation 与 fuzzy policy。
`pi-ext-bridge` 拥有一次性 Rust mpatch run handle 与 cancellation flag；vendored mpatch 在文件循环、
fuzzy scoring 和写入前协作检查该 flag。所有写入仅发生在 `pi-ext-tools` 创建的 staging 目录。

## PTY 边界

`PtySession` 由 `pi-ext-tools` 的交互式 Bash surface 使用。每个 session 独占一个
原生 child、reader、writer 与 terminal size；其 JavaScript contract 为 `read()`、
`write()`、`resize()`、`close()` 与 `wait()`。`read()` 返回原始字节和 EOF，调用方必须
串行读取，并负责在 teardown 时 `close()` 后 `wait()` 回收 child；UI、输入转发与输出保留
仍由 TypeScript 调用方负责。

`close()` 可重复调用。它会终止该 session 的 child（Unix 上也向其 process group 发出
终止信号），关闭输入并释放 PTY master，以解除等待中的 native read；wrapper 被丢弃时也会
执行相同清理。它不会影响其他 session。

## Upstream 同步

mpatch 来源为 `https://github.com/Romelium/mpatch` 的 `v1.6.4`；只保留 crate 的构建清单、
MIT license 与 library source。同步时重放本地 cancellation patch，再运行 mpatch cancellation tests
与 native build。

## 发布与本地构建边界

发行包必须包含预编译的 `native/pi-ext-tools-bridge.node`；安装 package 不执行 `cargo build`。
在 source checkout 中，开发者须运行 `pnpm --filter @hheei/pi-ext-tools run build:native` 生成当前
host 的该文件；它使用 stable Rust 与 Cargo 的增量 `local` profile，且不会提交。JavaScript loader
只加载这个固定路径的模块，并在它缺失或不符合 bridge contract 时抛错；平台产物的构建与打包属于
release 流程，而非 loader 的运行时选择。
