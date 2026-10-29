# pi-subagents 范围与实施路线

本文记录 V1 的用户目标、明确不做、完成定义与实施顺序。运行时合同在 [spec.md](spec.md)；
已发布行为以 package README、源码与测试为准；设计历史在 [archive/](archive/)。

## 用户目标

提供一个独立安装的 `@hheei/pi-subagents` concrete extension，使主 Pi 能够：

- 创建多个拥有独立 Pi session 的 child，默认在 Herdr 或 cmux 的 panel 里运行它们的原生 Pi TUI；
- 查看、发送消息和停止 child（没有 host 时 child 运行在无终端的 headless RPC 模式）；
- 接收 child 主动发给 parent 的进度、发现、决策请求和阻塞信息；
- child 的 panel 被关闭或 idle 回收后保留同一 session 与身份，后续 send 用同一 session 拉起新 runtime，不重放中断的 turn；
- parent reload/restart 后重连仍存活的 child，并清理确认已结束的 runtime；
- 重新打开这个父会话时，在 `before_agent_start` 之前回到该会话本来的 subagent 账本，而不是等模型去开 panel（§7.7）。

V1 不是 workflow engine、scheduler、任务 DAG 或自制 multi-agent UI。

## 明确不做

V1不包含：

- nested/recursive subagents、batch spawn或workflow API；
- scheduler、mission、council、review loop或task DAG；
- 自动worktree管理、cost-based interruption或通用budget engine；
- custom transcript/TUI/renderer、terminal scraping或token streaming relay；
- activity sidecar、session JSONL 轮询或基于缺文件的 stall ping；
- 因 idle 回收或 `intent=stop` 自动打开 panel，或自动重放中断任务和未确认消息；宿主重启回灌只拉回当时仍有 attachment 的 panel（§7.7），不是模型工具；
- 阻止用户直接原生`/resume`同一session；
- durable event ledger、process history、handoff history或通用cross-extension message bus；
- 未定义语义的agent字段和兼容旧HEPI/subagent实现的shim。

## 完成定义

V1完成必须满足：

1. 多个child可并行后台运行，parent可spawn、inspect、send、接收report和stop。
2. child对话由真实Pi session持久化，首次落盘、损坏、丢失和断线路径不会生成错误的新身份或静默重放。
3. parent reload/restart 优先 adopt 仍持有进程锁的 child；进程锁 + registry runtime identity 保证受管理路径不会出现第二个受管 runtime。
4. Herdr/cmux panel 里运行 child 的原生 Pi TUI；panel close、进程崩溃、idle 回收和 session switch 都符合本规格（身份与 session 保留，不重放中断的 turn）。重新打开父会话时，§7.7 的账本在 `before_agent_start` 前恢复。
5. 失败、取消、stop与handoff race均在有限deadline内可见结束，不死锁transition queue。
6. effective model/provider/resources和host选择可观察，无静默routing。
7. focused tests覆盖[`tickets.md`](../archive/pi-subagents/tickets.md)各ticket的验收；受影响文件通过Biome、typecheck及对应Vitest。
8. package README、architecture/ADR、`SPEC.md`和实际public contract一致，不包含过时兼容路径。

## 实施顺序

```text
SUB-01 package + contracts + agent resolver
  -> SUB-02 registry + launch/session bootstrap
  -> SUB-03 reconnectable runner + RPC adapter
  -> SUB-04 parent/child channel + core tools
  -> SUB-05 stop/status/usage hardening
  -> SUB-06 recovery + replacement claims
  -> SUB-07 HostAdapters
  -> SUB-08 safe attach
  -> SUB-09 detach/session-switch/interruption
  -> SUB-10 minimal UX + end-to-end release gate
```

SUB-01至SUB-05形成第一个可运行的RPC闭环。SUB-06完成持久恢复后，才开始TUI handoff；不得提前制作dashboard。

**取代关系（2026-10-01）**：SUB-08/SUB-09 的 attach/detach 与 SUB-06 的 replacement claim 已被
[`PLAN-panel-bridge.md`](../archive/pi-subagents/PLAN-panel-bridge.md) 取代。已落地的替代实现：

```text
Stage 1  bridge 控制面（parent 侧 server、child 侧 client + 请求分发、协议收窄）✅
Stage 2  传输从 runner 切到 bridge（parent 直接 spawn 后台 child；删除 runner/connector/rpc-adapter/
         pause-gate、attach/detach、claim、#frozen）✅
Stage 3  panel 默认呈现（HostAdapter.open + 聚焦观察 + agents_delegate 默认 panel）✅
Stage 4  panel 生命周期（stop 关 panel、聚焦暂停 idle 回收、runtime 消失时释放 panel）✅
Stage 5  文档与 ticket 收口（本文件、README、tickets、architecture、DESIGN）⏳
```

§7.7 的实施顺序：

```text
SUB-12  会话租约的 commit，只写 intent 与 attachment
  -> SUB-13  父边界 open/ready，含重开 Herdr 的回灌
  -> SUB-14  子边界 commit（leave / cancel / 单 panel 关闭）
```
