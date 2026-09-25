# pi-ext-memory 闲置超时自动压缩 (Idle Compaction) 设计计划 (V3 终版)

## 1. 目标与背景

### 1.1 背景与启发式前提 (Idle Heuristic)
主流 LLM 提供商（如 Anthropic Claude、OpenAI 等）的 Prompt Cache 具有生效生存时间（TTL），通常为 **5 分钟**。
- **连续交互（Idle < TTL）**：保持长历史能持续命中服务端缓存，享受大幅折扣与极低首字延迟；此时截断上下文反而破坏缓存前缀。
- **交互中断（Idle >= TTL）**：用户离开（几分钟至数天），服务端缓存大概率**已经过期（Cold Cache）**。下一回合用户发消息时，不论发送多长的上下文都必须全量重新计费并重新建 Cache。
- **概念澄清**：Pi 宿主并未提供服务端 Prompt Cache 命中状态的实时探针。本扩展中的 `idleCompactionTtl` 属于**本地闲置启发式判定（Idle Heuristic）**，即当本地会话闲置达到该时长后，合理推断缓存优势已失。

当前 `@hheei/pi-ext-memory` 仅依据 Token 体量（默认 81,000 tokens）触发压缩。即使用户闲置了数小时/数天，只要上下文未累积到 81,000 tokens，系统仍会在冷启动时以极高成本全量传输原始上下文。

### 1.2 核心目标与架构原则
- **目标**：在用户闲置超过设定 TTL（默认 30 分钟）且未压缩原始 Token 累积达到起步体量（默认 >= 75,000 tokens）时，**在闲置期由后台定时器调度 Pi 原生 Compaction**，淘汰旧原始上下文，大幅降低冷启动 Token 消耗并加速模型响应。
- **架构决策：闲置定时触发 (Idle Timer) 而非在 `before_agent_start` 中竞态拦截**：
  - 在第 2 轮 Review 中已明确证明：`before_agent_start` 执行时用户已经提交了新 Prompt。在此处调用 `ctx.compact()` 会与 Pi 原生的 `prompt()` 流程产生致命并发冲突。
  - **真正的闲置发生在用户离开期间**：当用户闲置 30 分钟时，系统处于完全空闲状态（`ctx.isIdle() === true`），后台 Consolidation 早已完成，此时执行压缩**既不主动阻塞用户输入，又极大减少并发读写风险**。压缩在后台完成后，用户回来时通常可以直接继续交互；若恰好仍在压缩窗口内，Pi 会按原生契约要求稍后重试。
- **诚实承认 Pi 竞态边界**：
  - Pi 宿主在 `Session.prompt()` 中的行为是：若 Compaction 正在运行（`_compactionAbortController !== undefined`），直接抛出异常提示用户等待完成并重试（`"Cannot submit a prompt while compaction is in progress"`），**Pi 不会自动排队等待**。
  - 架构目标是将触发时机放在静默闲置期，极大降低这一竞态的概率；若用户恰好在压缩执行的极短窗口（通常几百毫秒）内敲下回车，Pi 会提示用户稍等重试，这是 Pi 宿主的原生安全边界。

---

## 2. 架构设计与控制流

### 2.1 整体时序与控制流

