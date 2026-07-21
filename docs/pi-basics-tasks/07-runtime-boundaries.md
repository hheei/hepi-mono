# 07｜Runtime、lifecycle 与 module 边界

## 目标

确保 registry 只是 registration/lifecycle 协调层，不变成共享 mutable domain store；为未来 module 和 contribution 留下窄边界。

## Registry 只能负责

- module/provider registration。
- id collision 检查。
- deterministic ordering。
- 根 command 查询可用 module。
- session lifecycle callback 注册和清理。

## Registry 不得负责

- 任何 module 的实际 state。
- settings 文件格式和 merge 细节。
- UI render。
- 其他 module fallback 行为。

## Context 与 lifecycle

1. `session_start` 创建当前 session runtime/context，初始化需要的 provider/module。
2. 所有 watcher、timer、socket、child process 只能在 `session_start` 启动。
3. `session_shutdown` 按固定顺序清理资源；重复 shutdown 必须安全。
4. 清理失败要被记录/转换为可读错误，不得阻塞其他资源清理。
5. 不把 session state 放 module-level global；若使用 module-level registry 作为加载桥，里面只能存 registration metadata。

## Future boundary

未来 module 建议位置：`src/modules/<name>`，由同一 dispatcher 注册自己的 handler，并拥有自己的 state/test。预留但第一版不实现：`continue`、`goal`、`advisor`、`plan`、`btw`、`todo`、`snapcompact`、`loadout`。

未来 contribution 建议位置：`src/contributions/editor`、`src/contributions/footer`。`setFooter()`、`setEditorComponent()` 属于全局插槽，必须由 runtime/contribution 层协调；第一版不得接管 Pi editor/footer。

## 验收

- [ ] session A/B 的 provider state 不互相污染。
- [ ] lifecycle callback 注册、调用顺序、清理和重复调用有测试。
- [ ] watcher/timer 等资源都有 owner 和 cleanup。
- [ ] 未实现 future module 没有空壳 command。
- [ ] contribution API 明确是边界，不偷偷改变 Pi 全局 UI。
