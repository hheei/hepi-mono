# 04｜公开 API、Settings contract 与 storage

## 目标

建立不依赖 `@hheei/pi-extcore` 的自有 public API。API 是未来 module/extension 的稳定边界；registration 不得直接创建 UI。

## 最小 contract

至少定义并导出：

- `HePiModule`：`id`、`label`、可选 `icon`、`commands`、`open(args, ctx)`。
- `HePiSettingsProvider`：`id`、`title`、可选 description、groups、可选 panels、storage、`onLoad`、`onChange`、`onClose`。
- `HePiSettingGroup`、`HePiSettingField`：稳定 id、label、default、description、类型/格式、options、parse/validate 等必要字段。
- `HePiSettingsState`、`HePiSettingChange`、`HePiContext`、`HePiCommandContext`。
- `HePiSettingsStorage` 及 global JSON、project JSON、session-backed 三种 adapter contract。
- panel contract：`render(width) -> string[]`、`handleInput()`、`invalidate()`；只定义第一版真正会用到的能力。

字段类型必须能表达 boolean、enum/options、text、number、path；`parse` 是唯一从 draft string 转换到 typed value 的入口。

## 实现步骤

1. 先检查 Pi/仓库已有 storage 和 context 类型，复用底层能力但不要 re-export `pi-extcore` 类型。
2. 明确 state 合并优先级：storage value、field default、provider snapshot 的来源和缺失字段处理；不得静默丢失 provider 不认识的数据，除非 contract 明确允许。
3. 定义 global/project/session adapter 的读写、错误和生命周期语义；adapter 不拥有 UI state。
4. 实现 `registerHePiModule()`、`registerHePiSettings()`，对 module/provider id 做 collision 检查；重复注册必须报错或按文档规定 deterministic replace，绝不静默覆盖。
5. 通过 `src/api/index.ts` 导出 named exports；internal registry 和实现细节不作为 public API。
6. 写 API tests：注册、排序、collision、空 provider 过滤、跨 context state 隔离、storage error 传播。
7. 在 README 放一个最小 provider 示例，示例只依赖 public exports。

## 关键约束

- registry 可以作为加载桥接，但 provider state 必须绑定当前 Pi session/context。
- provider 不能 import Settings component。
- public API 不得 import `pi-extcore`、`pi-loadout`、`pi-ssh`、`pi-inturl`。
- 不为尚未有第二个实现者的 future feature 建复杂 SDK。

## 验收

- [ ] 其他 module 能只从 `src/api/index.ts` 使用 registration API。
- [ ] 重复 id 给出稳定、可断言的错误。
- [ ] storage adapter 可被 fake storage 替换，测试不依赖 HOME 或真实项目文件。
- [ ] `onLoad`、`onChange`、`onClose` 的参数和调用时机有测试或明确交给 controller task。
- [ ] 编译时不存在隐含 `any` 和旧 package 类型泄漏。
