# Advisor 调度策略改进计划

状态：部分实现。Phase 1 和 Phase 2 的 material signature 已实现；Phase 3 及之后未实现。

当前行为仍以 `packages/pi-advisor/src/`、测试和 `packages/pi-advisor/README.md` 为准。本文件记录后续调度改进的范围、取舍和验收条件。

## 1. 背景

HEPI Advisor 当前已经具备以下能力：

- 每个 primary turn 生成 review delta。
- Advisor runtime 串行 review，并支持 review completion flush。
- `concern` / `blocker` 首次出现时立即打印到 UI，但不立即 steer 主模型。
- 高严重度 advice 在下一次 review 中 reconfirm；沉默表示问题已解决。
- terminal turn 支持 catch-up。
- review timeout 不依赖 provider 是否响应 abort。
- delivered advice 按 normalized note 去重，并支持 severity escalation。
- Advisor context 支持 fitting、自压缩、tool pair 和 text-only image 过滤。

当前主要问题：

1. review 频率仍然偏高，容易让 primary model 持续修改。
2. 时间 cooldown 不能阻止相同 evidence 重复触发 provider review。
3. cooldown 期间可能累积过多重复 delta。
4. provider rate limit 或连续失败时，需要更明确的 backoff。
5. review scheduler 的 admission、single-flight 和 pending evidence 需要成为显式契约。

研究参考：

