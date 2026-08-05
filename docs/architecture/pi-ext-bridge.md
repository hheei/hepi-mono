# pi-ext bridge

## 目标

`pi-ext-bridge` 是 HEPI-owned N-API boundary。Pi extension 只依赖它公开的
JavaScript contract，不直接暴露 vendored Rust API。

bridge 当前仅提供 cancellable `mpatch` execution。Pi host 的 `bash` 保持原始 backend；
bridge 不提供 Shell、Brush 或 PTY contract。

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

## Upstream 同步

mpatch 来源为 `https://github.com/Romelium/mpatch` 的 `v1.6.4`；只保留 crate 的构建清单、
MIT license 与 library source。同步时重放本地 cancellation patch，再运行 mpatch cancellation tests
与 native build。

## 发布边界

Rust 只在 release CI 编译。使用者安装 Pi package 时取得预编译 N-API `.node`；不执行
`cargo build`。平台 binary 的选择、version sentinel 与缺失处理由 JavaScript loader 负责。
