# 08：真实 TUI、恢复与防抖最终验收

**依赖：** 01–07，00 所有决策已定稿。**状态：** 自动验证通过；herdr 实机交互验收未完成，保持阻塞。

新增背景验收依赖：[12](12-native-background-blocks.md)。实现已包含收起组整体背景与组级上下 rail、整组展开透明、工具与 thinking 无自身背景；herdr 仍需核验实际背景、点击和 copy 几何。

## 交付

使用 herdr 启动真实 Pi 开发入口，走真实组件、流式事件、鼠标与 Ctrl+O；交付可检查的操作记录和帧证据，不以单测通过代替实际验证。

## 验收条件

- [ ] 普通 om notify 分类展开仅一份正文；有 body 的 notice 可展开；无假箭头。
- [ ] 隐藏 thinking 的约 20 字符预览、全文、两子项互斥；不隐藏时直接正文；多段换行、颜色正确。
- [ ] 工具分类保留 codemode/python_eval 原容器，子调用只影响统计；左侧一空格、导轨、copy 和完整错误详情可用。
- [ ] 顶层/两种容器嵌套 bash 都验证完整长命令末尾可检查；read/bash 颜色与同主题原生 Pi 对照。
- [ ] 分类/完全展开切换保持 footer；footer 后尾项不重复，组间及语义块间空白符合 00/05。
- [ ] 录制连续帧覆盖流式 thinking、partial 工具结果、并行乱序结束、notify 插入、usage 更新、agent_end。纯数值/状态更新不重挂载、不重置展开、不反复改变归属；真实新内容增长不计作抖动失败。
- [ ] resume、reload、fork、取消、新回合、未知 renderer/图片回退、分组禁用与清理均保留内容且无重复；运行态状态不泄漏到其他 session。
- [ ] 30/80/120 列自动测试通过；herdr 至少 80/120 列现场验证，包含真实点击坐标、Ctrl+O、copy 和主题切换。
- [ ] 记录操作、预期、实际、截图/日志路径、版本与未验证项；失败逐项回挂对应票，不以截图缺失或环境不可用标通过。
- [ ] 临时调试日志/测试会话资源清理；git diff 确认没有 unrelated 改动。未授权不发布。

## 验证命令与范围

- pnpm run verify:changed：格式与受影响验证及 Graphify 更新。
- pnpm exec vitest run -c vitest.integration.config.ts packages/pi-ext-ui/test-integration/host-transcript-patch.test.ts。
- 若实际跨包公共契约/类型有改动：pnpm run typecheck，并执行受影响包测试。
- pnpm run check 仅在影响范围无法界定或另获完整门禁要求时执行；未执行必须明确写出。

实际运行的开发入口按仓库当前脚本确认后记录，不把手工构造组件截图当作真实 session 验收。

## 2026-10-30 smoke（herdr + 本地确定性 provider）

入口：`pnpm run pi-dev --extension <tmp>/extension.mjs --provider ui-acceptance --model render-audit`，在 herdr 相邻 pane 中运行真实 TUI；provider 是本地 SSE 脚本，固定产出 3 段工具调用、8 段 thinking 和 4 条 notify，因此帧可复现。

| 检查 | 预期 | 实际 |
| --- | --- | --- |
| 收起帧结构 | header、组级上 rail、分类、组级下 rail（在 footer 上方）、`requests ×N · IN … · OUT … · CH …`、底色 padding 行 | 一致：`▸ collapse views · 11s · 6 calls` / 上 rail / notice、thinking、tools / 下 rail / `requests ×4 · IN 2.2k · OUT 406 · CH 46.2%` |
| 底色范围 | 上下各一行 padding 也带底色；组前空行与相邻块间空行不着色 | 一致：`frame-collapsed.ansi` 有 12 行含 `48;2;` 背景，首行是 header 上方的 padding 行，末行是 footer 下方的 padding 行 |
| 整组展开（Ctrl+O） | 外层透明、无组级 rail，成员保留自己的样式 | 一致：`frame-expanded.ansi` 中 `48;2;` 出现 0 次；切回收起后底色恢复 |
| 尾项 | 组外最后可见单元与组之间恰好一个空行 | 一致：footer 下 padding 行、空行、再 `AUDIT_COMPLETE` 正文 |

证据文件：`/tmp/hepi-ui-smoke-1793291642854/frame-collapsed.ansi`、`frame-expanded.ansi`、`frame-collapsed.txt`、`frame-expanded.txt`。未覆盖：分类/单项点击坐标、copy、主题切换与 30 列现场对照（CLI 无鼠标注入）；这些仍由单测与集成测试覆盖，本票保持未完成。
