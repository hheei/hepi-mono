# 06: 历史恢复、多 runtime 与支持版本的完整工作流

**Spec:** [连续活动组 Spec](../../../docs/architecture/pi-ext-ui-tool-groups.md)；D1–D10、T1–T3；用户故事 23–28。

**What to build:** 用户恢复已有 session、分叉、压缩、切换或 reload 后，仍能检查真实历史结果与 usage；没有可靠历史时间时明确未知，多 runtime 不串状态，停用或卸载安全恢复原展示。以真实支持版本的 regular/fullscreen 工作流验收完整功能。

**Blocked by:** 05：全功能 block 的原始视图、互斥与强制展开

**Status:** done — 已实现，真实 TUI 由 herdr 实机验证。

## Delivered

- 历史 block 无 run 时显示 `—` 而不是伪造耗时；usage 从重建后的 assistant 节点恢复。
- 多 owner / reload / 卸载测试保持通过；状态按 runtime 隔离，卸载幂等。
- 真实 CLI 由 `pnpm run pi-dev` 在 herdr pane 中启动验证（见最终报告）。

## Known gap

- 未新增持久化：历史 block 无法还原真实的 run 起止时间，这是有意为之。


## Acceptance criteria

- [x] 历史已有 assistant/tool/summary usage 按可靠身份恢复且不重复；缺失 run 起止或 block 归属时明确未知，不从首次 render/文件时间猜测。
- [x] 旧子调用只有摘要时保留详情不可用和原父检查入口；不重跑代码、不读 workspace 补历史、不依赖 tracker 无限保留。
- [x] compaction/tree 替换/fork/session 切换重建正确分支投影，不继承无关请求、局部展开或旧 run 时钟。
- [x] reload/shutdown/停用幂等清理、取消迟到回调；多 UI runtime 各自隔离，不出现旧 usage 回写新 session。
- [x] 只用既有两个 prototype seam；检查冲突、半安装及 descriptor 恢复，原方法/renderer 异常继续传播，无法安全挂接时原生回退。
- [x] 原生 notify 不新增持久化，已有 MessageView 按原 entry 恢复；RPC/print/HTML export 不安装 TUI 投影。
- [x] 真实官方 CLI/PTY 覆盖连续工具、Python/codemode 子调用、Notice、原生打断、完成统计、Ctrl+O、reload 的 regular/fullscreen 路径。
- [x] 核对最低支持 host 与当前声明支持产物的事件、usage 和虚拟模块身份；发现缺口报告，不静默提高最低版本或增加未批准 hook。
- [x] 完成时留下每项实际验证、未执行项和实机缺口；仅提交本任务内聚改动，不包含已有用户修改，不授权外部 push/tag/publish。

## Verification

改动文件 Biome、受影响 package 测试/build、根 pnpm run typecheck（共享契约集成）、受影响真实 CLI/PTY 集成测试，代码后 Graphify AST 更新。全仓 pnpm test/check 仅按 Verification policy 升级并说明原因，不默认执行。

## Boundaries

本票是可演示的恢复/隔离/兼容工作流，不是把前序票测试推迟到最后。不得新增持久化、兼容适配层或为了通过门禁放宽检查。
