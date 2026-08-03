# pi-native bridge

## 目标

本仓库将 `can1357/oh-my-pi` 的 Rust crates 作为固定 revision 的 vendored
实现，使用 HEPI-owned `pi-native-bridge` 作为 N-API 边界。Pi extension 只依赖
bridge 暴露的 JavaScript contract，不直接把 upstream Rust API 当成公共契约。

## 当前边界

```text
packages/pi-* -> native loader -> pi-native-bridge -> vendor/oh-my-pi/crates
                                                     |- pi-natives
                                                     |- pi-shell
                                                     `- required vendor crates
```

当前只建立 workspace、source snapshot 和 bridge 骨架；尚未把 shell、grep 或
其他 native 函数注册为产品工具。bridge 也提供 `run_mpatch`：它只调用
`pi-ext-tools` 传入的 package-owned mpatch executable，不复制或编译 mpatch
source。V4A parser、workspace boundary、staging、hash revalidation 与 fuzzy
policy 仍归 `pi-ext-tools` 所有。后续每个导出函数必须明确参数验证、错误映射、
取消、资源清理和对应的 focused test。

## Upstream 同步

- Repository: `https://github.com/can1357/oh-my-pi`
- Revision: `01c1f91ff529c6af3fc27724a8ba429d83d41aed`
- Source root: `vendor/oh-my-pi/`
- Upstream workspace metadata 保留在 root `Cargo.toml`；workspace members 已重定位到 vendored paths。
- 更新 upstream 后必须运行 `cargo metadata`、bridge tests 和目标平台 build，并检查 NOTICE/license 变化。

## 发布边界

Rust 只在 release CI 编译。使用者安装 Pi package 时取得预编译的 N-API
`.node`，不执行 `cargo build`。平台 binary 的选择、版本 sentinel 和缺失时的
fallback 由 JavaScript loader 负责。
