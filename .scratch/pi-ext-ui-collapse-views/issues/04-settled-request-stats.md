# 04: 完成或被打断 block 的原生口径请求统计

**Spec:** [连续活动组 Spec](../../../docs/architecture/pi-ext-ui-tool-groups.md)；D6–D8、D10；用户故事 19–25。

**What to build:** block 完成或遇真实原生边界后，footer 槽位（最后一条 rail 下）由 `Requests ×N · IN … · OUT … · CH …` 覆盖尾行工具状态；header 与 body 不变。下一 block 局部统计重新开始、run 时间连续；统计沿用原生 footer 公式和 k/M 格式，同一请求横跨 block 也只归账一次。

**Blocked by:** 01：连续工具 block 与不重置的回合时钟

**Status:** done — 已实现并通过聚焦验证；缺口见下。

## Delivered

- 完成或被原生边界打断的 block 保持 header（`collapse views · 用时 · N calls`）、两条 rails 与三类列表不变；最后一条 rail 下的单一 footer 槽位由 `Requests ×N · IN … · OUT … · CH …` 覆盖运行态的尾行工具状态，不追加 rail。
- Requests 计所属 assistant 逻辑请求；IN/OUT 只累加 assistant usage 的 input/output；CH 取最后一条 assistant 的 `cacheRead/(input+cacheRead+cacheWrite)`。
- IN/OUT 使用与原生 footer 完全一致的十进制 k/M 阈值，`formatTokens` 对照 999/1000/9999/10000/999999/1000000/9999999/10000000 全部一致。
- 缺失 usage 显示 `—`，不把未知当零；迟到 usage 会更新其所属 block，因为统计从当前节点重建。

## Known gap

- 带 usage 的 toolResult、branch_summary、compaction 记录会断开活动组，因此不计入任何 block。


## Acceptance criteria

- [x] 完成或被打断 block 的 header 与 body 不变，footer 槽位覆盖尾行；原生打断内容位置不变，仍可检查保存输出。
- [x] Requests 计所属 assistant 逻辑请求，不逐工具、usage entry 或 HTTP retry 计；正常、错误、取消请求按身份各一次。
- [x] IN 累计 usage.input，不含缓存；OUT 累计 usage.output，不另加 Thinking 估算。统计集合只限该 block，不复制整 session/run 累计。
- [x] 独立 usage、assistant、带 usage 的 toolResult 与 branch_summary/compaction 依原生 entry 语义计一次；压缩前已归属 usage 不丢失，无可靠归属时不猜测分摊。
- [x] CH 取原始顺序最后 assistant 的 cacheRead/(input+cacheRead+cacheWrite)，不是加权平均；其他 usage 不覆盖 latest assistant。
- [x] 最后 assistant 零输入、无原生显示条件或未知数据时 CH —；最多一位小数且去掉 .0，不伪造 0%。
- [x] IN/OUT 精确匹配原生十进制 k/M 各阈值和舍入；测试 999、1000、9999、10000、999999、1000000、9999999、10000000。
- [x] 同一请求首次关联 block 后只归账该 owner；跨边界和迟到 usage 更新原 owner，不移到账前 block、不按回调顺序选 latest CH。
- [x] 未结算或缺失 usage 明确未知；已知错误/取消消耗保留，message_update 完整快照不重复累加。
- [x] 通过真实投影及原生 footer 对照 fixture 验证从活动到完成、被打断、晚到 usage 和再次活动的完整可见路径。

## Verification

改动 Biome、受影响统计/host 投影测试及 UI package build；真实 CLI 覆盖完成/打断路径。按实际跨包/公共导出变动决定根 typecheck，不为格式化私自 deep-import host footer。代码后更新 Graphify AST。

## Boundaries

不新增网络 hook、HTTP attempts 推断、通用 usage 服务或 timing/归账磁盘持久化。格式化优先现有公共能力，不可用时局部等价实现并对照原生。