```text
[回合完成]
pi: agent_settled
  │
  ├─► 1. 检查即时阈值:
  │      - 若 rawTokensSinceLastCompaction >= compactAfterTokens (81k) -> 走现有即时压缩
  │
  ├─► 2. 检查闲置压缩排程资格:
  │      - 配置启用 (runtime.config.idleCompactionTtlSeconds !== undefined)
  │      - 非被动模式 (!runtime.config.passive)
  │      - 预检未压缩原始 tokens: rawTokensSinceLastCompaction(entries) >= idleCompactionMinTokens (75k)
  │      - 预检去重 (Ledger-derived): 自最近一次 compaction 节点之后必须存在新增 source entry (countSourceEntriesAfterCompaction > 0)
  │      - 预检投影: foldLedger(entries) 包含有效观测或反思 (activeObservations > 0 || reflections > 0)
  │
  └─► 3. 资格成立 -> 清理旧定时器，注册闲置定时器:
         runtime.clearPendingIdleCompactionTimer()
         runtime.pendingIdleCompactionTimer = setTimeout(() => onIdleTimeout(), idleCompactionTtlSeconds * 1000)

─────────────────────────────────────────────────────────────────────────────────
[场景 A: 用户在 30 分钟内返回并继续交互 (Idle < TTL)]
  │
  ├─► 监听 before_agent_start / agent_start / turn_start:
  │   立即调用 runtime.clearPendingIdleCompactionTimer()
  │
  └─► 用户发送新 Prompt -> 定时器被取消，缓存继续保持热度，完全不打扰交互

─────────────────────────────────────────────────────────────────────────────────
[场景 B: 用户闲置超过 30 分钟 (Idle >= TTL)]
  │
  ▼
setTimeout 触发 (onIdleTimeout):
  │
  ├─► 1. 状态与会话检查:
  │      - isActiveSession(runtime, generation, signal) 校验
  │      - ctx.isIdle() 必须为 true (若用户恰好正在输入或操作，立即放弃并清理)
  │      - !runtime.compactInFlight
  │
  ├─► 2. 重新核算 Token、新增条目与投影:
  │      - countSourceEntriesAfterCompaction(entries) > 0
  │      - rawTokensSinceLastCompaction(entries) >= idleCompactionMinTokens
  │      - foldLedger(entries) 依然非空 (若为空则坚决放弃，绝不隐式降级到耗时的 native LLM summarizer)
  │
  ├─► 3. 若 ctx.hasUI，通知用户正在执行闲置记忆整理:
  │      "Observational memory: idle timeout reached (~30m elapsed); compacting cold context in background"
  │
  └─► 4. 调用 ctx.compact({ onComplete, onError }) 静默完成
         (完成后清除定时器状态，后续无新输入前不再重复排程)

─────────────────────────────────────────────────────────────────────────────────
[场景 C: 会话冷恢复 (Cold Resume: 关掉 Pi 隔天重新打开)]
  │
  ▼
session_start (通过 ext-core registerExtensionLifecycle 或 session_start 事件):
  │
  ├─► 检查分支历史，通过 findPersistedSettledTime(entries) 恢复基准时间戳
  ├─► 计算 elapsed = Date.now() - persistedSettledTime
  └─► 若 elapsed >= idleCompactionTtlSeconds 且符合 Token 与投影条件:
      在会话处于 idle 状态并延迟就绪后（如 debounce 5s），调度静默压缩，确保在用户恢复交互前就绪。
```

### 2.2 状态机

```text
    [ACTIVE] (回合交互中)
       │
  (agent_settled)
       │
       ├─► 使用当前分支状态计算闲置资格
       ▼
 [IDLE_ARMED] (满足 75k、有新 source entry、投影非空，启动 30m 定时器)
    /        \
   / (用户在 30m 内输入: before_agent_start 清除定时器)
  ▼                      \ (30m 超时到达且 isIdle)
[ACTIVE]                 ▼
                  [IDLE_COMPACTING] (调用 ctx.compact)
                      /           \
         (onComplete)/             \(onError)
                    ▼               ▼
            [IDLE_COMPACTED]    [IDLE_FAILED]
                    \               /
                     \             / (等待下一次用户输入)
                      ▼           ▼
                      [ACTIVE]
```

---

## 3. 持久化配置契约 (`ext_settings.json`)

配置位于 `~/.pi/agent/ext_settings.json` 或 `<cwd>/.pi/ext_settings.json` 的 `"observational-memory"` 下：

```json
{
  "observational-memory": {
    "idleCompactionTtl": "30m",
    "idleCompactionMinTokens": 75000
  }
}
```

