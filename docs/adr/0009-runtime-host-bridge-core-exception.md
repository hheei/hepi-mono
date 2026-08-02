# Runtime host bridge 作为 core 受限例外

`@hheei/pi-ext-core` 获准在尚无具体实现 consumer 的阶段提供 Runtime host bridge contract。该例外只服务
Editor surface 与 HEPI-managed tool surface：它不修改 Pi 源码，以 Pi `0.83.x` runtime shape probe 和可恢复
private wrapper 获取 host geometry/lifecycle；probe、late attach 或 patch ownership 任一不完整时 fail-closed 并保留
Pi 原行为。

## 考虑过的方案

- 只等两个具体 feature 实现后再提升 bridge 到 core。
- 让每个 feature 自行访问 Pi private runtime。
- 修改或 fork Pi 源码以添加正式 host hook。

## 后果

bridge 在 core 内集中维护 private compatibility 风险，但不能扩张为 Pi private API facade、generic component tree、
assistant/native-tool selection、clipboard policy 或 renderer text inference。feature 只能通过根入口 capability 获取
Host surface，并继续拥有 selection/copy 行为。
