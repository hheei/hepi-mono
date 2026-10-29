# 00：尾部、统计、成组与展示契约（已确认）

**状态：** 用户已回复“按推荐全部执行”；设计定稿，后续实现与验收在 04/05/07/09/12/08。

## 已确认控制流与 ownership

1. Pi 原始 transcript 保持不变；ext-ui 在既有投影 seam 中决定组内成员与唯一组外尾项，不新增 host hook、不修改 Pi host。
2. 仅 transcript 最后一个可见顶层单元留组外，保留原组件的 Level 0 与原交互（容器保留自己的看板）。尾项可为工具、thinking run 或 notice；工具 call/result 是同一单元。空 assistant/toolCall 占位不成为尾项。
3. 新可见内容使旧尾项一次性归组；正文/user/图片/未知 renderer 等既有边界保留。agent_end、取消、resize、主题或纯状态/usage 更新不单独吞入尾项。并行工具按开始/原始 transcript 顺序，不按完成顺序重排。
4. 没有组则不产生孤立 footer；组后尾项间恰好一个空行。历史 block 不各自留尾项；resume/fork/reload 按当前 transcript 确定性重建，运行态时钟/展开不新增持久化。

## 统计与成组

- 同一连续 block 用 `notice / 2 + thinking / 2 + tools >= 2` 判定成组，不取整；包含该 block 的组外尾项的权重。tools 是有效可聚合顶层组件数，容器子调用不增加门槛；thinking 按非空连续 run，空占位不计。
- header calls、footer requests/IN/OUT/CH 都包含同 block 组外尾项的事实；分类只列组内项。迁移只改变展示归属，不重复统计。calls 仅在工具有最终结果时增加，真实执行失败照常计数。
- footer 始终 `requests ×N · IN … · OUT … · CH …`，只有一个统计 footer，不切回工具状态行。requests 与 usage 来自同一请求集合，IN=sum(input)、OUT=sum(output)，不把 cacheRead/cacheWrite 加入 IN；partial/final 按请求身份替换，不重复累加。正文/异常请求的真实 usage 也必须归属，不能因正文不参与聚合而丢失。
- CH 取 block 最后一个测量到非零 prompt 的 usage；streaming 的零占位不覆盖它。未知与真实 0 分开显示。每个 block 从首次可观测成员开始独立计时，在 transcript 边界或 agent_end 冻结；未知历史时钟不伪造。

## thinking 粒度

连续 thinking block 组成一个 run，以空行保留段落；中间有工具/正文等不同内容则分成不同 run。分类项、预览、全文、成组权重使用同一粒度与稳定身份。隐藏时可预览/展开，显示时直接全文，不修改 host 的偏好。

## 07：完整请求

- 顶层和嵌套请求 copy 保留原始字节；展示只剥离不可信请求的终端控制序列，不清除 theme 生成的合法样式。provider 拥有 copy 的请求/结果边界，UI 不再清洗整段 payload。
- 实时优先使用已捕获 args；恢复时通过公开 sessionManager 只读 Pi host 已保存的 nestedCalls。不能通过渲染器未提供字段就读取更多 host 私有属性。
- 不新增请求持久化；host 保存上限内才能恢复。缺失/截断时明确提示，不能把摘要/有界预览冒充完整请求，copy 不复制伪完整命令。session 切换清理，reload/fork 从当前分支重建，不能读到其他分支的调用。
- python_eval 嵌套增加真实检查/复制入口；原容器仍拥有看板，不在组层重画。超过正文展示上限时提示实际完整入口/copy。

## 09：解析事实

用户批准必要的公共数据契约扩展：由调用提供者在真实工具解析边界记录是否成功解析，并随调用事实保存/传递。真实失败仍计数，未知调用不计有效 calls，但保留完整错误。childCount 反映有效子调用总数，预览裁剪不改变总数；全未知是 0，真正无子调用才父计 1。

不允许按错误文案、大小写猜测或恢复时的当前工具清单推断历史。旧记录缺解析事实必须标未知，不伪造。若上游不给真实解析 seam，记录证据与不可达范围，不增加 host monkey patch 绕过批准范围。

## 12：背景

收起组使用原生 Box/语义背景覆盖 header、分类摘要、footer，并在 header 下、footer 上各画一条组级横向 rail；局部展开分类保留组底色。整组展开外层透明、无组级 rail；工具与 thinking 不填自身背景，notice 保留自身 customMessageBg。复用原生 Box，避免与 ToolView outputPad 双重 padding；组前/语义块间空行不着色，保留鼠标/copy/链接的真实几何。

## 状态示例

| 输入/变化 | 组内 | 组外尾 | 统计 |
| --- | --- | --- | --- |
| tool A → tool B | A | B | 包含 A/B；未完成不计 calls |
| A/B 并行完成顺序反转 | A | B | 只更新状态/事实，尾项不重排 |
| agent_end | 不变 | B | 时钟冻结，尾项不归组 |
| 后来正文出现 | A/B | 正文（原生） | block usage 含对应请求，不借下一请求 |
| 4 notice | 前 3 notice | 第 4 notice | 满足加权成组，0 tool calls |
| 新回合新内容 | 历史尾项按原顺序归属 | 新最后可见单元 | 新 run/block 不污染历史 usage |

## 验证

实现前同步 DESIGN/architecture；聚焦单测覆盖流式帧、稳定身份、并行、边界、恢复、主题、30/80/120 列。公共契约变化运行全仓 typecheck 和受影响测试；host 投影/真实执行路径补 integration。08 最终使用 herdr 至少80/120列记录真实 Pi、鼠标/Ctrl+O/copy/主题/取消/恢复证据，不以单测替代实机验收。未提交/推送/发布。