### 3.1 配置项规格与严格归一化规则
- **`idleCompactionTtl`**:
  - 输入类型：`string | number | boolean`
  - 内部归一化字段：`idleCompactionTtlSeconds: number | undefined`（`undefined` 代表禁用）。
  - **禁用语义（Explicitly Disabled）**：
    - `"never"`, `false`, `0`, `""` 均明确解析为 `undefined`（禁用闲置压缩）。
  - **合法值解析**：
    - 支持带单位字符串：`"30m"`, `"5m"`, `"1h"`, `"300s"`, `"1.5h"`, `"1800s"`（大小写不敏感，允许前导/后置空格）。
    - 纯数字（number 或数字字符串）：视为整秒数值（避免 ms 溢位）。
    - 范围限制：必须在 `0 < value <= MAX_TIMEOUT_SECONDS`（`2_147_483` 秒，约 24.8 天）之间。
  - **非法值 Fallback**：
    - 遇到负数、未知单位、`true` 或格式错误时：**忽略并回退到默认值 `"1800s"`（`1800` 秒）**，保证配置健壮性。
  - **默认值**：`"1800s"`。
- **`idleCompactionMinTokens`**:
  - 类型：`number`（正整数）。
  - 含义：触发闲置压缩的最低累积未压缩原始 Token 数。
  - 默认值：`75000`。

---

## 4. 边界不变量与并发安全契约

### 4.1 规避 Prompt 并发读写冲突与竞态说明
- 闲置压缩只在 Pi 处于完全空闲（`ctx.isIdle() === true` 且无 active turn）时启动。
- 若用户恰好在压缩执行的极短窗口内（通常几百毫秒）提交了 Prompt，Pi 宿主内部的 `Session.prompt()` 会抛出 `"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry."`。本设计不伪造异步排队，而是通过提前在闲置期运行来最大程度规避此冲突。

### 4.2 严格的去重与“未归零”问题规避 (Ledger-Derived Progress Semantics)
- **事实认知**：Pi 原生的 `rawTokensSinceLastCompaction(entries)` 在压缩后仍会统计保留的最近 turns（`firstKeptEntryId` 之后的 entries）。若保留部分本身较大，该值在压缩后可能依然 `>= idleCompactionMinTokens`。
- **基于 Ledger 的纯函数去重**：
  - 实现纯函数 `countSourceEntriesAfterCompaction(entries: Entry[]): number`。
  - 查找最近一次 `"compaction"` 条目的索引 `compactionIndex`。
  - 只有在 `compactionIndex` 之后**存在真实用户/模型对话条目（`isSourceEntry`）**时，才允许排程闲置压缩。
  - 压缩完成后，由于在新的 compaction 节点之后尚未产生任何新 message，`countSourceEntriesAfterCompaction(entries)` 立即返回 `0`，从根本上防止循环触发，且 100% 免疫进程重启与 Session 分支切换！

### 4.3 拒绝隐式慢速 Native Summarizer (投影非空前置条件)
- `compaction-hook.ts` 在 `renderSummary()` 为空时会返回 `undefined`，导致 Pi 回退到慢速 native LLM summarizer（可能耗时 10-30 秒且消耗模型配额）。
- **无须 `firstKeptEntryId` 的纯函数预检**：
  - 使用 `foldLedger(entries)` 预检当前分支中累积的有效记忆。
  - 若 `folded.activeObservations.length === 0 && folded.reflections.length === 0`，说明观测池尚无提炼出的反思或观测，**坚决不触发闲置压缩**，杜绝无意调用耗时昂贵的 Native LLM Summarizer。
  - 在目标与验收标准中明确：**“闲置超时 + Token 达标 + 记忆投影非空”** 是触发闲置压缩的三个联合充要条件。

### 4.4 Session 生命周期、独立定时器与断点恢复
1. **独立 Timer Ownership**：
   - 在 `Runtime` 中新增独立的 `pendingIdleCompactionTimer?: ReturnType<typeof setTimeout>` 及 `clearPendingIdleCompactionTimer()`，与现有的即时压缩定时器 `pendingCompactionTimer` 严格解耦，互不干扰。
   - 在 `Runtime.startSession()`、`Runtime.endSession()` 以及 ext-core 的 lifecycle signal `abort` 时，必须调用 `clearPendingIdleCompactionTimer()` 彻底清理。
