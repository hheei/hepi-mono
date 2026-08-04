# pi-ext bridge

## 目标

本仓库将 `can1357/oh-my-pi` 的 Rust crates 作为固定 revision 的 vendored
实现，使用 HEPI-owned `pi-ext-bridge` 作为 N-API 边界。Pi extension 只依赖
bridge 暴露的 JavaScript contract，不直接把 upstream Rust API 当成公共契约。

## Shell 边界

```text
Pi host -> pi-ext-tools TypeScript adapter -> native loader -> pi-ext-bridge
                                                           -> pi-shell
                                                           -> brush + patched uu builtins
```

Pi host 加载 `pi-ext-tools`；`pi-ext-tools` 的 TypeScript adapter 将 Pi 的
`AbortSignal` 映射为 bridge 的 `abort()`，但不把 upstream Rust 类型暴露给 Pi。
`pi-ext-bridge` 是唯一 N-API 边界，拥有 callback backpressure、错误映射与 native
shell handle。vendored `pi-shell` 是 Brush-based shell 与 in-process builtin owner；
它通过 `pi-uutils-ctx` 为每次 builtin 调用安装 thread-local stdin/stdout/stderr、cwd、
环境变量和取消状态。

`pi-shell` 提供 upstream 精选的 builtin，而不是全部 uutils：包括 `grep`/`rg`、
`find`、`ls`、`cat`、`head`、`tail`、`sort`、`uniq`、`sed`、`jq`、hash 工具和文件
操作等；`cp`、`chmod`、`chown`、`kill` 不在这个 builtin 集合中。未注册命令遵从
Brush 的普通外部命令解析，不是 bridge 的额外兼容承诺。

bridge 只公开 session-scoped `Shell`：

```ts
new Shell({ sessionEnv?, snapshotPath? })
shell.run({ command, cwd?, env?, timeoutMs? }, onChunk?)
shell.abort()
shell.liveBackgroundJobCount()
```

`run()` 返回 exit code、cancelled、timedOut 和结束后的 working directory；`onChunk`
按到达顺序收到合并的 stdout/stderr 文本。每个 Pi session 拥有自己的 Shell，session
结束时必须调用 `abort()`；background job 仍存活时由具体 extension 决定是否保留
该 handle。bridge 使用有界 Rust→JavaScript 队列，慢 JavaScript consumer 会反压子进程
而非无界累积输出。

bridge 也提供 `run_mpatch`：它只调用 `pi-ext-tools` 传入的 package-owned mpatch
executable，不复制或编译 mpatch source。V4A parser、workspace boundary、staging、
hash revalidation 与 fuzzy policy 仍归 `pi-ext-tools` 所有。

Shell 是 Brush-based Bash 风格解释器，不是系统 `/bin/bash` 的字节级替代；需要
精确 Bash 兼容的调用必须继续明确启动系统 shell。

## Upstream 同步

- Repository: `https://github.com/can1357/oh-my-pi`
- Revision: `01c1f91ff529c6af3fc27724a8ba429d83d41aed`
- Source root: `crates/vendor/`
- Upstream workspace metadata 保留在 `crates/Cargo.toml`；workspace members 已重定位到 vendored paths。
- 更新 upstream 后必须运行 `cargo metadata --manifest-path crates/Cargo.toml`、bridge tests 和目标平台 build，并检查 NOTICE/license 变化。

## 发布边界

Rust 只在 release CI 编译。使用者安装 Pi package 时取得预编译的 N-API
`.node`，不执行 `cargo build`。平台 binary 的选择、版本 sentinel 和缺失时的
fallback 由 JavaScript loader 负责。