- [pasky/pi-omplike-advisor](https://github.com/pasky/pi-omplike-advisor/tree/43eb9a976d751c06016a62b5423e2c6ddaff43a1)：turn queue、severity reconfirm、terminal catch-up、stale callback 防护。
- [gabelul/bpx-consult](https://github.com/gabelul/bpx-mono/tree/64567efe1177739b2eb110a746fff7c736c9468b/packages/bpx-consult)：stuck trigger、onDone、per-turn budget、auto-running guard。
- [fiale-plus/pi-rogue](https://github.com/fiale-plus/pi-rogue/tree/ca4f3e1874ad4248a7c1e64e087c58815167fab8/packages/advisor)：material signature、review lock、rate-limit backoff、deadline 和 restart recovery。
- [juicesharp/rpiv-advisor](https://github.com/juicesharp/rpiv-mono/tree/22eb3aa3eefb612e63e8253e90c9355a477ba606/packages/rpiv-advisor)：显式 model-driven Advisor；本计划不采用其显式手动调用路线。

## 2. 已确定的设计决策

### 2.1 不加入显式手动 Advisor

不注册 model-facing `advisor()` tool，也不新增 `/advisor ask` 或 `/advisor review`。

保留：

- `/advisor on`
- `/advisor off`
- `/advisor status`

这些命令只控制 Advisor 生命周期和查看状态，不主动发起一次 review。测试用的 hidden hook 不属于用户功能，可以保留。

### 2.2 采用 omplike 的时序模型

保留以下语义：

- primary turn evidence 进入 Advisor queue。
- Advisor review 串行执行。
- `nit` 可以低延迟显示。
- `concern` / `blocker` 先显示在 UI，再等待 reconfirm 后 steer。
- terminal turn 等待最后一次 review。
- held advice 在下一次 review 中重新确认；沉默即删除。
- reset、off、tree change 后，旧 review callback 不能污染新 runtime。

### 2.3 已实施时间限制

基础 review 间隔从 20 秒改为 15 秒：

- 普通 review：至少 15 秒。
- concern：提出后至少 25 秒。
- blocker：提出后至少 40 秒。

定义：

```text
allowedAt = max(
  lastReviewAt + 15s,
  severityCooldownUntil,
  providerBackoffUntil,
)
```

`concern` 和 `blocker` 的 UI 打印不等待 cooldown；cooldown 只限制下一次 provider review。cooldown 期间仍然收集 evidence，到时间后合并 review。

## 3. 目标调度流程

```text
primary turn ends
        |
        v
collect material evidence
        |
        v
update pending evidence and held advice
        |
        v
review already running?
  yes -> merge pending evidence, do not start another provider call
  no
        |
        v
allowedAt reached?
  no -> queue only
  yes
        |
        v
same material signature?
  yes -> skip provider review
  no
        |
        v
run one Advisor review
        |
        +--> nit: normal boundary delivery
        |
        +--> concern: immediate UI + 25s cooldown
        |
        +--> blocker: immediate UI + 40s cooldown
        |
        v
terminal boundary?
  yes -> reconfirm before primary becomes idle
  no  -> continue primary
```

目标 scheduler 状态：

```ts
interface ReviewScheduleState {
  readonly lastReviewAt?: number;
  readonly severityCooldownUntil: number;
  readonly providerBackoffUntil: number;
  readonly lastMaterialSignature?: string;
  readonly reviewInFlight: boolean;
}
```

状态仍然 session-scoped，不做跨 session 持久化。`lastMaterialSignature` 只对当前 Advisor runtime 有效；reset、off、tree change 必须清理。

## 4. 按复杂度分阶段实施

### Phase 1：调整基础节流

状态：已实现。

复杂度：低。风险：低。

#### Feature 1：基础间隔改为 15 秒

痛点：Advisor 读取新信息过于频繁，primary model 容易进入“修改后立刻再次 review，再次修改”的循环。

实现范围：

- 修改基础 interval 常量。
- review 完成后记录 `lastReviewAt`。
- 新 delta 在 `allowedAt` 前只进入 pending queue。
- 到期时一次性启动 review。

验收：

- 15 秒内不调用 provider。
- 15 秒后只启动一次 review。
- cooldown 期间的多个 turn 不产生多个 provider 请求。
- UI health marker 和首次 advice 打印不受 cooldown 影响。

#### Feature 2：更新 README、prompt 和测试说明

痛点：用户看不到 Advisor 为什么暂时不响应，也容易把 cooldown 误认为故障。

文档必须说明：

- 15 秒基础 review 间隔。
- concern 25 秒 cooldown。
- blocker 40 秒 cooldown。
- high severity 会立即显示，但不会立即 steer。
- 不存在显式 `advisor()` 调用。

### Phase 2：Material evidence 去重

状态：已实现 material signature 和 cooldown 内最新 pending prompt；single-flight 的独立 admission lock 尚未实现。

复杂度：中。风险：低到中。

#### Feature 3：material signature

状态：已实现。

痛点：只增加时间 cooldown 仍可能对相同内容重复调用 provider。

signature 至少包含：

- 当前 primary task/user prompt 标识。
- 最近有效 primary delta。
- 是否有新 edit diff。
- 是否有 tool error 或测试失败。
- 是否有新的 material concern/blocker signal。
- 当前 session/branch epoch。

相同 signature 的 review 直接跳过，但以下情况必须绕过 dedup：

- 新 blocker signal。
- 新 tool error。
- 新文件 diff。
- 新 user prompt。
- session reset、tree change 或 branch switch。

验收：

- 相同 evidence 不产生第二次 provider 请求。
- 新 edit diff 即使 prompt 相同，也能触发 review。
- 新 blocker/error 不会被旧 signature 吞掉。
- reset/off/tree change 后旧 signature 不影响新 runtime。

### Phase 3：Pending evidence 合并和 single-flight

复杂度：中。风险：中。

#### Feature 4：显式 single-flight review lock

痛点：`turn_end`、terminal catch-up 和 review completion 可能在异步边界交错，未来新增入口容易重复启动 review。

规则：

- 一个 Advisor runtime 同时最多一个 provider review。
- review 进行中到达的新 delta 只追加到 pending evidence。
- 不允许第二个 provider request 并行运行。
- 当前 review 完成后，由统一 scheduler 再判断 cooldown 和 signature。

现有 runtime 的串行 drain 保留；本 feature 把 admission lock 和 runtime busy 状态分开，避免调用方绕过统一入口。

验收：

- 并发 `turn_end` 只产生一个 provider request。
- reset/off 期间的 late callback 不会释放新 runtime 的 lock。
- provider failure 后 lock 必须在 `finally` 释放。

#### Feature 5：latest-wins pending evidence

痛点：25/40 秒 cooldown 期间可能积累大量重复 delta，把已经修复的中间状态重新交给 Advisor。

保留：

- 最近 primary delta。
- 最近有效 edit diff。
- 最近 tool/test failure。
- held concern/blocker。
- 从上一次 review 开始出现的 material signal。

丢弃：

- 与现有 evidence 相同的重复 turn。
- 已被更新状态覆盖的旧普通 delta。

不能只保留最后一条消息；edit diff、error、测试失败等高价值 evidence 必须保留。

验收：

- cooldown 后 review context 不包含无界重复 turn。
- 中间普通修改被后续状态覆盖时，不重复发送所有中间状态。
- held blocker 始终保留，直到 reconfirm 或 reset。

### Phase 4：Provider failure backoff

复杂度：中。风险：中。

#### Feature 6：区分业务 cooldown 和 provider backoff

痛点：正常 severity cooldown 与 provider 故障是两种不同状态，混用会造成错误重试和错误 UI 状态。

独立维护：

```text
severityCooldownUntil
providerBackoffUntil
```

最终允许时间：

```text
allowedAt = max(
  lastReviewAt + 15s,
  severityCooldownUntil,
  providerBackoffUntil,
)
```

#### Feature 7：失败指数退避

适用错误：

- rate limit
- timeout
- network error
- auth/config error
- malformed provider response

建议退避：

```text
15s -> 30s -> 60s -> 120s
```

规则：

- backoff 期间不重复调用 provider。
- pending evidence 和 held advice 保留。
- review failure 不得被解释为“无问题”。
- 成功 review 清除 provider backoff。
- health marker 进入错误/未知状态，而不是蓝色 clean。

已有的 provider timeout、failure health 和 cleanup 逻辑应复用，不新增第二套错误状态机。

验收：

- rate limit 不会 busy-loop。
- 失败期间的新 evidence 不丢失。
- 成功后 backoff 清零。
- reset/off/tree change 清理 backoff。

### Phase 5：Terminal protocol 回归强化

复杂度：中到高。风险：中。

这部分主要是审计和补测试，不重新设计已有 omplike 风格。

#### Feature 8：terminal review 只交付 confirmed high advice

成功 terminal review：

- Advisor 再次提出的 concern/blocker 才 steer。
- Advisor 沉默的旧 advice 删除。
- nit 按 terminal policy 处理。

terminal timeout/failure：

- concern/blocker 可以 best-effort 显示或交付。
- 不标记为 confirmed。
- nit 继续 pending。

痛点：最后一次 primary 修改可能已经解决旧问题，不能盲目 steer 旧 advice；但也不能让最后一次 blocker 无声丢失。

#### Feature 9：review completion flush 回归

验证 `onSettled` 在以下情况下都正确：

- review 在 `turn_end` 等待期间完成。
- review 在等待 timeout 后完成。
- review completion 与 reset/off 交错。
- terminal 和 non-terminal boundary policy 不混用。

痛点：避免出现 header 已变红/黄，但 UI 信息区没有对应 advice 的状态分裂。

### Phase 6：可选 admission gate，暂缓

复杂度：高。风险：高。

暂不引入 pi-rogue 的 binary gate、机器分类器、复杂 check-in orchestration 或跨 session 持久化 scheduler 状态。

未来若真实 session telemetry 证明 provider 调用仍过多，再评估确定性 material gate：

- 新 user prompt。
- 新 edit diff。
- tool error。
- test failure。
- changed plan。
- held high advice。
- terminal boundary。

安全相关、失败相关和 blocker reconfirm 必须绕过 gate。

暂缓原因：binary gate 可能产生 false negative；Advisor 漏掉 security/data-loss/blocker 问题的代价高于多调用一次 provider。

## 5. 非目标

本计划不包含：

- 显式 `advisor()` model-facing tool。
- `/advisor ask` 或 `/advisor review`。
- council、debate 或多 Advisor fan-out。
- 跨 session 持久化 scheduler state。
- 自动修改文件。
- 改变 Advisor 的 read-only 权限。
- 修改 primary model 的工具调度。
- 新增独立 timer daemon。
- 立即引入 binary gate 或训练型 classifier。

## 6. 预期修改范围

主要文件：

```text
packages/pi-advisor/src/feature.ts
packages/pi-advisor/src/runtime.ts
packages/pi-advisor/src/context.ts
packages/pi-advisor/src/prompt.ts
packages/pi-advisor/README.md
packages/pi-advisor/test/modules/advisor/feature.test.ts
packages/pi-advisor/test/modules/advisor/runtime.test.ts
packages/pi-advisor/test/modules/advisor/context.test.ts
```

只有在现有模块无法表达 scheduler 状态时，才新增小型纯函数模块。优先复用现有 queue、epoch、runtime cleanup、fake clock 和 test harness。

## 7. 总体验收标准

功能：

- 无显式手动 Advisor tool 或 review command。
- 普通新 evidence 最快每 15 秒 review 一次。
- concern cooldown 为 25 秒。
- blocker cooldown 为 40 秒。
- 同一 material signature 不重复调用 provider。
- 同一 runtime 不存在并发 provider review。
- cooldown 期间 evidence 合并且高价值 signal 不丢失。
- provider failure 使用 backoff，不 busy-loop。
- concern/blocker 首次出现仍立即打印 UI。
- steer 只使用 confirmed 或 terminal best-effort policy 允许的 advice。
- reset/off/tree change 后不接受旧 callback。

测试：

- focused Advisor tests 全部通过。
- 15/25/40 秒 fake-clock 测试通过。
- material signature、single-flight、latest-wins、backoff 有回归测试。
- terminal completion/failure/reset 交错场景有回归测试。
- typecheck、Biome、`git diff --check` 通过。
- live provider smoke 仍作为手动实验，不进入常规 CI。

验证命令：

```bash
bun test packages/pi-advisor/test
bun run typecheck
bunx biome check packages/pi-advisor/src packages/pi-advisor/test
bun run check
```

`bun run check` 若仍出现已知的 `packages/hepi-mono` package-boundary failures，应单独记录，不把它们归因于 Advisor 调度改动。