2. **断点恢复判定 (`findPersistedSettledTime`)**：
   - 冷恢复直接倒序查找最后一条已完成的 assistant message 或 compaction entry；
   - 提取合法 ISO 格式的 `timestamp`，且拒绝任何未来时间戳；缺失或非法时安全返回 `undefined`。

---

## 5. 实施步骤

1. **配置层 (`src/config.ts`)**：
   - 完善 `parseDurationToSeconds`，严格遵守禁用值、单位换算、安全整数与 fallback 规则；
   - 在配置输入与归一化边界支持 `idleCompactionTtl`，内部保留 `idleCompactionTtlSeconds` 与 `idleCompactionMinTokens`；
   - 更新 `DEFAULTS`（默认 `30m` 与 `75000`），更新归一化逻辑并编写单元测试。
2. **运行时层 (`src/runtime.ts`)**：
   - 增加独立定时器 `pendingIdleCompactionTimer?: ReturnType<typeof setTimeout> | undefined`；
   - 增加 `clearPendingIdleCompactionTimer()` 方法；
   - 在 `startSession`、`endSession` 以及 lifecycle signal abort 时清理定时器。
3. **触发逻辑与去重判定 (`src/hooks/compaction-trigger.ts`)**：
   - 实现 `countSourceEntriesAfterCompaction(entries)` 和 `findPersistedSettledTime(entries)`；
   - 编写 `scheduleIdleCompaction(...)`：
     - 校验 `countSourceEntriesAfterCompaction(entries) > 0`；
     - 校验 `foldLedger(entries)` 包含有效观测或反思；
     - 启动定时器 `setTimeout(..., idleCompactionTtlSeconds * 1000)`；
   - 定时器回调中：
     - 校验 `isActiveSession` 与 `ctx.isIdle()`；
     - 再次执行纯函数校验，通过后调用 `ctx.compact({ ... })`；
     - 妥善处理 stale ctx 与异常降级。
   - 注册取消监听：在 `before_agent_start` / `agent_start` / `turn_start` 中调用 `runtime.clearPendingIdleCompactionTimer()`。
4. **单元与集成测试 (`test/`)**：
   - `config.test.ts`：测试所有合法、非法、禁用、单位缩写与默认值解析；
   - `compaction-trigger.test.ts`：使用 `vi.useFakeTimers()`：
     - 测试用户在 30 分钟内输入时定时器被及时取消；
     - 测试闲置满 30 分钟且满足 75k 时在后台安静触发 `ctx.compact`；
     - 测试压缩后无新 source entry 时绝对不重复触发（解决归零误区）；
     - 测试 `foldLedger` 为空时自动放弃，杜绝 native summarizer 慢调用；
     - 测试 session 切换与 lifecycle abort 时定时器立即注销。
5. **文档与规范**：
   - 更新 `packages/pi-ext-memory/docs/configuration.md`；
   - 运行 Biome 检查、Package 测试与构建。

---

## 6. 验收标准

1. **体验与性能**：
   - 用户连续对话期间，保持既有 81,000 tokens 阈值，绝不中断 Prompt Cache。
   - 用户离开满 30 分钟，且未压缩上下文达到 75,000 tokens，且内存提炼有效时，系统在空闲期静默压缩。用户稍后回来发消息时，通常可以直接使用已压缩的紧凑上下文；若压缩仍在进行，遵循 Pi 原生的稍后重试边界。
2. **降低并发风险与保持原生安全边界**：
   - 彻底避免在 `before_agent_start` 中发起带 timeout 的竞态压缩，杜绝与 Pi Agent Loop 的读写冲突。
   - 投影为空时坚决不触发，杜绝隐式调用耗时 native summarizer。
3. **工程质量与去重健壮性**：
   - 压缩后即使保留的 source tokens 依然较大，只要无新增对话条目，绝对不重复排程；
   - 消除所有跨 session 状态泄漏与悬挂定时器；
   - 测试通过率 100%，Biome 0 报错。
