# Pi Loadout 架构设计

## 1. 目标与定位

`@hheei/pi-loadout`（位于 `packages/pi-loadout/`）是一个独立的 Pi Extension，专职负责为交互会话提供原生的资源装配可视化界面（`/ext-loadout`）。

### 与 `/ext-settings` 的职责分离
- **`/ext-settings`**：负责各功能扩展的运行时参数配置（如 optimizer 压缩比、memory 阈值等），配置写入 `ext_settings.json`，保持全局单层、轻量直接，不引入作用域切换心智负担。
- **`/ext-loadout`**：专职负责 Pi 原生**资源类配置**（Skills, Extensions, Prompts, Themes, Packages, DefaultTools），直接读写 Pi 原生 `settings.json`，原生支持 **Global (User: `~/.pi/agent/settings.json`)** 与 **Project (Local: `<cwd>/.pi/settings.json`)** 双层作用域切换与覆盖继承。

---

## 2. 核心架构与数据流

```
+-------------------------------------------------------------+
|                      User in Pi Session                     |
|                   runs /ext-loadout                         |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
|             openTuiSurface (@hheei/pi-ext-core)             |
|                  Mount Loadout TUI Surface                  |
+-------------------------------------------------------------+
                              |
              +---------------+---------------+
              |                               |
              v                               v
    DefaultPackageManager            SettingsManager (Pi)
   (Discovers all resources:        (Reads & Writes real
    skills, exts, prompts, etc.)      settings.json files)
              |                               |
              +---------------+---------------+
                              |
                              v
+-------------------------------------------------------------+
|                        LoadoutView                          |
|  - Rail / Title + Scope Bar ([Tab] Global <-> Project)      |
|  - Search Row                                               |
|  - Left Pane: Category Headings + Resource Rows + Rail      |
|  - Right Pane: Status Facts, Path, Description              |
|  - Hint Row / Rail                                          |
+-------------------------------------------------------------+
                              |
        User toggles with Space / cycles overrides
                              |
                              v
    Writes directly to SettingsManager (global or project)
                              |
                     User closes with Esc
                              |
                              v
+-------------------------------------------------------------+
|             await settingsManager.flush()                   |
|       Notify: "Loadout updated. Run /reload to apply."      |
+-------------------------------------------------------------+
                              |
                     User runs /reload
                              |
                              v
       Native Pi host reloads all resources cleanly!
```

---

## 3. 作用域与继承状态机

### 3.1 作用域切换
- 默认进入当前会话的可信作用域（若项目受信任，默认可查看/编辑项目；按 `Tab` 随时在 `Global` 与 `Project` 间切换）。

### 3.2 状态解析与视觉语义

列表行只用 Nerd Font 字形表达状态，颜色是辅助而非唯一信号（`DESIGN.md` 的「NEVER communicate selection or status by color alone」）：

| 字形 | 含义 |
| --- | --- |
| `󰄴` | 启用 |
| `󰄰` | 停用 |
| `󰐙` | 项目显式启用（`+pattern`） |
| `󰍷` | 项目显式停用（`-pattern`） |

1. **Global 视口**：行内字形报告**全局层自身**的值，与项目覆盖无关。按 `Space` / `Enter` 在启用与停用之间切换。

2. **Project 视口**：行内字形报告**项目决定**；无覆盖时显示继承结果。按 `Space` / `Enter` 循环：
   - 若全局为启用：`继承` -> `显式停用` -> `显式启用` -> `继承`
   - 若全局为禁用：`继承` -> `显式启用` -> `显式停用` -> `继承`

3. **详情面板**分别报告 `Global`、`Project`、`Effective` 三个事实。`Global` 行始终画全局层自身的值，因此一个项目覆盖不会让全局值看起来被改写；`Effective` 由 `globalEnabled` 与项目覆盖推导，而不是第二次独立解析，否则未受信任的项目会解析回全局层，使面板自相矛盾。

4. **作用域标记**本身在 `Global` 与 `Project` 之间移动（`● Global  ○ Project` / `○ Global  ● Project`），切换写入目标不依赖 accent 颜色。

5. **同名资源**（例如用户目录与项目目录各有一个 `research` skill）以来源目录限定名称，否则两行完全相同，用户无法知道自己将要停用哪一个。

---

## 4. 与 Pi 宿主规范的绝对对齐

- **零影子 Schema**：完全摒弃旧版 Loadout 将状态写在 `ext_settings.json` 自创结构的弊端，所有变更 100% 写入 Pi 宿主 `settings.json`。
- **零 Prompt 篡改**：绝不通过向系统提示词注入废弃技能名单来做假拦截。修改完全依赖 Pi 原生资源加载器在 `/reload` 后的原生过滤。
- **纯正生态兼容**：完美支持 `+path`、`-path` 以及 Package 级资源指定规则。
