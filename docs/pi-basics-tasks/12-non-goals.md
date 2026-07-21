# 12｜明确不做与越界检查

## 目标

在实现和 review 阶段阻止 scope creep。任何 agent 都必须把本文件当作拒绝条件。

## 禁止改动

- `pi-extcore`：不开发、不修改、不加新能力。
- `pi-loadout`、`pi-ssh`、`pi-inturl`：不整合、不改写、不要求它们注册 provider。
- Pi 安装目录和 Pi core：不 fork、不直接修改 interactive-mode/footer/editor。
- Future command：不同时实现 `continue`、`goal`、`advisor`、`plan`、`btw`、`todo`、`snapcompact`、`loadout`。
- Shared domain：不把未来 domain logic 提前搬进 `pi-basics` shared。
- Global state：不使用跨 session mutable state 保存 settings。
- SDK：不为没有第二个真实使用者的 future feature 建复杂 plugin SDK。

## Review 检查

- 搜索 `packages/pi-basics/src` 和 `test` 的排除依赖 import。
- 检查是否出现未计划的 command、adapter、contribution owner。
- 检查 registry 是否保存 domain state。
- 检查新增 helper 是否已有仓库/Pi 等价物。
- 检查文档是否把预留 API 写成已实现功能。

## 处理方式

发现越界时优先删除越界代码；如果确实是第一版必需能力，更新对应 contract、测试和本任务的范围说明，不以隐式副作用保留。
